// GPU effects chain. Each effect is its own shader pass; the signal flows through
// an ORDERED list of stages, ping-ponging between two BLOCK×1 scratch buffers. A
// terminal master pass applies master gain and additively blends each instrument's
// result into the shared mix. The order is data-driven (see `this.order`) so the
// chain can be rearranged just by reordering that array — no pass is positional
// except the always-last master accumulate.
//
// Stateful stages (delay, reverb, chorus) own persistent ping-pong "ring" textures
// updated every block regardless of their position or wet level, so toggling them
// on never pops.
import { createProgram, drawQuad, makeTex } from './program.js';
import { BLOCK } from '../constants.js';
import FX_DISTORTION from './shaders/fx-distortion.glsl?raw';
import FX_CHORUS_UPDATE from './shaders/fx-chorus-update.glsl?raw';
import FX_CHORUS_TAP from './shaders/fx-chorus-tap.glsl?raw';
import FX_TREMOLO from './shaders/fx-tremolo.glsl?raw';
import FX_DELAY_UPDATE from './shaders/fx-delay-update.glsl?raw';
import FX_DELAY_TAP from './shaders/fx-delay-tap.glsl?raw';
import FX_FDN_UPDATE from './shaders/fx-fdn-update.glsl?raw';
import FX_FDN_TAP from './shaders/fx-fdn-tap.glsl?raw';
import FX_BITCRUSH from './shaders/fx-bitcrush.glsl?raw';
import FX_WIDTH from './shaders/fx-width.glsl?raw';
import FX_MASTER from './shaders/fx-master.glsl?raw';

// Delay ring: 2D (width-limited) layout, ~2.7s at 48k.
const DELAY_W = 2048, DELAY_H = 64, DELAY_LEN = DELAY_W * DELAY_H;
// FDN: four lines in four rows; lengths coprime-ish and all ≥ BLOCK.
const FDN_LEN = 2048;
const FDN_LENS = [1557, 1617, 1491, 1422];
// Chorus history ring: single row, comfortably longer than base+depth (~17ms).
const CHORUS_LEN = 2048;

// Default signal-flow order (matches the README chain). Reorder this array to
// rearrange the chain; the master accumulate always runs after it.
export const DEFAULT_FX_ORDER = ['distortion', 'chorus', 'tremolo', 'delay', 'reverb', 'bitcrush', 'width'];

export function defaultFxParams() {
  return {
    enabled: true,
    // Per-effect bypass switches (the whole chain is also gated by `enabled`).
    distOn: true,
    chorusOn: true,
    tremoloOn: true,
    delayOn: true,
    reverbOn: true,
    widthOn: true,
    bitcrushOn: false,
    dist: 1.4,
    tone: 0.5,
    level: 1.0,
    delayTime: 0.33,     // seconds
    delayFeedback: 0.42,
    delayMix: 0.32,
    reverbDecay: 0.82,
    reverbDamp: 0.4,
    reverbSend: 0.8,
    reverbMix: 0.26,
    width: 1.15,
    master: 1.0,

    // Chorus & Tremolo defaults
    chorusMix: 0.0,
    chorusRate: 1.5,
    chorusDepth: 2.0,
    tremoloMix: 0.0,
    tremoloRate: 5.0,

    // Bitcrusher defaults (off by default)
    bitcrushBits: 8.0,      // bit depth (1–16)
    bitcrushRate: 4000.0,   // target sample rate in Hz (100–22000)
  };
}

