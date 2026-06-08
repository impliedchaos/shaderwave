// GPU effects chain — a data-driven REGISTRY of effect descriptors, mirroring the
// instrument registry (src/instruments/). Each effect is an `FxEffectDef` that
// declares its default params and an `init(gl)` which compiles its shader(s),
// allocates its own state textures, and returns an instance with a `process()`
// closure. `EffectsChain` is a generic runner: it builds one instance per def and
// sequences them through two BLOCK×1 ping-pong scratch buffers, then a terminal
// master pass applies master gain and additively blends into the shared mix.
//
// Adding an effect = one descriptor (+ its .glsl). `defaultFxParams()` and the chain
// order both DERIVE from FX_EFFECTS. Stateful effects (delay, reverb, chorus) own
// persistent ping-pong "ring" textures updated every block regardless of position or
// wet level, so toggling them never pops.
import { createProgram, drawQuad, makeTex } from './program.js';
import type { GLProgram } from './program.js';
import { BLOCK } from '../constants.js';
import type { FxParams } from '../types.js';
import FX_DISTORTION from './shaders/fx-distortion.glsl?raw';
import FX_CHORUS_UPDATE from './shaders/fx-chorus-update.glsl?raw';
import FX_CHORUS_TAP from './shaders/fx-chorus-tap.glsl?raw';
import FX_TREMOLO from './shaders/fx-tremolo.glsl?raw';
import FX_DELAY_UPDATE from './shaders/fx-delay-update.glsl?raw';
import FX_DELAY_TAP from './shaders/fx-delay-tap.glsl?raw';
import FX_FDN_UPDATE from './shaders/fx-fdn-update.glsl?raw';
import FX_FDN_TAP from './shaders/fx-fdn-tap.glsl?raw';
import FX_BITCRUSH from './shaders/fx-bitcrush.glsl?raw';
import FX_BITCRUSH_UPDATE from './shaders/fx-bitcrush-update.glsl?raw';
import FX_WIDTH from './shaders/fx-width.glsl?raw';
import FX_MASTER from './shaders/fx-master.glsl?raw';

// Delay ring: 2D (width-limited) layout, ~2.7s at 48k.
const DELAY_W = 2048, DELAY_H = 64, DELAY_LEN = DELAY_W * DELAY_H;
// FDN: four lines in four rows; lengths coprime-ish and all ≥ BLOCK.
const FDN_LEN = 2048;
const FDN_LENS = [1557, 1617, 1491, 1422];
// Chorus history ring: single row, comfortably longer than base+depth (~17ms).
const CHORUS_LEN = 2048;

// Per-block render context handed to each effect's process(). Provides the shared
// helpers + precomputed timing so the effects don't each recompute it.
export interface FxCtx {
  gl: WebGL2RenderingContext;
  sampleRate: number;
  params: FxParams;
  blockStart: number;
  ringFbo: WebGLFramebuffer | null;   // scratch fbo for ring updates (state effects)
  wposD: number;                      // delay ring write position this block
  wposF: number;                      // FDN ring write position
  wposC: number;                      // chorus ring write position
  delaySamples: number;               // clamped delay length in samples
  bind(unit: number, tex: WebGLTexture): void;
  stereoPass(prog: GLProgram, inTex: WebGLTexture, outFbo: WebGLFramebuffer | null): GLProgram;
  on(flag: string): boolean;
}

// A built effect: runs one block, optionally owning ring state to clear on reset.
export interface FxEffectInstance {
  process(ctx: FxCtx, inTex: WebGLTexture, outFbo: WebGLFramebuffer | null): void;
  reset?(clear: (tex: WebGLTexture) => void): void;
}

// A registry descriptor. `defaults` is this effect's slice of FxParams; `init`
// compiles programs + allocates state and returns the runnable instance.
export interface FxEffectDef {
  key: string;
  name: string;
  enableFlag?: string;           // FxParams bypass field (omitted → always on)
  defaults: Partial<FxParams>;
  init(gl: WebGL2RenderingContext): FxEffectInstance;
}

