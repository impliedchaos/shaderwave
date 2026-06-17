// Orchestrates the GPU audio graph for one render block:
//
//   for each instrument:  synth pass → audioTex[i] (BLOCK×VOICES) + state carry (MRT)
//   mix pass:             sum all audioTex rows → stereo mixTex (BLOCK×1)
//   readback:             readPixels(mixTex) → interleaved Float32Array(BLOCK*2)
//
// State textures ping-pong per instrument so recursive filters carry across
// blocks. A voice belongs to exactly one instrument (uInst[v]); each program
// renders only its own rows and writes silence elsewhere.
import { createProgram, drawQuad, makeTex } from './program.js';
import type { GLProgram } from './program.js';
import { EffectsChain, normalizeFxOrder } from './effects.js';
import { BLOCK, VOICES } from '../constants.js';
import { REGISTRY } from '../instruments/index.js';
import { bakeWavetableAtlas, WT_SAMPLES } from '../instruments/wavetables.js';
import { analyzeHarmonicSpectrum } from '../instruments/additive-analysis.js';
import type { FxParams, FxParamsByType, InstrumentDef, InstrumentType, VoiceData } from '../types.js';
import COMMON from './shaders/common.glsl?raw';
import MIX_FS from './shaders/mix.glsl?raw';
import ADDITIVE_REDUCE_FS from './shaders/additive-reduce.glsl?raw';

// Spectra (additive engine) tiling. ADD_TILE partials are summed per fragment; the
// synth pass renders ADD_TILES (= ADD_MAXN/ADD_TILE) tile-rows per voice into a
// BLOCK × (ADD_TILES·VOICES) texture, then a log-reduce sums the tiles down to
// BLOCK×VOICES. MUST match TILE_SZ / ADD_MAXN in synth-additive.glsl.
const ADD_TILE = 32;
const ADD_MAXN = 2048;
const ADD_TILES = ADD_MAXN / ADD_TILE;     // 64 → 6 log-reduce passes
// Resynthesis (Phase 2): analyzed harmonic profiles live in a spectral atlas, one row
// per Spectra instance. ADD_SPECTRA_K MUST match the shader; bound to texture unit 5.
const ADD_SPECTRA_K = 512;
const ADD_SPECTRA_SLOTS = 16;
const ADD_SPECTRA_UNIT = 5;

// Height of the sidechain dry bus (instDryTex): instances 0..INST_DRY_ROWS-1 are
// available as compressor key sources (compSource). Instances beyond this still
// render — they just can't be keyed off. The UI's compSource max is INST_DRY_ROWS-1.
const INST_DRY_ROWS = 16;

export const SMP_ATLAS_W = 4096;          // MUST match SMP_W in synth-sampler.glsl
export const SMP_ATLAS_H = 4096;
export const SMP_MAX_SLOTS = 16;

// One instrument's GPU resources: its synth program + audio/state textures. `def`
// is the registry descriptor — the source of its shader, recursion flag, and any
// engine-specific uniforms. Effects are NOT per-instrument here: the chain runs
// PER CHANNEL (see SynthRenderer.chanFx), so a voice routes through its own insert.
interface InstRender {
  name: InstrumentType;
  id: number;
  def: InstrumentDef;
  prog: GLProgram;
  audio: WebGLTexture;
  stateRead: WebGLTexture;
  stateWrite: WebGLTexture;
  phaseRead: WebGLTexture;
  phaseWrite: WebGLTexture;
  phase2Read: WebGLTexture;
  phase2Write: WebGLTexture;
  fbo: WebGLFramebuffer | null;
  // Additive (Spectra) only: the log-reduce program + the tile texture the synth pass
  // writes + two ping-pong scratch textures the reduction halves through.
  reduceProg?: GLProgram;
  addPartials?: WebGLTexture;
  addA?: WebGLTexture;
  addB?: WebGLTexture;
}