export class EffectsChain {
  constructor(gl, sampleRate, params) {
    this.gl = gl;
    this.sampleRate = sampleRate;
    this.params = params || defaultFxParams();
    this.order = DEFAULT_FX_ORDER.slice();

    // Programs (one per stage; stateful stages have an update + a tap program).
    this.progDist = createProgram(gl, FX_DISTORTION);
    this.progChoUp = createProgram(gl, FX_CHORUS_UPDATE);
    this.progChoTap = createProgram(gl, FX_CHORUS_TAP);
    this.progTrem = createProgram(gl, FX_TREMOLO);
    this.progDelayUp = createProgram(gl, FX_DELAY_UPDATE);
    this.progDelayTap = createProgram(gl, FX_DELAY_TAP);
    this.progFdnUp = createProgram(gl, FX_FDN_UPDATE);
    this.progFdnTap = createProgram(gl, FX_FDN_TAP);
    this.progCrush = createProgram(gl, FX_BITCRUSH);
    this.progWidth = createProgram(gl, FX_WIDTH);
    this.progMaster = createProgram(gl, FX_MASTER);

    // Two BLOCK×1 ping-pong scratch buffers the chain signal flows through.
    this.scratchTex = [makeTex(gl, BLOCK, 1), makeTex(gl, BLOCK, 1)];
    this.scratchFbo = [gl.createFramebuffer(), gl.createFramebuffer()];
    for (let k = 0; k < 2; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo[k]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex[k], 0);
    }

    // Persistent ring history (ping-ponged each block).
    this.delayRead = makeTex(gl, DELAY_W, DELAY_H);
    this.delayWrite = makeTex(gl, DELAY_W, DELAY_H);
    this.fdnRead = makeTex(gl, FDN_LEN, 4);
    this.fdnWrite = makeTex(gl, FDN_LEN, 4);
    this.chorusRead = makeTex(gl, CHORUS_LEN, 1);
    this.chorusWrite = makeTex(gl, CHORUS_LEN, 1);

    // Scratch FBO used while updating ring textures.
    this.ringFbo = gl.createFramebuffer();

    this.reset();

    // Sampler unit assignments (constant per program).
    gl.useProgram(this.progDist); gl.uniform1i(this.progDist.u('uIn'), 0);
    gl.useProgram(this.progChoUp); gl.uniform1i(this.progChoUp.u('uIn'), 0); gl.uniform1i(this.progChoUp.u('uPrev'), 1);
    gl.useProgram(this.progChoTap); gl.uniform1i(this.progChoTap.u('uIn'), 0); gl.uniform1i(this.progChoTap.u('uRing'), 1);
    gl.useProgram(this.progTrem); gl.uniform1i(this.progTrem.u('uIn'), 0);
    gl.useProgram(this.progDelayUp); gl.uniform1i(this.progDelayUp.u('uMix'), 0); gl.uniform1i(this.progDelayUp.u('uPrevDelay'), 1);
    gl.useProgram(this.progDelayTap); gl.uniform1i(this.progDelayTap.u('uIn'), 0); gl.uniform1i(this.progDelayTap.u('uDelay'), 1);
    gl.useProgram(this.progFdnUp); gl.uniform1i(this.progFdnUp.u('uMix'), 0); gl.uniform1i(this.progFdnUp.u('uPrevFdn'), 1);
    gl.useProgram(this.progFdnTap); gl.uniform1i(this.progFdnTap.u('uIn'), 0); gl.uniform1i(this.progFdnTap.u('uFdn'), 1);
    gl.useProgram(this.progCrush); gl.uniform1i(this.progCrush.u('uIn'), 0);
    gl.useProgram(this.progWidth); gl.uniform1i(this.progWidth.u('uIn'), 0);
    gl.useProgram(this.progMaster); gl.uniform1i(this.progMaster.u('uIn'), 0);