// ── The registry (signal-flow order) ────────────────────────────────────────

const fxDistortion: FxEffectDef = {
  key: 'distortion', name: 'Distortion', enableFlag: 'distOn',
  defaults: { distOn: true, dist: 1.4, tone: 0.5, level: 1.0 },
  init(gl) {
    const prog = createProgram(gl, FX_DISTORTION);
    gl.useProgram(prog); gl.uniform1i(prog.u('uIn'), 0);
    return {
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('distOn');
        ctx.stereoPass(prog, inTex, outFbo);
        g.uniform1f(prog.u('uDist'), on ? p.dist : 0.001);
        g.uniform1f(prog.u('uTone'), on ? p.tone : 0.5);
        g.uniform1f(prog.u('uDistLevel'), on ? p.level : 1.0);
        drawQuad(g);
      },
    };
  },
};

const fxChorus: FxEffectDef = {
  key: 'chorus', name: 'Chorus', enableFlag: 'chorusOn',
  defaults: { chorusOn: true, chorusMix: 0.0, chorusRate: 1.5, chorusDepth: 2.0 },
  init(gl) {
    const up = createProgram(gl, FX_CHORUS_UPDATE);
    const tap = createProgram(gl, FX_CHORUS_TAP);
    gl.useProgram(up); gl.uniform1i(up.u('uIn'), 0); gl.uniform1i(up.u('uPrev'), 1);
    gl.useProgram(tap); gl.uniform1i(tap.u('uIn'), 0); gl.uniform1i(tap.u('uRing'), 1);
    let read = makeTex(gl, CHORUS_LEN, 1);
    let write = makeTex(gl, CHORUS_LEN, 1);
    return {
      reset(clear) { clear(read); clear(write); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('chorusOn');
        // 1. Update the chorus ring with the incoming signal.
        g.useProgram(up);
        g.bindFramebuffer(g.FRAMEBUFFER, ctx.ringFbo);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, write, 0);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(up.u('uLen'), CHORUS_LEN);
        g.uniform1i(up.u('uWpos'), ctx.wposC);
        g.uniform1i(up.u('uBlock'), BLOCK);
        g.viewport(0, 0, CHORUS_LEN, 1); drawQuad(g);
        [read, write] = [write, read];
        // 2. Tap the modulated delays and blend with dry.
        g.useProgram(tap);
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(tap.u('uLen'), CHORUS_LEN);
        g.uniform1i(tap.u('uWpos'), ctx.wposC);
        g.uniform1i(tap.u('uBlockStart'), ctx.blockStart);
        g.uniform1f(tap.u('uSampleRate'), ctx.sampleRate);
        g.uniform1f(tap.u('uChorusRate'), p.chorusRate);
        g.uniform1f(tap.u('uChorusDepth'), p.chorusDepth);
        g.uniform1f(tap.u('uChorusMix'), on ? p.chorusMix : 0.0);
        g.viewport(0, 0, BLOCK, 1); drawQuad(g);
      },
    };
  },
};

const fxTremolo: FxEffectDef = {
  key: 'tremolo', name: 'Tremolo', enableFlag: 'tremoloOn',
  defaults: { tremoloOn: true, tremoloMix: 0.0, tremoloRate: 5.0 },
  init(gl) {
    const prog = createProgram(gl, FX_TREMOLO);
    gl.useProgram(prog); gl.uniform1i(prog.u('uIn'), 0);
    return {
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('tremoloOn');
        ctx.stereoPass(prog, inTex, outFbo);
        g.uniform1i(prog.u('uBlockStart'), ctx.blockStart);
        g.uniform1f(prog.u('uSampleRate'), ctx.sampleRate);
        g.uniform1f(prog.u('uTremoloRate'), p.tremoloRate);
        g.uniform1f(prog.u('uTremoloMix'), on ? p.tremoloMix : 0.0);
        drawQuad(g);
      },
    };
  },
};

