// GPU effects chain: stereo feedback delay + FDN reverb + drive + stereo width.
// Runs between the synth mix and the audio readback. Delay/reverb keep history
// in persistent ping-pong "ring" textures (see the fx-*-update shaders).
import { createProgram, drawQuad, makeTex } from './program.js';
import { BLOCK } from '../constants.js';
import FX_DELAY_UPDATE from './shaders/fx-delay-update.glsl?raw';
import FX_FDN_UPDATE from './shaders/fx-fdn-update.glsl?raw';
import FX_OUTPUT from './shaders/fx-output.glsl?raw';

// Delay ring: 2D (width-limited) layout, ~2.7s at 48k.
const DELAY_W = 2048, DELAY_H = 64, DELAY_LEN = DELAY_W * DELAY_H;
// FDN: four lines in four rows; lengths coprime-ish and all ≥ BLOCK.
const FDN_LEN = 2048;
const FDN_LENS = [1557, 1617, 1491, 1422];

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

    this.delayProg = createProgram(gl, FX_DELAY_UPDATE);
    this.fdnProg = createProgram(gl, FX_FDN_UPDATE);
    this.outProg = createProgram(gl, FX_OUTPUT);

    this.delayRead = makeTex(gl, DELAY_W, DELAY_H);
    this.delayWrite = makeTex(gl, DELAY_W, DELAY_H);
    this.fdnRead = makeTex(gl, FDN_LEN, 4);
    this.fdnWrite = makeTex(gl, FDN_LEN, 4);

    this.scratchFbo = gl.createFramebuffer();

    // Ring history must start silent.
    this._clear(this.delayRead); this._clear(this.delayWrite);
    this._clear(this.fdnRead); this._clear(this.fdnWrite);

    // Sampler unit assignments (constant per program).
    gl.useProgram(this.delayProg); gl.uniform1i(this.delayProg.u('uMix'), 0); gl.uniform1i(this.delayProg.u('uPrevDelay'), 1);
    gl.useProgram(this.fdnProg); gl.uniform1i(this.fdnProg.u('uMix'), 0); gl.uniform1i(this.fdnProg.u('uPrevFdn'), 1);
    gl.useProgram(this.outProg);
    gl.uniform1i(this.outProg.u('uMix'), 0); gl.uniform1i(this.outProg.u('uDelay'), 1); gl.uniform1i(this.outProg.u('uFdn'), 2);
  }

  _clear(tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Runs the chain reading dry stereo from mixTex, blending output into targetFbo
  process(mixTex, targetFbo, blockStart, masterScale = 1.0) {
    const gl = this.gl, p = this.params;
    const wposD = ((blockStart % DELAY_LEN) + DELAY_LEN) % DELAY_LEN;
    const wposF = ((blockStart % FDN_LEN) + FDN_LEN) % FDN_LEN;
    let D = Math.round(p.delayTime * this.sampleRate);
    D = Math.max(BLOCK, Math.min(DELAY_LEN - 1, D)); // keep ≥ BLOCK for parallelism

    // --- delay ring update ---
    gl.useProgram(this.delayProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.delayWrite, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, mixTex); this._bind(1, this.delayRead);
    const dp = this.delayProg;
    gl.uniform1i(dp.u('uW'), DELAY_W); gl.uniform1i(dp.u('uH'), DELAY_H); gl.uniform1i(dp.u('uLen'), DELAY_LEN);
    gl.uniform1i(dp.u('uWpos'), wposD); gl.uniform1i(dp.u('uBlock'), BLOCK);
    gl.uniform1i(dp.u('uDelaySamples'), D); gl.uniform1f(dp.u('uFeedback'), p.delayFeedback);
    gl.viewport(0, 0, DELAY_W, DELAY_H); drawQuad(gl);
    [this.delayRead, this.delayWrite] = [this.delayWrite, this.delayRead];

    // --- FDN reverb update ---
    gl.useProgram(this.fdnProg);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fdnWrite, 0);
    this._bind(0, mixTex); this._bind(1, this.fdnRead);
    const fp = this.fdnProg;
    gl.uniform1i(fp.u('uLenF'), FDN_LEN); gl.uniform1i(fp.u('uWpos'), wposF); gl.uniform1i(fp.u('uBlock'), BLOCK);
    gl.uniform1iv(fp.u('uLens[0]'), FDN_LENS);
    gl.uniform1f(fp.u('uDecay'), p.reverbDecay); gl.uniform1f(fp.u('uDamp'), p.reverbDamp); gl.uniform1f(fp.u('uSend'), p.reverbSend);
    gl.viewport(0, 0, FDN_LEN, 4); drawQuad(gl);
    [this.fdnRead, this.fdnWrite] = [this.fdnWrite, this.fdnRead];

    // --- output combine (rendered into targetFbo with additive blending) ---
    gl.useProgram(this.outProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    
    this._bind(0, mixTex); this._bind(1, this.delayRead); this._bind(2, this.fdnRead);
    const op = this.outProg;
    gl.uniform1i(op.u('uW'), DELAY_W); gl.uniform1i(op.u('uLen'), DELAY_LEN); gl.uniform1i(op.u('uLenF'), FDN_LEN);
    gl.uniform1i(op.u('uWpos'), wposD); gl.uniform1i(op.u('uWposF'), wposF);
    gl.uniform1i(op.u('uBlock'), BLOCK); gl.uniform1i(op.u('uDelaySamples'), D);
    // An effect is live only if the whole chain is enabled AND its own switch is
    // on. A missing per-effect flag (older songs) counts as on. When off, each
    // effect is driven to its neutral/bypass value.
    const on = (flag) => p.enabled && (flag === 'bitcrushOn' ? !!p[flag] : p[flag] !== false);
    gl.uniform1f(op.u('uDelayMix'), on('delayOn') ? p.delayMix : 0.0);
    gl.uniform1f(op.u('uReverbMix'), on('reverbOn') ? p.reverbMix : 0.0);
    gl.uniform1f(op.u('uDist'), on('distOn') ? p.dist : 0.001);
    gl.uniform1f(op.u('uTone'), on('distOn') ? p.tone : 0.5);
    gl.uniform1f(op.u('uDistLevel'), on('distOn') ? p.level : 1.0);
    gl.uniform1f(op.u('uWidth'), on('widthOn') ? p.width : 1.0);
    gl.uniform1f(op.u('uMaster'), p.master * masterScale);

    // Chorus & Tremolo Uniforms
    gl.uniform1i(op.u('uBlockStart'), blockStart);
    gl.uniform1f(op.u('uSampleRate'), this.sampleRate);
    gl.uniform1f(op.u('uChorusMix'), on('chorusOn') ? p.chorusMix : 0.0);
    gl.uniform1f(op.u('uChorusRate'), p.chorusRate);
    gl.uniform1f(op.u('uChorusDepth'), p.chorusDepth);
    gl.uniform1f(op.u('uTremoloMix'), on('tremoloOn') ? p.tremoloMix : 0.0);
    gl.uniform1f(op.u('uTremoloRate'), p.tremoloRate);

    // Bitcrusher uniforms
    gl.uniform1i(op.u('uBitcrushOn'), on('bitcrushOn') ? 1 : 0);
    gl.uniform1f(op.u('uBitcrushBits'), p.bitcrushBits !== undefined ? p.bitcrushBits : 8.0);
    gl.uniform1f(op.u('uBitcrushRate'), p.bitcrushRate !== undefined ? p.bitcrushRate : 4000.0);
    
    gl.viewport(0, 0, BLOCK, 1); drawQuad(gl);
    
    gl.disable(gl.BLEND);
  }

  _bind(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
}