    // name → stage runner. Reordering `this.order` reorders the chain.
    this._stage = {
      distortion: (i, o) => this._distortion(i, o),
      chorus: (i, o) => this._chorus(i, o),
      tremolo: (i, o) => this._tremolo(i, o),
      delay: (i, o) => this._delay(i, o),
      reverb: (i, o) => this._reverb(i, o),
      bitcrush: (i, o) => this._bitcrush(i, o),
      width: (i, o) => this._width(i, o),
    };
  }

  // Clear all persistent ring history to silence.
  reset() {
    this._clear(this.delayRead); this._clear(this.delayWrite);
    this._clear(this.fdnRead); this._clear(this.fdnWrite);
    this._clear(this.chorusRead); this._clear(this.chorusWrite);
  }

  _clear(tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ringFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _bind(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // An effect is live only if the whole chain is enabled AND its own switch is on.
  // A missing per-effect flag (older songs) counts as on, except bitcrush.
  _on(flag) {
    const p = this.params;
    return p.enabled && (flag === 'bitcrushOn' ? !!p[flag] : p[flag] !== false);
  }

  // Run the chain: dry stereo from mixTex flows through `this.order`, then the
  // master pass accumulates (additive) into targetFbo.
  process(mixTex, targetFbo, blockStart, masterScale = 1.0) {
    const gl = this.gl, p = this.params;
    this._bs = blockStart;
    this._wposD = ((blockStart % DELAY_LEN) + DELAY_LEN) % DELAY_LEN;
    this._wposF = ((blockStart % FDN_LEN) + FDN_LEN) % FDN_LEN;
    this._wposC = ((blockStart % CHORUS_LEN) + CHORUS_LEN) % CHORUS_LEN;
    let D = Math.round(p.delayTime * this.sampleRate);
    this._D = Math.max(BLOCK, Math.min(DELAY_LEN - 1, D)); // keep ≥ BLOCK for parallelism

    gl.disable(gl.BLEND);

    let src = mixTex;
    let cur = 0;
    for (const name of this.order) {
      const run = this._stage[name];
      if (!run) continue;
      run(src, this.scratchFbo[cur]);
      src = this.scratchTex[cur];
      cur ^= 1;
    }

    this._master(src, targetFbo, p.master * masterScale);
  }

  // --- individual stages: read inTex (BLOCK×1), write a BLOCK×1 buffer ---

  _stereoPass(prog, inTex, outFbo) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex);
    gl.viewport(0, 0, BLOCK, 1);
    // caller sets stage-specific uniforms before calling drawQuad
    return prog;
  }

  _distortion(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('distOn');
    const prog = this._stereoPass(this.progDist, inTex, outFbo);
    gl.uniform1f(prog.u('uDist'), on ? p.dist : 0.001);
    gl.uniform1f(prog.u('uTone'), on ? p.tone : 0.5);
    gl.uniform1f(prog.u('uDistLevel'), on ? p.level : 1.0);
    drawQuad(gl);
  }

  _tremolo(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('tremoloOn');
    const prog = this._stereoPass(this.progTrem, inTex, outFbo);
    gl.uniform1i(prog.u('uBlockStart'), this._bs);
    gl.uniform1f(prog.u('uSampleRate'), this.sampleRate);
    gl.uniform1f(prog.u('uTremoloRate'), p.tremoloRate);
    gl.uniform1f(prog.u('uTremoloMix'), on ? p.tremoloMix : 0.0);
    drawQuad(gl);
  }

  _width(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('widthOn');
    const prog = this._stereoPass(this.progWidth, inTex, outFbo);
    gl.uniform1f(prog.u('uWidth'), on ? p.width : 1.0);
    drawQuad(gl);
  }

  _bitcrush(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('bitcrushOn');
    const prog = this._stereoPass(this.progCrush, inTex, outFbo);
    gl.uniform1i(prog.u('uBitcrushOn'), on ? 1 : 0);
    gl.uniform1i(prog.u('uBlockStart'), this._bs);
    gl.uniform1i(prog.u('uBlock'), BLOCK);
    gl.uniform1f(prog.u('uBitcrushBits'), p.bitcrushBits !== undefined ? p.bitcrushBits : 8.0);
    gl.uniform1f(prog.u('uBitcrushRate'), p.bitcrushRate !== undefined ? p.bitcrushRate : 4000.0);
    gl.uniform1f(prog.u('uSampleRate'), this.sampleRate);
    drawQuad(gl);
  }

  _chorus(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('chorusOn');

    // 1. Update the chorus ring with the incoming signal.
    gl.useProgram(this.progChoUp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ringFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.chorusWrite, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex); this._bind(1, this.chorusRead);
    gl.uniform1i(this.progChoUp.u('uLen'), CHORUS_LEN);
    gl.uniform1i(this.progChoUp.u('uWpos'), this._wposC);
    gl.uniform1i(this.progChoUp.u('uBlock'), BLOCK);
    gl.viewport(0, 0, CHORUS_LEN, 1); drawQuad(gl);
    [this.chorusRead, this.chorusWrite] = [this.chorusWrite, this.chorusRead];

    // 2. Tap the modulated delays and blend with dry.
    const prog = this.progChoTap;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex); this._bind(1, this.chorusRead);
    gl.uniform1i(prog.u('uLen'), CHORUS_LEN);
    gl.uniform1i(prog.u('uWpos'), this._wposC);
    gl.uniform1i(prog.u('uBlockStart'), this._bs);
    gl.uniform1f(prog.u('uSampleRate'), this.sampleRate);
    gl.uniform1f(prog.u('uChorusRate'), p.chorusRate);
    gl.uniform1f(prog.u('uChorusDepth'), p.chorusDepth);
    gl.uniform1f(prog.u('uChorusMix'), on ? p.chorusMix : 0.0);
    gl.viewport(0, 0, BLOCK, 1); drawQuad(gl);
  }

  _delay(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('delayOn');

    // 1. Update the delay ring (feedback always runs to keep history warm).
    gl.useProgram(this.progDelayUp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ringFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.delayWrite, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex); this._bind(1, this.delayRead);
    const up = this.progDelayUp;
    gl.uniform1i(up.u('uW'), DELAY_W); gl.uniform1i(up.u('uH'), DELAY_H); gl.uniform1i(up.u('uLen'), DELAY_LEN);
    gl.uniform1i(up.u('uWpos'), this._wposD); gl.uniform1i(up.u('uBlock'), BLOCK);
    gl.uniform1i(up.u('uDelaySamples'), this._D); gl.uniform1f(up.u('uFeedback'), p.delayFeedback);
    gl.viewport(0, 0, DELAY_W, DELAY_H); drawQuad(gl);
    [this.delayRead, this.delayWrite] = [this.delayWrite, this.delayRead];

    // 2. Tap + mix.
    const prog = this.progDelayTap;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex); this._bind(1, this.delayRead);
    gl.uniform1i(prog.u('uW'), DELAY_W); gl.uniform1i(prog.u('uLen'), DELAY_LEN);
    gl.uniform1i(prog.u('uWpos'), this._wposD); gl.uniform1i(prog.u('uDelaySamples'), this._D);
    gl.uniform1f(prog.u('uDelayMix'), on ? p.delayMix : 0.0);
    gl.viewport(0, 0, BLOCK, 1); drawQuad(gl);
  }

  _reverb(inTex, outFbo) {
    const gl = this.gl, p = this.params, on = this._on('reverbOn');

    // 1. Update the FDN ring (decay/damp/send always run to keep the tail warm).
    gl.useProgram(this.progFdnUp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ringFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fdnWrite, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex); this._bind(1, this.fdnRead);
    const up = this.progFdnUp;
    gl.uniform1i(up.u('uLenF'), FDN_LEN); gl.uniform1i(up.u('uWpos'), this._wposF); gl.uniform1i(up.u('uBlock'), BLOCK);
    gl.uniform1iv(up.u('uLens[0]'), FDN_LENS);
    gl.uniform1f(up.u('uDecay'), p.reverbDecay); gl.uniform1f(up.u('uDamp'), p.reverbDamp); gl.uniform1f(up.u('uSend'), p.reverbSend);
    gl.viewport(0, 0, FDN_LEN, 4); drawQuad(gl);
    [this.fdnRead, this.fdnWrite] = [this.fdnWrite, this.fdnRead];

    // 2. Tap + mix.
    const prog = this.progFdnTap;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex); this._bind(1, this.fdnRead);
    gl.uniform1i(prog.u('uLenF'), FDN_LEN); gl.uniform1i(prog.u('uWposF'), this._wposF);
    gl.uniform1f(prog.u('uReverbMix'), on ? p.reverbMix : 0.0);
    gl.viewport(0, 0, BLOCK, 1); drawQuad(gl);
  }

  // Terminal accumulate: master gain + additive blend into the shared mix.
  _master(inTex, targetFbo, masterGain) {
    const gl = this.gl;
    gl.useProgram(this.progMaster);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this._bind(0, inTex);
    gl.uniform1f(this.progMaster.u('uMaster'), masterGain);
    gl.viewport(0, 0, BLOCK, 1); drawQuad(gl);
    gl.disable(gl.BLEND);
  }
}