const fxDelay: FxEffectDef = {
  key: 'delay', name: 'Delay', enableFlag: 'delayOn',
  defaults: { delayOn: true, delayTime: 0.33, delayFeedback: 0.42, delayMix: 0.32 },
  init(gl) {
    const up = createProgram(gl, FX_DELAY_UPDATE);
    const tap = createProgram(gl, FX_DELAY_TAP);
    gl.useProgram(up); gl.uniform1i(up.u('uMix'), 0); gl.uniform1i(up.u('uPrevDelay'), 1);
    gl.useProgram(tap); gl.uniform1i(tap.u('uIn'), 0); gl.uniform1i(tap.u('uDelay'), 1);
    let read = makeTex(gl, DELAY_W, DELAY_H);
    let write = makeTex(gl, DELAY_W, DELAY_H);
    return {
      reset(clear) { clear(read); clear(write); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('delayOn');
        // 1. Update the delay ring (feedback always runs to keep history warm).
        g.useProgram(up);
        g.bindFramebuffer(g.FRAMEBUFFER, ctx.ringFbo);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, write, 0);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(up.u('uW'), DELAY_W); g.uniform1i(up.u('uH'), DELAY_H); g.uniform1i(up.u('uLen'), DELAY_LEN);
        g.uniform1i(up.u('uWpos'), ctx.wposD); g.uniform1i(up.u('uBlock'), BLOCK);
        g.uniform1i(up.u('uDelaySamples'), ctx.delaySamples); g.uniform1f(up.u('uFeedback'), p.delayFeedback);
        g.viewport(0, 0, DELAY_W, DELAY_H); drawQuad(g);
        [read, write] = [write, read];
        // 2. Tap + mix.
        g.useProgram(tap);
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(tap.u('uW'), DELAY_W); g.uniform1i(tap.u('uLen'), DELAY_LEN);
        g.uniform1i(tap.u('uWpos'), ctx.wposD); g.uniform1i(tap.u('uDelaySamples'), ctx.delaySamples);
        g.uniform1f(tap.u('uDelayMix'), on ? p.delayMix : 0.0);
        g.viewport(0, 0, BLOCK, 1); drawQuad(g);
      },
    };
  },
};

const fxReverb: FxEffectDef = {
  key: 'reverb', name: 'Reverb', enableFlag: 'reverbOn',
  defaults: { reverbOn: true, reverbDecay: 0.82, reverbDamp: 0.4, reverbSend: 0.8, reverbMix: 0.26 },
  init(gl) {
    const up = createProgram(gl, FX_FDN_UPDATE);
    const tap = createProgram(gl, FX_FDN_TAP);
    gl.useProgram(up); gl.uniform1i(up.u('uMix'), 0); gl.uniform1i(up.u('uPrevFdn'), 1);
    gl.useProgram(tap); gl.uniform1i(tap.u('uIn'), 0); gl.uniform1i(tap.u('uFdn'), 1);
    let read = makeTex(gl, FDN_LEN, 4);
    let write = makeTex(gl, FDN_LEN, 4);
    return {
      reset(clear) { clear(read); clear(write); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('reverbOn');
        // 1. Update the FDN ring (decay/damp/send always run to keep the tail warm).
        g.useProgram(up);
        g.bindFramebuffer(g.FRAMEBUFFER, ctx.ringFbo);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, write, 0);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(up.u('uLenF'), FDN_LEN); g.uniform1i(up.u('uWpos'), ctx.wposF); g.uniform1i(up.u('uBlock'), BLOCK);
        g.uniform1iv(up.u('uLens[0]'), FDN_LENS);
        g.uniform1f(up.u('uDecay'), p.reverbDecay); g.uniform1f(up.u('uDamp'), p.reverbDamp); g.uniform1f(up.u('uSend'), p.reverbSend);
        g.viewport(0, 0, FDN_LEN, 4); drawQuad(g);
        [read, write] = [write, read];
        // 2. Tap + mix.
        g.useProgram(tap);
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(tap.u('uLenF'), FDN_LEN); g.uniform1i(tap.u('uWposF'), ctx.wposF);
        g.uniform1f(tap.u('uReverbMix'), on ? p.reverbMix : 0.0);
        g.viewport(0, 0, BLOCK, 1); drawQuad(g);
      },
    };
  },
};

