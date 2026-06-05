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
import { BLOCK, VOICES, INSTRUMENTS } from '../constants.js';
import type { FxParamsByType, InstrumentType, VoiceData } from '../types.js';
import COMMON from './shaders/common.glsl?raw';
import SYNTH_303 from './shaders/synth-303.glsl?raw';
import SYNTH_DX7 from './shaders/synth-dx7.glsl?raw';
import SYNTH_808 from './shaders/synth-808.glsl?raw';
import SYNTH_MOOG from './shaders/synth-moog.glsl?raw';
import MIX_FS from './shaders/mix.glsl?raw';

// Order MUST match INSTRUMENTS in constants.js — the index is the instrument id.
const SYNTH_SRC: Record<InstrumentType, string> = { '303': SYNTH_303, 'dx7': SYNTH_DX7, '808': SYNTH_808, 'moog': SYNTH_MOOG };

// One instrument's GPU resources: its synth program + audio/state textures, its
// own dry-mix target, and its effects chain.
interface InstRender {
  name: InstrumentType;
  id: number;
  prog: GLProgram;
  audio: WebGLTexture;
  stateRead: WebGLTexture;
  stateWrite: WebGLTexture;
  fbo: WebGLFramebuffer | null;
  mixTex: WebGLTexture;
  mixFbo: WebGLFramebuffer | null;
  fx: EffectsChain;
}

export class SynthRenderer {
  gl: WebGL2RenderingContext;
  sampleRate: number;
  subBlock: number;
  inst: InstRender[];
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

      it.fx.reset();
    }
    gl.deleteFramebuffer(fbo);
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
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

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
        gl.uniform4fv(p.u('uOpC[0]'), vd.dx7Ops.C);   // per-voice (r1,r2,r3,r4)
        gl.uniform4fv(p.u('uOpD[0]'), vd.dx7Ops.D);   // per-voice (l1,l2,l3,l4)
      }
      if (it.name === 'moog' && vd.p2) {
        gl.uniform4fv(p.u('uP2[0]'), vd.p2);          // osc waveforms/octaves, glide, noise
        gl.uniform4fv(p.u('uP3[0]'), vd.p3);
        gl.uniform1fv(p.u('uFreqFrom[0]'), vd.freqFrom);
      }

      gl.activeTexture(gl.TEXTURE0);

      // Recursive ladder engines render in strips; the rest in one pass.
      const sub = (it.name === '303' || it.name === 'moog') ? this.subBlock : BLOCK;
      let readTex = it.stateRead, writeTex = it.stateWrite;
      for (let o = 0; o < BLOCK; o += sub) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, writeTex, 0);
        gl.uniform1i(p.u('uSubOffset'), o);
        gl.bindTexture(gl.TEXTURE_2D, readTex);       // uPrevState (unit 0)
        gl.viewport(o, 0, sub, VOICES);
        drawQuad(gl);
        const t = readTex; readTex = writeTex; writeTex = t;
      }
      // readTex now holds the final per-sample state (incl. column BLOCK-1) for
      // the next block; writeTex is the spare for next time's ping-pong.
      it.stateRead = readTex; it.stateWrite = writeTex;
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
