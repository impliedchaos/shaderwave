// Orchestrates the GPU audio graph for one render block:
//
//   for each instrument:  synth pass → audioTex[i] (BLOCK×VOICES) + state carry (MRT)
//   mix pass:             sum all audioTex rows → stereo mixTex (BLOCK×1)
//   readback:             readPixels(mixTex) → interleaved Float32Array(BLOCK*2)
//
// State textures ping-pong per instrument so recursive filters carry across
// blocks. A voice belongs to exactly one instrument (uInst[v]); each program
// renders only its own rows and writes silence elsewhere.
import { createProgram, drawQuad } from './program.js';
import { EffectsChain } from './effects.js';
import { BLOCK, VOICES, INSTRUMENTS } from '../constants.js';
import COMMON from './shaders/common.glsl?raw';
import SYNTH_303 from './shaders/synth-303.glsl?raw';
import SYNTH_DX7 from './shaders/synth-dx7.glsl?raw';
import SYNTH_808 from './shaders/synth-808.glsl?raw';
import SYNTH_MOOG from './shaders/synth-moog.glsl?raw';
import MIX_FS from './shaders/mix.glsl?raw';

// Order MUST match INSTRUMENTS in constants.js — the index is the instrument id.
const SYNTH_SRC = { '303': SYNTH_303, 'dx7': SYNTH_DX7, '808': SYNTH_808, 'moog': SYNTH_MOOG };

function makeTex(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export class SynthRenderer {
  constructor(gl, sampleRate, fxParams) {
    this.gl = gl;
    this.sampleRate = sampleRate;

    this.inst = INSTRUMENTS.map((name, id) => {
      const prog = createProgram(gl, COMMON + SYNTH_SRC[name]);
      const mixTex = makeTex(gl, BLOCK, 1);
      const mixFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, mixFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mixTex, 0);

      const itParams = (fxParams && fxParams[name]) ? fxParams[name] : null;

      return {
        name, id, prog,
        audio: makeTex(gl, BLOCK, VOICES),
        stateRead: makeTex(gl, BLOCK, VOICES),
        stateWrite: makeTex(gl, BLOCK, VOICES),
        fbo: gl.createFramebuffer(),
        mixTex,
        mixFbo,
        fx: new EffectsChain(gl, sampleRate, itParams),
      };
    });

    this.mixProg = createProgram(gl, MIX_FS);
    
    // Master combined mix output
    this.mixTex = makeTex(gl, BLOCK, 1);
    this.mixFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mixTex, 0);

    this.readBuf = new Float32Array(BLOCK * 4);     // RGBA readback
    this.outBuf = new Float32Array(BLOCK * 2);      // interleaved stereo result

    // Tell each synth program its uPrevState sampler lives on texture unit 0.
    for (const it of this.inst) {
      gl.useProgram(it.prog);
      gl.uniform1i(it.prog.u('uPrevState'), 0);
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

      it.fx._clear(it.fx.delayRead);
      it.fx._clear(it.fx.delayWrite);
      it.fx._clear(it.fx.fdnRead);
      it.fx._clear(it.fx.fdnWrite);
    }
    gl.deleteFramebuffer(fbo);
  }

  // vd: voice data with typed arrays (see tracker engine). blockStart: absolute frame.
  // Returns the shared interleaved-stereo output buffer (BLOCK*2 floats).
  renderBlock(vd, blockStart) {
    const gl = this.gl;
    gl.disable(gl.BLEND);

    // 1. Synth voice pass for each instrument
    for (const it of this.inst) {
      gl.useProgram(it.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, it.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, it.audio, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, it.stateWrite, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      const p = it.prog;
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

      if (it.name === 'dx7' && vd.dx7Ops) {
        gl.uniform4fv(p.u('uOpA[0]'), vd.dx7Ops.A);   // per-voice (coarse,fine,level,detune)
        gl.uniform4fv(p.u('uOpB[0]'), vd.dx7Ops.B);   // per-voice (mode,sustain,release,decay)
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, it.stateRead);

      gl.viewport(0, 0, BLOCK, VOICES);
      drawQuad(gl);

      // Ping-pong the state for next block.
      const tmp = it.stateRead; it.stateRead = it.stateWrite; it.stateWrite = tmp;
    }

    // Clear the final mixed output buffer before accumulating instruments
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mixFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 2. Mix and process FX per instrument
    for (const it of this.inst) {
      gl.useProgram(this.mixProg);
      gl.uniform1fv(this.mixProg.u('uGain[0]'), vd.gain);
      gl.uniform1fv(this.mixProg.u('uPan[0]'), vd.pan);

      // 2a. Mix this instrument's voices into its own dry mix texture
      gl.bindFramebuffer(gl.FRAMEBUFFER, it.mixFbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, it.audio);
      gl.viewport(0, 0, BLOCK, 1);
      drawQuad(gl);

      // 2b. Process FX chain, accumulating (additive blend) directly into this.mixFbo
      it.fx.process(it.mixTex, this.mixFbo, blockStart, vd.master);
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