const fxBitcrush: FxEffectDef = {
  key: 'bitcrush', name: 'Bitcrusher', enableFlag: 'bitcrushOn',
  defaults: { bitcrushOn: false, bitcrushBits: 8.0, bitcrushRate: 4000.0, bitcrushMix: 1.0 },
  init(gl) {
    const main = createProgram(gl, FX_BITCRUSH);
    const upd = createProgram(gl, FX_BITCRUSH_UPDATE);
    gl.useProgram(main); gl.uniform1i(main.u('uIn'), 0); gl.uniform1i(main.u('uPrevHold'), 1);
    gl.useProgram(upd); gl.uniform1i(upd.u('uIn'), 0);
    // 1-texel ping-pong carrying the held sample across block boundaries.
    let read = makeTex(gl, 1, 1), write = makeTex(gl, 1, 1);
    return {
      reset(clear) { clear(read); clear(write); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('bitcrushOn');
        const rate = p.bitcrushRate !== undefined ? p.bitcrushRate : 4000.0;
        // 1. Update the carry = held source value at this block's last sample.
        g.useProgram(upd);
        g.bindFramebuffer(g.FRAMEBUFFER, ctx.ringFbo);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, write, 0);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex);
        g.uniform1i(upd.u('uBlockStart'), ctx.blockStart);
        g.uniform1i(upd.u('uBlock'), BLOCK);
        g.uniform1f(upd.u('uBitcrushRate'), rate);
        g.uniform1f(upd.u('uSampleRate'), ctx.sampleRate);
        g.viewport(0, 0, 1, 1); drawQuad(g);
        // 2. Crush, reading the PREVIOUS block's carry for the boundary region.
        g.useProgram(main);
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, inTex); ctx.bind(1, read);
        g.uniform1i(main.u('uBitcrushOn'), on ? 1 : 0);
        g.uniform1i(main.u('uBlockStart'), ctx.blockStart);
        g.uniform1i(main.u('uBlock'), BLOCK);
        g.uniform1f(main.u('uBitcrushBits'), p.bitcrushBits !== undefined ? p.bitcrushBits : 8.0);
        g.uniform1f(main.u('uBitcrushRate'), rate);
        g.uniform1f(main.u('uBitcrushMix'), p.bitcrushMix !== undefined ? p.bitcrushMix : 1.0);
        g.uniform1f(main.u('uSampleRate'), ctx.sampleRate);
        g.viewport(0, 0, BLOCK, 1); drawQuad(g);
        [read, write] = [write, read];
      },
    };
  },
};

const fxWidth: FxEffectDef = {
  key: 'width', name: 'Stereo Width', enableFlag: 'widthOn',
  defaults: { widthOn: true, width: 1.15 },
  init(gl) {
    const prog = createProgram(gl, FX_WIDTH);
    gl.useProgram(prog); gl.uniform1i(prog.u('uIn'), 0);
    return {
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('widthOn');
        ctx.stereoPass(prog, inTex, outFbo);
        g.uniform1f(prog.u('uWidth'), on ? p.width : 1.0);
        drawQuad(g);
      },
    };
  },
};

// Signal-flow order matches the README chain; the master accumulate always runs
// after it. Reorder this array to rearrange the chain.
export const FX_EFFECTS: FxEffectDef[] = [
  fxDistortion, fxChorus, fxTremolo, fxDelay, fxReverb, fxBitcrush, fxWidth,
];

export const DEFAULT_FX_ORDER = FX_EFFECTS.map((e) => e.key);

// The full default param set, derived from the registry (+ chain-level fields).
export function defaultFxParams(): FxParams {
  const p: Record<string, number | boolean> = { enabled: true, master: 1.0 };
  for (const def of FX_EFFECTS) Object.assign(p, def.defaults);
  return p as unknown as FxParams;
}

// ── Generic runner ───────────────────────────────────────────────────────────

