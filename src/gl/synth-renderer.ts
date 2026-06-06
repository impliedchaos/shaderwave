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
import type { FxParamsByType, InstrumentDef, InstrumentType, VoiceData } from '../types.js';
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
  chanFx: EffectsChain[];               // one effects chain per channel (== voice)
  chanDryTex: WebGLTexture;
  chanDryFbo: WebGLFramebuffer | null;
  fxByType: FxParamsByType | null;      // per-engine-type params (source for each channel)
  _maskGain: Float32Array;              // scratch: gain array masked to a single voice
  mixProg: GLProgram;
  mixTex: WebGLTexture;
  mixFbo: WebGLFramebuffer | null;
  readBuf: Float32Array;
  outBuf: Float32Array;

  constructor(gl: WebGL2RenderingContext, sampleRate: number, fxParams: FxParamsByType | null) {
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
    this.fxByType = fxParams;
    this.chanFx = Array.from({ length: VOICES }, () =>
      new EffectsChain(gl, sampleRate, fxParams ? fxParams[this.inst[0].name] : null));
    // One reusable dry-mix target (BLOCK×1) the per-channel mix writes into.
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

    // Tell each synth program its uPrevState sampler lives on texture unit 0,
    // and uPrevPhase/uPrevPhase2 on units 1 and 2.
    for (const it of this.inst) {
      gl.useProgram(it.prog);
      gl.uniform1i(it.prog.u('uPrevState'), 0);
      gl.uniform1i(it.prog.u('uPrevPhase'), 1);
      gl.uniform1i(it.prog.u('uPrevPhase2'), 2);
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
    for (const fx of this.chanFx) fx.reset();
    gl.deleteFramebuffer(fbo);
  }

  // Update the per-engine-type fx params each channel sources from (called by the
  // app when a song's fx is (re)built). Replaces the old per-type chain wiring.
  setFxParams(fxByType: FxParamsByType | null) {
    this.fxByType = fxByType;
  }

  // vd: voice data with typed arrays (see tracker engine). blockStart: absolute frame.
  // Returns the shared interleaved-stereo output buffer (BLOCK*2 floats).
  renderBlock(vd: VoiceData, blockStart: number): Float32Array {
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

    // 2. Per-CHANNEL mix + FX. Each voice routes through its OWN effects chain
    //    (its own reverb/delay state), so two channels of the same engine no longer
    //    share one chain. The mix shader sums per-voice rows with gain+pan, so we
    //    mask the gain array to a single voice to isolate that channel's dry signal
    //    from the audio texture of whatever engine it's playing.
    for (let v = 0; v < VOICES; v++) {
      // 2a. Isolate channel v's dry signal (its row of its engine's audio texture).
      const typeId = vd.inst[v];
      const src = this.inst[typeId] ?? this.inst[0];
      this._maskGain.fill(0);
      this._maskGain[v] = vd.gain[v];

      gl.useProgram(this.mixProg);
      gl.uniform1fv(this.mixProg.u('uGain[0]'), this._maskGain);
      gl.uniform1fv(this.mixProg.u('uPan[0]'), vd.pan);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.chanDryFbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.audio);
      gl.viewport(0, 0, BLOCK, 1);
      drawQuad(gl);

      // 2b. Point this channel's chain at the current instrument-type's params, then
      //     process — accumulating (additive blend) directly into the shared mix.
      const fx = this.chanFx[v];
      const params = this.fxByType ? this.fxByType[src.name] : null;
      if (params) fx.params = params;
      fx.process(this.chanDryTex, this.mixFbo, blockStart, vd.master);
    }

    // 3. Readback + deinterleave from the final combined mixFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.readPixels(0, 0, BLOCK, 1, gl.RGBA, gl.FLOAT, this.readBuf);
    
    const out = this.outBuf, rb = this.readBuf;
    for (let i = 0; i < BLOCK; i++) {
      out[i * 2]     = rb[i * 4];      // R = left
      out[i * 2 + 1] = rb[i * 4 + 1];  // G = right
    }
    return out;
  }
}