export class SynthRenderer {
  gl: WebGL2RenderingContext;
  sampleRate: number;
  subBlock: number;
  inst: InstRender[];
  instFx: EffectsChain[];               // lazily-built effects chain per instrument INSTANCE
  instFxParams: FxParams[];             // per-instance fx params (set by the app)
  instFxOrder: string[][];              // per-instance effect-chain order (normalized)
  chanDryTex: WebGLTexture;
  chanDryFbo: WebGLFramebuffer | null;
  instDryTex: WebGLTexture;             // sidechain dry bus (BLOCK × INST_DRY_ROWS)
  instDryFbo: WebGLFramebuffer | null;
  _maskGain: Float32Array;              // scratch: mix gains masked to one instance's voices
  mixProg: GLProgram;
  mixTex: WebGLTexture;
  mixFbo: WebGLFramebuffer | null;
  readBuf: Float32Array;
  outBuf: Float32Array;
  wavetableTex: WebGLTexture;   // shared Wavewright wavetable atlas (bound to unit 3)
  samplerTex: WebGLTexture;     // shared sampler PCM atlas (bound to unit 4)
  addSpectraTex: WebGLTexture;  // Spectra resynthesis: analyzed harmonic profiles (unit 5), 1 row per instance
  _addSlotByInstIdx: Int32Array;// instrument-instance index → spectral atlas row (-1 = no analyzed sample)
  _addAnalysisCache: WeakMap<Float32Array, Float32Array>;  // PCM → harmonic amps (analyze once per sample)
  _addSlotScratch: Float32Array;// per-voice spectral row, uploaded as uAddSlot each additive block
  _smpSlotByInstIdx: Int32Array;
  _smpBaseRow: Float32Array;
  _smpLen: Float32Array;
  _smpRootFreq: Float32Array;
  _smpLoopStart: Float32Array;
  _smpLoopEnd: Float32Array;
  _smpLoopMode: Float32Array;
  _smpPcmRef: (Float32Array | null)[];
  // Async readback state (used only by the realtime producer via renderBlockAsync):
  // two pixel-pack buffers, ping-ponged so we map block N-1's result while block N's
  // readback DMA is still in flight — removing the synchronous readPixels main-thread
  // stall. Lazily allocated on first async use; null means "sync-only so far".
  _pbo: WebGLBuffer[] | null;
  _pboFence: (WebGLSync | null)[];
  _pboIdx: number;