export class EffectsChain {
  gl: WebGL2RenderingContext;
  sampleRate: number;
  params: FxParams;
  order: string[];
  progMaster: GLProgram;
  scratchTex: WebGLTexture[];
  scratchFbo: (WebGLFramebuffer | null)[];
  ringFbo: WebGLFramebuffer | null;
  _fx: Record<string, FxEffectInstance>;

  constructor(gl: WebGL2RenderingContext, sampleRate: number, params: FxParams | null) {
    this.gl = gl;
    this.sampleRate = sampleRate;
    this.params = params || defaultFxParams();
    this.order = DEFAULT_FX_ORDER.slice();

    // Two BLOCK×1 ping-pong scratch buffers the chain signal flows through.
    this.scratchTex = [makeTex(gl, BLOCK, 1), makeTex(gl, BLOCK, 1)];
    this.scratchFbo = [gl.createFramebuffer(), gl.createFramebuffer()];
    for (let k = 0; k < 2; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo[k]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratchTex[k], 0);
    }
    // Scratch FBO state effects use while updating their ring textures.
    this.ringFbo = gl.createFramebuffer();

    // Terminal master accumulate.
    this.progMaster = createProgram(gl, FX_MASTER);
    gl.useProgram(this.progMaster); gl.uniform1i(this.progMaster.u('uIn'), 0);

    // Build one instance per registry effect (compiles programs + ring state).
    this._fx = {};
    for (const def of FX_EFFECTS) this._fx[def.key] = def.init(gl);

    this.reset();
  }

  // Clear all persistent ring history to silence.
  reset() {
    for (const key in this._fx) this._fx[key].reset?.((tex) => this._clear(tex));
  }

  _clear(tex: WebGLTexture) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ringFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _bind(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // An effect is live only if the whole chain is enabled AND its own switch is on.
  // A missing per-effect flag (older songs) counts as on, except bitcrush.
  _on(flag: string): boolean {
    const p = this.params as Record<string, number | boolean>;
    return !!this.params.enabled && (flag === 'bitcrushOn' ? !!p[flag] : p[flag] !== false);
  }

  _stereoPass(prog: GLProgram, inTex: WebGLTexture, outFbo: WebGLFramebuffer | null): GLProgram {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this._bind(0, inTex);
    gl.viewport(0, 0, BLOCK, 1);
    return prog;   // caller sets stage-specific uniforms before drawQuad
  }

  // Run the chain: dry stereo from mixTex flows through `this.order`, then the
  // master pass accumulates (additive) into targetFbo.
  process(mixTex: WebGLTexture, targetFbo: WebGLFramebuffer | null, blockStart: number, masterScale = 1.0) {
    const gl = this.gl, p = this.params;
    const D = Math.round(p.delayTime * this.sampleRate);
    const ctx: FxCtx = {
      gl, sampleRate: this.sampleRate, params: p, blockStart,
      ringFbo: this.ringFbo,
      wposD: ((blockStart % DELAY_LEN) + DELAY_LEN) % DELAY_LEN,
      wposF: ((blockStart % FDN_LEN) + FDN_LEN) % FDN_LEN,
      wposC: ((blockStart % CHORUS_LEN) + CHORUS_LEN) % CHORUS_LEN,
      delaySamples: Math.max(BLOCK, Math.min(DELAY_LEN - 1, D)),   // keep ≥ BLOCK for parallelism
      bind: (u, t) => this._bind(u, t),
      stereoPass: (prog, inTex, outFbo) => this._stereoPass(prog, inTex, outFbo),
      on: (flag) => this._on(flag),
    };

    gl.disable(gl.BLEND);

    let src = mixTex;
    let cur = 0;
    for (const name of this.order) {
      const fx = this._fx[name];
      if (!fx) continue;
      fx.process(ctx, src, this.scratchFbo[cur]);
      src = this.scratchTex[cur];
      cur ^= 1;
    }

    this._master(src, targetFbo, p.master * masterScale);
  }

  // Terminal accumulate: master gain + additive blend into the shared mix.
  _master(inTex: WebGLTexture, targetFbo: WebGLFramebuffer | null, masterGain: number) {
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
