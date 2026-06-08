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
import { EffectsChain } from './effects.js';
import { BLOCK, VOICES } from '../constants.js';
import { REGISTRY } from '../instruments/index.js';
import { bakeWavetableAtlas, WT_SAMPLES } from '../instruments/wavetables.js';
import type { FxParams, FxParamsByType, InstrumentDef, InstrumentType, VoiceData } from '../types.js';
import COMMON from './shaders/common.glsl?raw';
import MIX_FS from './shaders/mix.glsl?raw';

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
}

export class SynthRenderer {
  gl: WebGL2RenderingContext;
  sampleRate: number;
  subBlock: number;
  inst: InstRender[];
  instFx: EffectsChain[];               // lazily-built effects chain per instrument INSTANCE
  instFxParams: FxParams[];             // per-instance fx params (set by the app)
  chanDryTex: WebGLTexture;
  chanDryFbo: WebGLFramebuffer | null;
  _maskGain: Float32Array;              // scratch: mix gains masked to one instance's voices
  mixProg: GLProgram;
  mixTex: WebGLTexture;
  mixFbo: WebGLFramebuffer | null;
  readBuf: Float32Array;
  outBuf: Float32Array;
  wavetableTex: WebGLTexture;   // shared Wavewright wavetable atlas (bound to unit 3)
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
    this.chanDryTex = makeTex(gl, BLOCK, 1);
    this.chanDryFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.chanDryFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.chanDryTex, 0);
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
    }
    
    // Tell mixProg its uInstTex sampler lives on texture unit 0.
    gl.useProgram(this.mixProg);
    gl.uniform1i(this.mixProg.u('uInstTex'), 0);
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

    // 1. Synth voice pass for each instrument. The 303/Moog ladder is recursive,
    //    so each output sample must recompute the filter from a known state. We
    //    render the block in SUB-wide strips, ping-ponging the per-sample state
    //    texture between them, so each fragment only recomputes within its strip
    //    (state at the strip edge = the prior strip's last column). That turns the
    //    per-block cost from O(BLOCK^2) into O(BLOCK*SUB) with identical output.
    //    Closed-form engines (dx7, 808) need no recursion → one full-width pass.
    for (const it of this.inst) {
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

    for (let k = 0; k < nInst; k++) {
      this._maskGain.fill(0);
      let typeId = 0;
      for (let v = 0; v < VOICES; v++) {
        if (vd.active[v] && vd.instId[v] === k) { this._maskGain[v] = vd.gain[v]; typeId = vd.inst[v]; }
      }
      const src = this.inst[typeId] ?? this.inst[0];

      // 2a. Mix this instance's voices (silent if none active) into the dry buffer.
      gl.useProgram(this.mixProg);
      gl.uniform1fv(this.mixProg.u('uGain[0]'), this._maskGain);
      gl.uniform1fv(this.mixProg.u('uPan[0]'), vd.pan);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.chanDryFbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.audio);
      gl.viewport(0, 0, BLOCK, 1);
      drawQuad(gl);

      // 2b. This instance's own chain processes + accumulates into the shared mix.
      const fx = this._instChain(k);
      const params = this.instFxParams[k];
      if (params) fx.params = params;
      fx.process(this.chanDryTex, this.mixFbo, blockStart, vd.master);
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
