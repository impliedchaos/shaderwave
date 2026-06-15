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
import FX_OVERDRIVE from './shaders/fx-overdrive.glsl?raw';
import FX_CHORUS_UPDATE from './shaders/fx-chorus-update.glsl?raw';
import FX_CHORUS_TAP from './shaders/fx-chorus-tap.glsl?raw';
import FX_TREMOLO from './shaders/fx-tremolo.glsl?raw';
import FX_DELAY_UPDATE from './shaders/fx-delay-update.glsl?raw';
import FX_DELAY_TAP from './shaders/fx-delay-tap.glsl?raw';
import FX_FDN_UPDATE from './shaders/fx-fdn-update.glsl?raw';
import FX_FDN_TAP from './shaders/fx-fdn-tap.glsl?raw';
import FX_BITCRUSH from './shaders/fx-bitcrush.glsl?raw';
import FX_BITCRUSH_UPDATE from './shaders/fx-bitcrush-update.glsl?raw';
import FX_FILTER from './shaders/fx-filter.glsl?raw';
import FX_EQ from './shaders/fx-eq.glsl?raw';
import FX_VOCODER from './shaders/fx-vocoder.glsl?raw';
import FX_VOCODER_SUM from './shaders/fx-vocoder-sum.glsl?raw';
import FX_DYNAMICS from './shaders/fx-dynamics.glsl?raw';
import FX_WIDTH from './shaders/fx-width.glsl?raw';
import FX_MASTER from './shaders/fx-master.glsl?raw';

// Strip width for per-sample-recursive effects (the resonant filter). Mirrors the
// synth renderer's subBlock: smaller = fewer redundant recomputes but more draws.
const FX_SUB = 64;

// Vocoder: max band count (sizes the GLSL coeff arrays) + a speech-focused
// log-spaced band-center range. The band/state textures get ONE extra row for the
// unvoiced (sibilance) detector. VOC_UV_* are the detector's low/high split corners.
const MAX_VOC_BANDS = 16;
const VOC_TEX_ROWS = MAX_VOC_BANDS + 1;        // +1 = the unvoiced detector row
const VOC_FLO = 180, VOC_FHI = 7500;
const VOC_UV_LO = 700, VOC_UV_HI = 3500;

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
  instDryTex?: WebGLTexture | null;   // all instances' mixed dry signals
  instIdx?: number;                   // current instrument instance index
  bind(unit: number, tex: WebGLTexture): void;
  stereoPass(prog: GLProgram, inTex: WebGLTexture, outFbo: WebGLFramebuffer | null): GLProgram;
  // Per-sample recursive strip pass (filter etc.). `prog` must already be in use
  // with its block-constant uniforms set; this drives the strip loop, binding uIn
  // (unit 0) + uPrevState (unit 1), writing outColor → outFbo attachment 0 and
  // outState → the ping-pong state texture (attachment 1). Returns the swapped
  // [read, write] state textures for the caller to persist across blocks.
  recursive(prog: GLProgram, inTex: WebGLTexture, outFbo: WebGLFramebuffer | null,
            stateRead: WebGLTexture, stateWrite: WebGLTexture): [WebGLTexture, WebGLTexture];
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