  constructor(gl: WebGL2RenderingContext, sampleRate: number, _fxParams?: FxParamsByType | null) {
    this.gl = gl;
    this.sampleRate = sampleRate;
    // Strip width for the recursive ladder (303/Moog). Smaller = fewer filter
    // recomputes but more draw calls; BLOCK = the old single-pass behaviour.
    this.subBlock = 64;

    this.inst = REGISTRY.map((def, id) => {
      const name = def.type;
      const prog = createProgram(gl, COMMON + def.shader);
      return {
        name, id, def, prog,
        audio: makeTex(gl, BLOCK, VOICES),
        stateRead: makeTex(gl, BLOCK, VOICES),
        stateWrite: makeTex(gl, BLOCK, VOICES),
        phaseRead: makeTex(gl, BLOCK, VOICES),
        phaseWrite: makeTex(gl, BLOCK, VOICES),
        phase2Read: makeTex(gl, BLOCK, VOICES),
        phase2Write: makeTex(gl, BLOCK, VOICES),
        fbo: gl.createFramebuffer(),
      };
    });

    // Per-CHANNEL effect chains (channel == voice). Each voice routes through its
    // own insert chain with its own reverb/delay state — the params for each are
    // sourced per block from the per-engine-type fxParams of whatever instrument
    // that channel is playing (so existing songs keep their fx data; the difference
    // is each channel now gets a SEPARATE chain instead of one shared per type).
    // Per-INSTRUMENT effect chains are built lazily (keyed by instance index) as the
    // app supplies per-instance fx via setInstrumentFx. One reusable dry-mix target.
    this.instFx = [];
    this.instFxParams = [];
    this.instFxOrder = [];
    this.chanDryTex = makeTex(gl, BLOCK, 1);
    this.chanDryFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chanDryFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.chanDryTex, 0);
    this.instDryTex = makeTex(gl, BLOCK, INST_DRY_ROWS);
    this.instDryFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.instDryFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.instDryTex, 0);
    this._maskGain = new Float32Array(VOICES);

    this.mixProg = createProgram(gl, MIX_FS);
    
    // Master combined mix output
    this.mixTex = makeTex(gl, BLOCK, 1);
    this.mixFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mixTex, 0);

    this.readBuf = new Float32Array(BLOCK * 4);     // RGBA readback
    this.outBuf = new Float32Array(BLOCK * 2);      // interleaved stereo result
    this._pbo = null;
    this._pboFence = [null, null];
    this._pboIdx = 0;

    this._smpSlotByInstIdx = new Int32Array(0);
    this._smpBaseRow = new Float32Array(SMP_MAX_SLOTS);
    this._smpLen = new Float32Array(SMP_MAX_SLOTS);
    this._smpRootFreq = new Float32Array(SMP_MAX_SLOTS);
    this._smpLoopStart = new Float32Array(SMP_MAX_SLOTS);
    this._smpLoopEnd = new Float32Array(SMP_MAX_SLOTS);
    this._smpLoopMode = new Float32Array(SMP_MAX_SLOTS);
    this._smpPcmRef = new Array(SMP_MAX_SLOTS).fill(null);

    this._addSlotByInstIdx = new Int32Array(0);
    this._addAnalysisCache = new WeakMap();
    this._addSlotScratch = new Float32Array(VOICES);

    // Spectra resynthesis atlas: R32F, ADD_SPECTRA_K harmonics wide × ADD_SPECTRA_SLOTS
    // rows (one analyzed instance per row). Bound permanently to unit 5.
    this.addSpectraTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + ADD_SPECTRA_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.addSpectraTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, ADD_SPECTRA_K, ADD_SPECTRA_SLOTS, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);

    // Sampler atlas initialization
    this.samplerTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.samplerTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, SMP_ATLAS_W, SMP_ATLAS_H, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);

    // Wavewright wavetable atlas: one R32F texture (width = samples, height =
    // mips × banks × frames) holding every band-limited frame, sampled by the wvt
    // shader via texelFetch. Built once (the bake is the ~1 s mip synthesis),
    // bound permanently to texture unit 3 (the synth pass only ever rebinds units
    // 0–2), and shared by every wvt instance.
    this.wavetableTex = gl.createTexture()!;
    {
      const atlas = bakeWavetableAtlas();
      const rows = atlas.mips * atlas.rowsPerMip;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.wavetableTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, WT_SAMPLES, rows, 0, gl.RED, gl.FLOAT, atlas.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
    }

    // Tell each synth program its uPrevState sampler lives on texture unit 0,
    // and uPrevPhase/uPrevPhase2 on units 1 and 2; uWavetable on unit 3 (only the
    // wvt shader references it — for the rest u() is null → a no-op).
    for (const it of this.inst) {
      gl.useProgram(it.prog);
      gl.uniform1i(it.prog.u('uPrevState'), 0);
      gl.uniform1i(it.prog.u('uPrevPhase'), 1);
      gl.uniform1i(it.prog.u('uPrevPhase2'), 2);
      gl.uniform1i(it.prog.u('uWavetable'), 3);
      gl.uniform1i(it.prog.u('uSamplePcm'), 4);
    }
    
    // Tell mixProg its uInstTex sampler lives on texture unit 0.
    gl.useProgram(this.mixProg);
    gl.uniform1i(this.mixProg.u('uInstTex'), 0);

    // Additive (Spectra) engines are multi-pass: build the shared log-reduce program
    // and each one's tile + ping-pong textures. The synth pass writes `addPartials`
    // (BLOCK × ADD_TILES·VOICES); the reducer halves the tile axis through addA/addB,
    // the final pass landing in `it.audio` (BLOCK×VOICES) like every other engine.
    for (const it of this.inst) {
      if (!it.def.additive) continue;
      gl.useProgram(it.prog);
      gl.uniform1i(it.prog.u('uSpectra'), ADD_SPECTRA_UNIT);   // resynthesis atlas sampler
      it.reduceProg = createProgram(gl, ADDITIVE_REDUCE_FS);
      gl.useProgram(it.reduceProg);
      gl.uniform1i(it.reduceProg.u('uSrc'), 0);
      it.addPartials = makeTex(gl, BLOCK, ADD_TILES * VOICES);
      it.addA = makeTex(gl, BLOCK, (ADD_TILES / 2) * VOICES);
      it.addB = makeTex(gl, BLOCK, (ADD_TILES / 2) * VOICES);
    }
  }

  syncSamplerSlots(instruments: import('../types.js').InstrumentInstance[]) {
    const gl = this.gl;
    if (this._smpSlotByInstIdx.length !== instruments.length) {
      this._smpSlotByInstIdx = new Int32Array(instruments.length).fill(-1);
    } else {
      this._smpSlotByInstIdx.fill(-1);
    }
    let slot = 0;
    let currentRow = 0;
    
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.samplerTex);
    
    for (let i = 0; i < instruments.length; i++) {
      const inst = instruments[i];
      if (inst && inst.type === 'sampler' && inst.sample && slot < SMP_MAX_SLOTS) {
        this._smpSlotByInstIdx[i] = slot;
        const s = inst.sample;
        const len = s.pcm.length;
        
        this._smpBaseRow[slot] = currentRow;
        this._smpLen[slot] = len;
        this._smpRootFreq[slot] = 440.0 * Math.pow(2, (s.rootNote - 69) / 12);
        this._smpLoopStart[slot] = s.loopStart;
        this._smpLoopEnd[slot] = s.loopEnd;
        this._smpLoopMode[slot] = s.loopMode;
        
        // Upload if changed
        if (this._smpPcmRef[slot] !== s.pcm) {
          this._smpPcmRef[slot] = s.pcm;
          const rowsNeeded = Math.ceil(len / SMP_ATLAS_W);
          if (currentRow + rowsNeeded <= SMP_ATLAS_H) {
            // pad the last row if necessary to make a full rectangle
            let uploadData = s.pcm;
            const paddedLen = rowsNeeded * SMP_ATLAS_W;
            if (len < paddedLen) {
              uploadData = new Float32Array(paddedLen);
              uploadData.set(s.pcm);
            }
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, currentRow, SMP_ATLAS_W, rowsNeeded, gl.RED, gl.FLOAT, uploadData);
          } else {
            console.warn("Sampler atlas out of space");
          }
        }
        
        currentRow += Math.ceil(len / SMP_ATLAS_W);
        slot++;
      }
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  // Spectra resynthesis: analyze each additive instance that carries a hydrated sample
  // into a harmonic amplitude profile and pack it into the spectral atlas (one row per
  // instance). Analysis is cached by PCM reference, so this is cheap to call on every
  // instrument/fx change (alongside syncSamplerSlots). Instances without a sample, or
  // beyond ADD_SPECTRA_SLOTS, get slot -1 → Morph has nothing to fade into (formula only).
  syncAdditiveSpectra(instruments: import('../types.js').InstrumentInstance[]) {
    const gl = this.gl;
    if (this._addSlotByInstIdx.length !== instruments.length) {
      this._addSlotByInstIdx = new Int32Array(instruments.length).fill(-1);
    } else {
      this._addSlotByInstIdx.fill(-1);
    }
    let slot = 0;
    gl.activeTexture(gl.TEXTURE0 + ADD_SPECTRA_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.addSpectraTex);
    for (let i = 0; i < instruments.length; i++) {
      const inst = instruments[i];
      if (!inst || inst.type !== 'additive' || !inst.sample || inst.sample.pcm.length === 0) continue;
      if (slot >= ADD_SPECTRA_SLOTS) break;
      const pcm = inst.sample.pcm as Float32Array;
      let amps = this._addAnalysisCache.get(pcm);
      if (!amps) {
        amps = analyzeHarmonicSpectrum(pcm, this.sampleRate, ADD_SPECTRA_K).amps;
        this._addAnalysisCache.set(pcm, amps);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, slot, ADD_SPECTRA_K, 1, gl.RED, gl.FLOAT, amps);
      this._addSlotByInstIdx[i] = slot;
      slot++;
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  // Resets synth state textures and FX feedback buffers.
  resetState() {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clearColor(0, 0, 0, 0);
    for (const it of this.inst) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.stateRead, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.stateWrite, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.phaseRead, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.phaseWrite, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.phase2Read, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.phase2Write, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

    }
    for (const fx of this.instFx) if (fx) fx.reset();
    gl.deleteFramebuffer(fbo);
    // Drop any pending async readback so the next renderBlockAsync re-primes (its
    // first call returns silence) instead of leaking the previous run's last block.
    for (let i = 0; i < this._pboFence.length; i++) {
      if (this._pboFence[i]) { gl.deleteSync(this._pboFence[i]!); this._pboFence[i] = null; }
    }
    this._pboIdx = 0;
  }

  // Per-instance fx params (instruments.map(i => i.fx)), set by the app whenever the
  // instrument table or its fx changes. Each instance's chain reads instFxParams[k].
  setInstrumentFx(fx: FxParams[]) {
    this.instFxParams = fx;
  }

  // Per-instance effect-chain order (instruments.map(i => i.fxOrder)). Each entry is
  // normalized against the registry (unknown keys dropped, missing ones appended) so
  // a new effect never silently vanishes from a saved/older chain.
  setInstrumentFxOrder(orders: (string[] | undefined)[]) {
    this.instFxOrder = orders.map((o) => normalizeFxOrder(o));
  }

  // Lazily build the effects chain for instrument-instance k.
  _instChain(k: number): EffectsChain {
    if (!this.instFx[k]) this.instFx[k] = new EffectsChain(this.gl, this.sampleRate, this.instFxParams[k] || null);
    return this.instFx[k];
  }

  // Run the synth + per-instance FX + mix passes for one block, leaving the final
  // stereo result in mixFbo (R = left, G = right). Both the sync and async readback
  // paths call this; only the readback step differs.
  // vd: voice data with typed arrays (see tracker engine). blockStart: absolute frame.
  _renderToMix(vd: VoiceData, blockStart: number): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);

    if (vd.sampler) {
      for (let v = 0; v < VOICES; v++) {
        if (!vd.active[v]) continue;
        const instId = vd.instId[v];
        const slot = (instId >= 0 && instId < this._smpSlotByInstIdx.length) ? this._smpSlotByInstIdx[instId] : -1;
        vd.sampler.slot[v] = slot;
        if (slot >= 0) {
          vd.sampler.baseRow[v] = this._smpBaseRow[slot];
          vd.sampler.len[v] = this._smpLen[slot];
          vd.sampler.rootFreq[v] = this._smpRootFreq[slot];
          vd.sampler.loopStart[v] = this._smpLoopStart[slot];
          vd.sampler.loopEnd[v] = this._smpLoopEnd[slot];
          vd.sampler.loopMode[v] = this._smpLoopMode[slot];
        }
      }
    }

    // 1. Synth voice pass for each instrument. The 303/Moog ladder is recursive,
    //    so each output sample must recompute the filter from a known state. We
    //    render the block in SUB-wide strips, ping-ponging the per-sample state
    //    texture between them, so each fragment only recomputes within its strip
    //    (state at the strip edge = the prior strip's last column). That turns the
    //    per-block cost from O(BLOCK^2) into O(BLOCK*SUB) with identical output.
    //    Closed-form engines (dx7, 808) need no recursion → one full-width pass.
    for (const it of this.inst) {
      // Additive (Spectra) is multi-pass (tile-synth → log-reduce) — its own path.
      if (it.def.additive) { this._renderAdditive(it, vd, blockStart); continue; }
      gl.useProgram(it.prog);
      const p = it.prog;
      gl.bindFramebuffer(gl.FRAMEBUFFER, it.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.audio, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);

      gl.uniform1f(p.u('uSampleRate'), this.sampleRate);
      gl.uniform1f(p.u('uBlockStart'), blockStart);
      gl.uniform1i(p.u('uBlock'), BLOCK);
      gl.uniform1i(p.u('uInstId'), it.id);
      gl.uniform1iv(p.u('uActive[0]'), vd.active);
      gl.uniform1iv(p.u('uInst[0]'), vd.inst);
      gl.uniform1fv(p.u('uFreq[0]'), vd.freq);
      gl.uniform1fv(p.u('uVel[0]'), vd.vel);
      gl.uniform1fv(p.u('uOnRel[0]'), vd.onRel);
      gl.uniform1fv(p.u('uOffRel[0]'), vd.offRel);
      gl.uniform4fv(p.u('uP0[0]'), vd.p0);
      gl.uniform4fv(p.u('uP1[0]'), vd.p1);
      // Universal extra banks — uploaded for every engine. Shaders that don't
      // reference them strip the uniform, so u() is null → these are no-ops there.
      gl.uniform4fv(p.u('uP2[0]'), vd.p2);
      gl.uniform4fv(p.u('uP3[0]'), vd.p3);
      gl.uniform1fv(p.u('uFreqFrom[0]'), vd.freqFrom);
      gl.uniform1fv(p.u('uPhaseOff[0]'), vd.phaseOff);
      // Engine-specific per-voice uniforms (e.g. dx7 operator banks).
      it.def.uploadVoiceUniforms?.(gl, p, vd);

      gl.activeTexture(gl.TEXTURE0);

      // Per-sample-recursive engines (ladder filters) render in strips; the rest
      // (closed-form in t) render in one full-width pass.
      const sub = it.def.recursive ? this.subBlock : BLOCK;
      let readTex = it.stateRead, writeTex = it.stateWrite;
      let pRead = it.phaseRead, pWrite = it.phaseWrite;
      let p2Read = it.phase2Read, p2Write = it.phase2Write;
      for (let o = 0; o < BLOCK; o += sub) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, writeTex, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, pWrite, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, p2Write, 0);
        gl.uniform1i(p.u('uSubOffset'), o);
        
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTex);       // uPrevState
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, pRead);         // uPrevPhase
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, p2Read);        // uPrevPhase2
        
        gl.viewport(o, 0, sub, VOICES);
        drawQuad(gl);
        
        const t = readTex; readTex = writeTex; writeTex = t;
        const pt = pRead; pRead = pWrite; pWrite = pt;
        const p2t = p2Read; p2Read = p2Write; p2Write = p2t;
      }
      // Save final state
      it.stateRead = readTex; it.stateWrite = writeTex;
      it.phaseRead = pRead; it.phaseWrite = pWrite;
      it.phase2Read = p2Read; it.phase2Write = p2Write;
    }

    // Clear the sidechain dry bus (all rows)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.instDryFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.viewport(0, 0, BLOCK, INST_DRY_ROWS);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Clear the final mixed output buffer before accumulating instruments
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 2. Per-INSTRUMENT mix + FX. Each instrument INSTANCE has its own effects chain
    //    (its own reverb/delay state AND its own params). A chord/instrument spread
    //    over several channels sums into ONE chain (no reverb multiplication), and two
    //    instances of the same engine can sound completely different. We isolate an
    //    instance's dry signal by masking the mix gains to the voices playing it.
    //    Every table instance is processed each block (even with silent input) so its
    //    reverb/delay tail rings out after the notes stop.
    let nInst = this.instFxParams.length;
    for (let v = 0; v < VOICES; v++) if (vd.active[v]) nInst = Math.max(nInst, vd.instId[v] + 1);
    if (nInst < 1) nInst = 1;

    // Mask the mix gains to the voices playing instance k; returns its engine resources.
    const maskInstance = (k: number): InstRender => {
      this._maskGain.fill(0);
      let typeId = 0;
      for (let v = 0; v < VOICES; v++) {
        if (vd.active[v] && vd.instId[v] === k) { this._maskGain[v] = vd.gain[v]; typeId = vd.inst[v]; }
      }
      return this.inst[typeId] ?? this.inst[0];
    };

    // Mix instance k's masked voices (silent if none active) into the bound fbo at row `row`.
    const mixInstance = (k: number, row: number) => {
      const src = maskInstance(k);
      gl.useProgram(this.mixProg);
      gl.uniform1fv(this.mixProg.u('uGain[0]'), this._maskGain);
      gl.uniform1fv(this.mixProg.u('uPan[0]'), vd.pan);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.audio);
      gl.viewport(0, row, BLOCK, 1);
      drawQuad(gl);
    };

    // PASS A — fill the sidechain dry bus FIRST, so a compressor can key off ANY
    // instance regardless of chain order (instances ≥ INST_DRY_ROWS don't fit the
    // bus and so can't be key sources, but still render in pass B).
    const nBus = Math.min(nInst, INST_DRY_ROWS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.instDryFbo);
    for (let k = 0; k < nBus; k++) mixInstance(k, k);

    // PASS B — each instance's own chain processes its dry signal + accumulates into the mix.
    for (let k = 0; k < nInst; k++) {
      if (k < INST_DRY_ROWS) {
        // Reuse pass A's row: blit it into the 1-row channel dry texture.
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.instDryFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.chanDryFbo);
        gl.blitFramebuffer(0, k, BLOCK, k + 1, 0, 0, BLOCK, 1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      } else {
        // Beyond the bus: mix this instance straight into the channel dry texture.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.chanDryFbo);
        mixInstance(k, 0);
      }

      const fx = this._instChain(k);
      const params = this.instFxParams[k];
      if (params) fx.params = params;
      if (this.instFxOrder[k]) fx.order = this.instFxOrder[k];   // per-instance chain order
      fx.process(this.chanDryTex, this.mixFbo, blockStart, vd.master, this.instDryTex, k);
    }
  }

  // Render one block of an ADDITIVE (Spectra) engine. Two stages, both full-width
  // fullscreen-quad passes (no recursion):
  //   1. synth → addPartials (BLOCK × ADD_TILES·VOICES): each fragment sums ADD_TILE
  //      partials for one sample of one voice. ~8M fragments at the 2048-partial cap —
  //      the parallel-over-partials workload the GPU actually wants.
  //   2. log-reduce: halve the tile axis (ADD_TILES → 1) by summing adjacent row-pairs,
  //      ping-ponging addA/addB; the final pass soft-clips and lands in it.audio
  //      (BLOCK×VOICES), so the downstream mix/FX path is identical to every engine.
  _renderAdditive(it: InstRender, vd: VoiceData, blockStart: number): void {
    const gl = this.gl;
    const p = it.prog;

    // Stage 1 — tile synth into addPartials (single color attachment, no MRT carry).
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, it.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.addPartials!, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.uniform1f(p.u('uSampleRate'), this.sampleRate);
    gl.uniform1f(p.u('uBlockStart'), blockStart);
    gl.uniform1i(p.u('uBlock'), BLOCK);
    gl.uniform1i(p.u('uInstId'), it.id);
    gl.uniform1iv(p.u('uActive[0]'), vd.active);
    gl.uniform1iv(p.u('uInst[0]'), vd.inst);
    gl.uniform1fv(p.u('uFreq[0]'), vd.freq);
    gl.uniform1fv(p.u('uVel[0]'), vd.vel);
    gl.uniform1fv(p.u('uOnRel[0]'), vd.onRel);
    gl.uniform1fv(p.u('uOffRel[0]'), vd.offRel);
    gl.uniform4fv(p.u('uP0[0]'), vd.p0);
    gl.uniform4fv(p.u('uP1[0]'), vd.p1);
    gl.uniform4fv(p.u('uP2[0]'), vd.p2);
    gl.uniform4fv(p.u('uP3[0]'), vd.p3);
    gl.uniform1fv(p.u('uFreqFrom[0]'), vd.freqFrom);
    gl.uniform1fv(p.u('uPhaseOff[0]'), vd.phaseOff);
    // Per-voice spectral slot (resynthesis): map each active voice's instance to its
    // analyzed-profile row, -1 if none. The atlas is bound at unit ADD_SPECTRA_UNIT.
    for (let v = 0; v < VOICES; v++) {
      const instId = vd.instId[v];
      this._addSlotScratch[v] = (vd.active[v] && instId >= 0 && instId < this._addSlotByInstIdx.length)
        ? this._addSlotByInstIdx[instId] : -1;
    }
    gl.uniform1fv(p.u('uAddSlot[0]'), this._addSlotScratch);
    gl.activeTexture(gl.TEXTURE0 + ADD_SPECTRA_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.addSpectraTex);
    gl.viewport(0, 0, BLOCK, ADD_TILES * VOICES);
    gl.activeTexture(gl.TEXTURE0);
    drawQuad(gl);

    // Stage 2 — log-reduce the tile axis. read → write, ping-ponging A/B; final → it.audio.
    gl.useProgram(it.reduceProg!);
    let src = it.addPartials!;
    let useA = true;
    for (let tilesIn = ADD_TILES; tilesIn > 1; tilesIn >>= 1) {
      const tilesOut = tilesIn >> 1;
      const final = tilesOut === 1;
      const dst = final ? it.audio : (useA ? it.addA! : it.addB!);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.uniform1i(it.reduceProg!.u('uFinal'), final ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.viewport(0, 0, BLOCK, tilesOut * VOICES);
      drawQuad(gl);
      src = dst;
      useA = !useA;
    }
  }

  // Deinterleave the RGBA readback (readBuf) into the stereo outBuf and return it.
  _deinterleave(): Float32Array {
    const out = this.outBuf, rb = this.readBuf;
    for (let i = 0; i < BLOCK; i++) {
      out[i * 2]     = rb[i * 4];      // R = left
      out[i * 2 + 1] = rb[i * 4 + 1];  // G = right
    }
    return out;
  }

  // Render one block and read it back SYNCHRONOUSLY. readPixels into client memory
  // flushes the GPU and stalls until the pixels are ready — exact and simple, which
  // is what the offline WAV export and the test harnesses want. The realtime
  // producer should use renderBlockAsync instead to avoid that main-thread stall.
  renderBlock(vd: VoiceData, blockStart: number): Float32Array {
    const gl = this.gl;
    this._renderToMix(vd, blockStart);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.readPixels(0, 0, BLOCK, 1, gl.RGBA, gl.FLOAT, this.readBuf);
    return this._deinterleave();
  }

  // Render block N and read back block N-1. The current block's mix is copied into
  // a pixel-pack buffer (PBO) with a non-blocking readPixels (DMA into GPU-side
  // memory), and we map the PBO we filled on the PREVIOUS call — whose DMA has had a
  // full block of wall-clock time to finish — so getBufferSubData doesn't stall.
  // This removes the synchronous readPixels block from the audio producer's main
  // thread (the portability ceiling on weak GPUs). Cost: one block (~10.7ms @48k)
  // of constant output latency; the first call returns silence (priming).
  renderBlockAsync(vd: VoiceData, blockStart: number): Float32Array {
    const gl = this.gl;
    if (!this._pbo) {
      this._pbo = [gl.createBuffer()!, gl.createBuffer()!];
      for (const b of this._pbo) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.readBuf.byteLength, gl.STREAM_READ);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    this._renderToMix(vd, blockStart);

    const cur = this._pboIdx;
    const prev = cur ^ 1;

    // Issue this block's readback into PBO[cur] without blocking (offset 0 into the
    // bound PIXEL_PACK_BUFFER → the driver DMAs asynchronously), then fence it so we
    // can tell when it's done.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo[cur]);
    gl.readPixels(0, 0, BLOCK, 1, gl.RGBA, gl.FLOAT, 0);
    if (this._pboFence[cur]) gl.deleteSync(this._pboFence[cur]!);
    this._pboFence[cur] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);

    let result: Float32Array;
    if (this._pboFence[prev]) {
      // Flush the queue so the previous block's DMA actually progresses (timeout 0:
      // don't spin here — getBufferSubData below provides the real synchronization).
      // In realtime a full block has elapsed, so it's already complete; back-to-back
      // (offline/headless) getBufferSubData briefly blocks — still correct.
      gl.clientWaitSync(this._pboFence[prev]!, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo[prev]);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf);
      result = this._deinterleave();
    } else {
      this.outBuf.fill(0);      // priming: no prior block ready yet
      result = this.outBuf;
    }

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this._pboIdx = prev;        // next call writes the buffer we just consumed
    return result;
  }
}