const fxOverdrive: FxEffectDef = {
  key: 'overdrive', name: 'Overdrive', enableFlag: 'odOn',
  defaults: { odOn: false, odDrive: 4.0, odTone: 0.55, odLevel: 1.0 },
  init(gl) {
    const prog = createProgram(gl, FX_OVERDRIVE);
    gl.useProgram(prog); gl.uniform1i(prog.u('uIn'), 0);
    return {
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('odOn');
        ctx.stereoPass(prog, inTex, outFbo);
        g.uniform1i(prog.u('uOdOn'), on ? 1 : 0);
        g.uniform1f(prog.u('uOdDrive'), p.odDrive ?? 4.0);
        g.uniform1f(prog.u('uOdTone'), p.odTone ?? 0.55);
        g.uniform1f(prog.u('uOdLevel'), p.odLevel ?? 1.0);
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

const fxFilter: FxEffectDef = {
  key: 'filter', name: 'Filter', enableFlag: 'filterOn',
  defaults: { filterOn: false, filterCutoff: 2000.0, filterReso: 0.2, filterMode: 0, filterMix: 1.0 },
  init(gl) {
    const prog = createProgram(gl, FX_FILTER);
    gl.useProgram(prog); gl.uniform1i(prog.u('uIn'), 0); gl.uniform1i(prog.u('uPrevState'), 1);
    // Per-sample filter state, carried across blocks (ping-pong, cleared on reset).
    let read = makeTex(gl, BLOCK, 1), write = makeTex(gl, BLOCK, 1);
    return {
      reset(clear) { clear(read); clear(write); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('filterOn');
        g.useProgram(prog);
        g.uniform1i(prog.u('uMode'), Math.round((p.filterMode as number) ?? 0));
        if (!on) {
          // Cheap O(BLOCK) bypass — pass the dry signal through, leave state frozen.
          g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
          g.drawBuffers([g.COLOR_ATTACHMENT0]);
          ctx.bind(0, inTex);
          g.uniform1i(prog.u('uBypass'), 1);
          g.viewport(0, 0, BLOCK, 1); drawQuad(g);
          return;
        }
        // TPT-SVF coefficients (block-rate; cutoff/reso are LFO/automation-swept).
        const fc = Math.max(20, Math.min(ctx.sampleRate * 0.45, (p.filterCutoff as number) ?? 2000));
        const Q = 0.5 * Math.pow(36, (p.filterReso as number) ?? 0.2);   // ~0.5 .. ~18
        const k = 1 / Q;
        const gco = Math.tan(Math.PI * fc / ctx.sampleRate);
        const a1 = 1 / (1 + gco * (gco + k));
        g.uniform1i(prog.u('uBypass'), 0);
        g.uniform1f(prog.u('uA1'), a1);
        g.uniform1f(prog.u('uA2'), gco * a1);
        g.uniform1f(prog.u('uA3'), gco * gco * a1);
        g.uniform1f(prog.u('uK'), k);
        g.uniform1f(prog.u('uMix'), (p.filterMix as number) ?? 1.0);
        [read, write] = ctx.recursive(prog, inTex, outFbo, read, write);
      },
    };
  },
};

const fxEq: FxEffectDef = {
  key: 'eq', name: 'Equalizer', enableFlag: 'eqOn',
  defaults: { eqOn: false, eqLow: 0, eqMid: 0, eqHigh: 0, eqLowFreq: 200, eqHighFreq: 3000 },
  init(gl) {
    const prog = createProgram(gl, FX_EQ);
    gl.useProgram(prog); gl.uniform1i(prog.u('uIn'), 0); gl.uniform1i(prog.u('uPrevState'), 1);
    let read = makeTex(gl, BLOCK, 1), write = makeTex(gl, BLOCK, 1);
    return {
      reset(clear) { clear(read); clear(write); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params, on = ctx.on('eqOn');
        g.useProgram(prog);
        if (!on) {
          g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
          g.drawBuffers([g.COLOR_ATTACHMENT0]);
          ctx.bind(0, inTex);
          g.uniform1i(prog.u('uBypass'), 1);
          g.viewport(0, 0, BLOCK, 1); drawQuad(g);
          return;
        }

        const fl = Math.max(20, Math.min(ctx.sampleRate * 0.45, (p.eqLowFreq as number) ?? 200));
        const fh = Math.max(200, Math.min(ctx.sampleRate * 0.45, (p.eqHighFreq as number) ?? 3000));

        const gL = Math.tan(Math.PI * fl / ctx.sampleRate);
        const aL = 1 / (1 + gL);
        const gH = Math.tan(Math.PI * fh / ctx.sampleRate);
        const aH = 1 / (1 + gH);

        g.uniform1i(prog.u('uBypass'), 0);
        g.uniform1f(prog.u('uGLow'), gL);
        g.uniform1f(prog.u('uALow'), aL);
        g.uniform1f(prog.u('uGHigh'), gH);
        g.uniform1f(prog.u('uAHigh'), aH);

        g.uniform1f(prog.u('uLowGain'), dbToLin((p.eqLow as number) ?? 0));
        g.uniform1f(prog.u('uMidGain'), dbToLin((p.eqMid as number) ?? 0));
        g.uniform1f(prog.u('uHighGain'), dbToLin((p.eqHigh as number) ?? 0));

        [read, write] = ctx.recursive(prog, inTex, outFbo, read, write);
      },
    };
  },
};

// Compressor + Limiter share one per-sample recursive envelope follower
// (fx-dynamics.glsl via ctx.recursive). They differ only in how their params map
// to the shader's threshold/slope/coefficients, so a small factory builds both.
// `coeffs(p, sr)` returns the per-block uniforms; `on` is the live enable flag.
type DynCoeffs = { threshLin: number; slope: number; atkCoef: number; relCoef: number; makeup: number };
function makeDynamics(def: {
  key: string; name: string; enableFlag: string; defaults: Partial<FxParams>;
  coeffs: (p: FxParams, sr: number) => DynCoeffs;
}): FxEffectDef {
  return {
    key: def.key, name: def.name, enableFlag: def.enableFlag, defaults: def.defaults,
    init(gl) {
      const prog = createProgram(gl, FX_DYNAMICS);
      gl.useProgram(prog);
      gl.uniform1i(prog.u('uIn'), 0);
      gl.uniform1i(prog.u('uPrevState'), 1);
      const uKeyTex = prog.u('uKeyTex');
      if (uKeyTex) gl.uniform1i(uKeyTex, 2);
      let read = makeTex(gl, BLOCK, 1), write = makeTex(gl, BLOCK, 1);   // envelope carry
      return {
        reset(clear) { clear(read); clear(write); },
        process(ctx, inTex, outFbo) {
          const g = ctx.gl;
          g.useProgram(prog);
          if (!ctx.on(def.enableFlag)) {
            g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
            g.drawBuffers([g.COLOR_ATTACHMENT0]);
            ctx.bind(0, inTex);
            g.uniform1i(prog.u('uBypass'), 1);
            g.viewport(0, 0, BLOCK, 1); drawQuad(g);
            return;
          }
          const c = def.coeffs(ctx.params, ctx.sampleRate);
          g.uniform1i(prog.u('uBypass'), 0);
          g.uniform1f(prog.u('uAtkCoef'), c.atkCoef);
          g.uniform1f(prog.u('uRelCoef'), c.relCoef);
          g.uniform1f(prog.u('uThreshLin'), c.threshLin);
          g.uniform1f(prog.u('uSlope'), c.slope);
          g.uniform1f(prog.u('uMakeup'), c.makeup);

          // Sidechain uniform binding
          const keySrc = (ctx.params.compSource !== undefined && def.key === 'compressor') ? ctx.params.compSource : -1;
          if (keySrc >= 0 && ctx.instDryTex) {
            ctx.bind(2, ctx.instDryTex);
            g.uniform1i(prog.u('uKeyRow'), keySrc);
          } else {
            g.uniform1i(prog.u('uKeyRow'), -1);
          }

          [read, write] = ctx.recursive(prog, inTex, outFbo, read, write);
        },
      };
    },
  };
}

// One-pole smoothing coefficient for a time constant in milliseconds.
const msCoef = (ms: number, sr: number) => 1 - Math.exp(-1 / (Math.max(0.05, ms) / 1000 * sr));
const dbToLin = (db: number) => Math.pow(10, db / 20);

const fxCompressor = makeDynamics({
  key: 'compressor', name: 'Compressor', enableFlag: 'compOn',
  defaults: { compOn: false, compThresh: -18, compRatio: 3, compAttack: 10, compRelease: 120, compMakeup: 0, compSource: -1 },
  coeffs(p, sr) {
    return {
      threshLin: dbToLin((p.compThresh as number) ?? -18),
      slope: 1 - 1 / Math.max(1, (p.compRatio as number) ?? 3),
      atkCoef: msCoef((p.compAttack as number) ?? 10, sr),
      relCoef: msCoef((p.compRelease as number) ?? 120, sr),
      makeup: dbToLin((p.compMakeup as number) ?? 0),
    };
  },
});

const fxLimiter = makeDynamics({
  key: 'limiter', name: 'Limiter', enableFlag: 'limitOn',
  defaults: { limitOn: false, limitCeil: -1, limitRelease: 80 },
  coeffs(p, sr) {
    return {
      threshLin: dbToLin((p.limitCeil as number) ?? -1),
      slope: 1.0,                       // ∞ ratio → brick wall to the ceiling
      atkCoef: msCoef(0.3, sr),         // fixed fast attack (transparent peak catch)
      relCoef: msCoef((p.limitRelease as number) ?? 80, sr),
      makeup: 1.0,
    };
  },
});

// Channel vocoder. Carrier = the insert signal (uIn); modulator = the sidechain dry
// bus (ctx.instDryTex) at row `vocSource`, the SAME mechanism the sidechain
// compressor keys off. Two passes: (1) analysis/synthesis renders a BLOCK×bands
// intermediate (band b = row b) per-sample-recursive in strips, MRT carrying the
// carrier + modulator filter state and the envelope across strips/blocks; (2) the
// sum pass collapses the rows + dry/wet into the BLOCK×1 output. The multi-attachment
// recursive work happens on the vocoder's OWN bandFbo, so the chain's shared scratch
// FBO is never left multi-attached.
const fxVocoder: FxEffectDef = {
  key: 'vocoder', name: 'Vocoder', enableFlag: 'vocoderOn',
  defaults: { vocoderOn: false, vocSource: -1, vocBands: 16, vocQ: 4, vocAttack: 2, vocRelease: 18, vocMix: 1.0, vocUnvoiced: 0.5 },
  init(gl) {
    const prog = createProgram(gl, FX_VOCODER);
    gl.useProgram(prog);
    gl.uniform1i(prog.u('uIn'), 0);
    gl.uniform1i(prog.u('uPrevStateA'), 1);
    gl.uniform1i(prog.u('uPrevStateB'), 2);
    const uKey = prog.u('uKeyTex'); if (uKey) gl.uniform1i(uKey, 5);   // unit 5: units 3/4 are the permanently-bound wavetable/sampler atlases
    const sum = createProgram(gl, FX_VOCODER_SUM);
    gl.useProgram(sum);
    gl.uniform1i(sum.u('uBandTex'), 0);
    gl.uniform1i(sum.u('uDry'), 1);

    const bandTex = makeTex(gl, BLOCK, VOC_TEX_ROWS);
    const bandFbo = gl.createFramebuffer();
    // Per-row recursive state, carried across blocks (ping-pong, cleared on reset).
    // VOC_TEX_ROWS = bands + the unvoiced detector row.
    let aR = makeTex(gl, BLOCK, VOC_TEX_ROWS), aW = makeTex(gl, BLOCK, VOC_TEX_ROWS);   // carrier SVF / uv detector
    let bR = makeTex(gl, BLOCK, VOC_TEX_ROWS), bW = makeTex(gl, BLOCK, VOC_TEX_ROWS);   // modulator SVF + env
    const a1 = new Float32Array(MAX_VOC_BANDS), a2 = new Float32Array(MAX_VOC_BANDS);
    const a3 = new Float32Array(MAX_VOC_BANDS), kk = new Float32Array(MAX_VOC_BANDS);
    return {
      reset(clear) { clear(aR); clear(aW); clear(bR); clear(bW); },
      process(ctx, inTex, outFbo) {
        const g = ctx.gl, p = ctx.params;
        const bands = Math.max(1, Math.min(MAX_VOC_BANDS, Math.round((p.vocBands as number) ?? 8)));
        const src = p.vocSource !== undefined ? Math.round(p.vocSource as number) : -1;
        const on = ctx.on('vocoderOn') && src >= 0 && !!ctx.instDryTex;

        // Off / no modulator selected → cheap dry passthrough via the sum shader.
        if (!on) {
          g.useProgram(sum);
          g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
          g.drawBuffers([g.COLOR_ATTACHMENT0]);
          ctx.bind(1, inTex);                          // uDry
          g.uniform1i(sum.u('uBypass'), 1);
          g.viewport(0, 0, BLOCK, 1); drawQuad(g);
          return;
        }

        // Per-band TPT-SVF coefficients: constant-Q, log-spaced centers (the bank).
        const sr = ctx.sampleRate;
        const Q = Math.max(0.5, (p.vocQ as number) ?? 4);
        const k = 1 / Q;
        for (let b = 0; b < bands; b++) {
          const t = bands > 1 ? b / (bands - 1) : 0;
          const fc = Math.max(20, Math.min(sr * 0.45, VOC_FLO * Math.pow(VOC_FHI / VOC_FLO, t)));
          const gco = Math.tan(Math.PI * fc / sr);
          const aa1 = 1 / (1 + gco * (gco + k));
          a1[b] = aa1; a2[b] = gco * aa1; a3[b] = gco * gco * aa1; kk[b] = k;
        }

        // Unvoiced detector coefficients (fixed split corners + fast envelopes).
        const uvLp = (fc: number) => Math.tan(Math.PI * Math.min(sr * 0.45, fc) / sr);
        const gLo = uvLp(VOC_UV_LO), gHi = uvLp(VOC_UV_HI);

        // 1. Analysis/synthesis — recursive strips, MRT (row signal + 2 state texels),
        //    rendered over BLOCK×(bands+1) into the vocoder's private bandFbo. The
        //    extra row (index = bands) is the unvoiced/sibilance detector.
        const rows = bands + 1;
        g.useProgram(prog);
        g.bindFramebuffer(g.FRAMEBUFFER, bandFbo);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, bandTex, 0);
        g.uniform1i(prog.u('uBlock'), BLOCK);
        g.uniform1i(prog.u('uBands'), bands);
        g.uniform1i(prog.u('uKeyRow'), src);
        g.uniform1fv(prog.u('uA1[0]'), a1);
        g.uniform1fv(prog.u('uA2[0]'), a2);
        g.uniform1fv(prog.u('uA3[0]'), a3);
        g.uniform1fv(prog.u('uK[0]'), kk);
        g.uniform1f(prog.u('uAtk'), msCoef((p.vocAttack as number) ?? 2, sr));
        g.uniform1f(prog.u('uRel'), msCoef((p.vocRelease as number) ?? 18, sr));
        g.uniform1f(prog.u('uUvGLo'), gLo);
        g.uniform1f(prog.u('uUvALo'), 1 / (1 + gLo));
        g.uniform1f(prog.u('uUvGHi'), gHi);
        g.uniform1f(prog.u('uUvAHi'), 1 / (1 + gHi));
        g.uniform1f(prog.u('uUvAtk'), msCoef(1.5, sr));
        g.uniform1f(prog.u('uUvRel'), msCoef(12, sr));
        g.uniform1f(prog.u('uUvThr'), 0.45);
        for (let o = 0; o < BLOCK; o += FX_SUB) {
          g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT1, g.TEXTURE_2D, aW, 0);
          g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT2, g.TEXTURE_2D, bW, 0);
          g.drawBuffers([g.COLOR_ATTACHMENT0, g.COLOR_ATTACHMENT1, g.COLOR_ATTACHMENT2]);
          ctx.bind(0, inTex);
          ctx.bind(1, aR);
          ctx.bind(2, bR);
          ctx.bind(5, ctx.instDryTex!);
          g.uniform1i(prog.u('uSubOffset'), o);
          g.viewport(o, 0, FX_SUB, rows);
          drawQuad(g);
          [aR, aW] = [aW, aR];
          [bR, bW] = [bW, bR];
        }
        // Detach the state targets so bandFbo is single-attachment again (hygiene
        // against the next use inheriting stray draw buffers).
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT1, g.TEXTURE_2D, null, 0);
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT2, g.TEXTURE_2D, null, 0);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);

        // 2. Sum bands + dry/wet → outFbo (BLOCK×1, single attachment).
        g.useProgram(sum);
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.drawBuffers([g.COLOR_ATTACHMENT0]);
        ctx.bind(0, bandTex);
        ctx.bind(1, inTex);
        g.uniform1i(sum.u('uBands'), bands);
        g.uniform1i(sum.u('uBypass'), 0);
        g.uniform1f(sum.u('uLevel'), 2.0);              // fixed makeup (band-split drops level)
        g.uniform1f(sum.u('uMix'), (p.vocMix as number) ?? 1.0);
        g.uniform1f(sum.u('uUvMix'), Math.max(0, Math.min(1, (p.vocUnvoiced as number) ?? 0.5)));
        g.viewport(0, 0, BLOCK, 1); drawQuad(g);
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
  fxCompressor, fxFilter, fxEq, fxVocoder, fxOverdrive, fxDistortion, fxChorus, fxTremolo, fxDelay, fxReverb, fxBitcrush, fxWidth, fxLimiter,
];

export const DEFAULT_FX_ORDER = FX_EFFECTS.map((e) => e.key);

// Reconcile a (possibly stale / hand-edited) per-instance chain order with the
// current registry: keep the listed known keys in their given order, drop unknown
// ones, then APPEND any registry keys the list is missing (in DEFAULT order). This
// is what keeps a newly-added effect from silently vanishing from a saved song's
// chain — every effect always runs, just maybe at the end.
export function normalizeFxOrder(order: string[] | undefined): string[] {
  const known = new Set(DEFAULT_FX_ORDER);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of order ?? []) {
    if (known.has(k) && !seen.has(k)) { out.push(k); seen.add(k); }
  }
  for (const k of DEFAULT_FX_ORDER) if (!seen.has(k)) out.push(k);
  return out;
}

// The full default param set, derived from the registry (+ chain-level fields).
export function defaultFxParams(): FxParams {
  const p: Record<string, number | boolean> = { enabled: true, master: 1.0 };
  for (const def of FX_EFFECTS) Object.assign(p, def.defaults);
  return p as unknown as FxParams;
}

// FX for a freshly-added instrument: a clean slate. Every effect switched OFF and
// its knobs at neutral/unity, so toggling one on starts transparent. (defaultFxParams
// stays the song-authoring baseline; only `+ Add` uses this.)
export function neutralFxParams(): FxParams {
  const p = defaultFxParams();
  p.distOn = p.odOn = p.filterOn = p.eqOn = p.vocoderOn = p.compOn = p.limitOn = p.chorusOn = p.tremoloOn = p.delayOn = p.reverbOn = p.widthOn = p.bitcrushOn = false;
  p.dist = 0;                         // distortion drive → transparent
  p.odDrive = 1; p.odTone = 0.5;      // overdrive: unity drive, centre tone
  p.eqLow = p.eqMid = p.eqHigh = 0;   // EQ gains → neutral 0 dB
  p.delayMix = 0; p.reverbMix = 0; p.bitcrushMix = 0;
  p.width = 1.0;                      // unity stereo width
  return p;
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
    // Newer opt-in effects (bitcrush, overdrive) default OFF when the flag is
    // absent (truthy test); the original effects default ON (!== false).
    const optIn = flag === 'bitcrushOn' || flag === 'odOn' || flag === 'filterOn' || flag === 'compOn' || flag === 'limitOn' || flag === 'eqOn' || flag === 'vocoderOn';
    return !!this.params.enabled && (optIn ? !!p[flag] : p[flag] !== false);
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

  // Per-sample recursive strip pass (mirrors SynthRenderer's ladder loop). Renders
  // the block in FX_SUB-wide strips, ping-ponging the state texture between them
  // (and persisting the final pair across blocks via the returned tuple). MRT:
  // attachment 0 = outFbo's signal texture (viewport-restricted per strip),
  // attachment 1 = the state texture written this strip. `prog` is already in use
  // with its block-constant uniforms set; uIn (unit 0) + uPrevState (unit 1) and
  // uBlock/uSubOffset are set here.
  _recursive(prog: GLProgram, inTex: WebGLTexture, outFbo: WebGLFramebuffer | null,
             read: WebGLTexture, write: WebGLTexture): [WebGLTexture, WebGLTexture] {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.uniform1i(prog.u('uBlock'), BLOCK);
    for (let o = 0; o < BLOCK; o += FX_SUB) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, write, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this._bind(0, inTex);
      this._bind(1, read);
      gl.uniform1i(prog.u('uSubOffset'), o);
      gl.viewport(o, 0, FX_SUB, 1);
      drawQuad(gl);
      [read, write] = [write, read];   // next strip reads what we just wrote
    }
    // Detach the state target so the shared scratch FBO is single-attachment again.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    return [read, write];
  }

  // Run the chain: dry stereo from mixTex flows through `this.order`, then the
  // master pass accumulates (additive) into targetFbo.
  process(mixTex: WebGLTexture, targetFbo: WebGLFramebuffer | null, blockStart: number, masterScale = 1.0, instDryTex: WebGLTexture | null = null, instIdx = -1) {
    const gl = this.gl, p = this.params;
    const D = Math.round(p.delayTime * this.sampleRate);
    const ctx: FxCtx = {
      gl, sampleRate: this.sampleRate, params: p, blockStart,
      ringFbo: this.ringFbo,
      wposD: ((blockStart % DELAY_LEN) + DELAY_LEN) % DELAY_LEN,
      wposF: ((blockStart % FDN_LEN) + FDN_LEN) % FDN_LEN,
      wposC: ((blockStart % CHORUS_LEN) + CHORUS_LEN) % CHORUS_LEN,
      delaySamples: Math.max(BLOCK, Math.min(DELAY_LEN - 1, D)),   // keep ≥ BLOCK for parallelism
      instDryTex,
      instIdx,
      bind: (u, t) => this._bind(u, t),
      stereoPass: (prog, inTex, outFbo) => this._stereoPass(prog, inTex, outFbo),
      recursive: (prog, inTex, outFbo, r, w) => this._recursive(prog, inTex, outFbo, r, w),
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
