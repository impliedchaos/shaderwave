// Mod matrix — one LFO source can drive many targets simultaneously (the core
// of the matrix inversion done in 1.8.0), plus routing normalization.
import { test, assert } from './_harness.js';
import { Engine, HELD } from '../../src/tracker/engine.js';
import { TARGETS, denormUnit } from '../../src/tracker/automation.js';
import { defaultLfo, lfoOffset, lfoPeriodSec, normalizeRouting, normalizeLfo } from '../../src/tracker/lfo.js';
import { defaultInstMod } from '../../src/tracker/instmod.js';
import { neutralFxParams } from '../../src/gl/effects.js';
import { BLOCK } from '../../src/constants.js';
import type { ModRouting } from '../../src/types.js';

const VOL = TARGETS.find((t) => t.code === 'VOL')!;     // global  → vd.master
const PAN = TARGETS.find((t) => t.code === 'PAN')!;     // chan    → panAuto[ch]
const PITCH303 = TARGETS.find((t) => t.pitch && t.type === '303')!;  // inst pitch (vibrato)
const L2R = TARGETS.find((t) => t.code === 'L2R')!;     // modsrc: LFO 2 Rate
const L2M = TARGETS.find((t) => t.code === 'L2M')!;     // modsrc: LFO 2 Amount

// A minimal 303 instance carrying its OWN mod matrix, plus one held voice on it.
function makeInstEngine(): Engine {
  const eng = new Engine(48000);
  (eng as unknown as { instruments: unknown[] }).instruments = [{
    type: '303', fx: neutralFxParams(),
    p0: new Float32Array(4), p1: new Float32Array(4), p2: new Float32Array(4),
    p3: new Float32Array(4), p4: new Float32Array(4),
    mod: defaultInstMod(),
  }];
  eng.bpm = 120; eng.playing = true; eng.startFrame = 0; eng._songBeats = 0;
  const v = eng.voices[0];
  v.active = true; v.instrument = 0; v.onFrame = 0; v.offFrame = HELD; v.freq = 440;
  return eng;
}

test('one source drives two targets in the same block', () => {
  const eng = new Engine(48000);
  eng.lfos = [{ ...defaultLfo(), shape: 0, sync: true, rateBeats: 4 }, defaultLfo()];
  // Both routings read source 0; different scopes so we can observe both outputs.
  const routes: ModRouting[] = [
    { source: 0, targetParamId: VOL.id, targetInstIdx: null, depth: 0.4, bipolar: true },
    { source: 0, targetParamId: PAN.id, targetInstIdx: 0, depth: 0.4, bipolar: true },
  ];
  eng.modRoutings = routes;
  eng.songMaster = denormUnit(VOL, 0.5);
  eng.channelPan[0] = 0.5;
  eng.bpm = 120;
  eng.playing = true;
  eng.startFrame = 0;
  eng._songBeats = 0;

  // Advance a few blocks so the sine source moves off its zero crossing.
  for (let b = 0; b < 8; b++) eng._applyLfos(b * BLOCK);

  assert(Math.abs(eng.vd.master - denormUnit(VOL, 0.5)) > 1e-4, 'VOL target moved off its base');
  assert(Number.isFinite(eng.panAuto[0]) && Math.abs(eng.panAuto[0] - 0.5) > 1e-4, 'PAN target moved off its base');
});

test('a depth-0 or unassigned routing is inert', () => {
  const eng = new Engine(48000);
  eng.lfos = [{ ...defaultLfo(), shape: 0 }, defaultLfo()];
  eng.modRoutings = [
    { source: 0, targetParamId: VOL.id, targetInstIdx: null, depth: 0, bipolar: true },   // depth 0
    { source: 0, targetParamId: -1, targetInstIdx: null, depth: 0.5, bipolar: true },      // unassigned
  ];
  const base = denormUnit(VOL, 0.5);
  eng.songMaster = base;
  eng.vd.master = base;
  eng.bpm = 120; eng.playing = true; eng.startFrame = 0; eng._songBeats = 0;
  for (let b = 0; b < 8; b++) eng._applyLfos(b * BLOCK);
  assert(eng.vd.master === base, 'inert routings leave the target untouched');
});

test('fx-scope LFO re-centres on a live edit of the targeted param', () => {
  // Regression: an fx-scope LFO (e.g. on FX Level) used to FREEZE its centre at the
  // play-start snapshot, so dragging the volume/cutoff knob while playing did nothing
  // (the LFO clobbered it every block, always centred on the old value). It must
  // re-baseline when the field is edited externally.
  const LVL = TARGETS.find((t) => t.code === 'LVL')!;   // FX Level, fx 'master', 0..2
  const eng = new Engine(48000) as unknown as {
    instruments: { type: string; fx: Record<string, number | boolean>; p0: Float32Array; p1: Float32Array }[];
    lfos: unknown[]; modRoutings: ModRouting[]; bpm: number; playing: boolean;
    startFrame: number; _songBeats: number; _applyLfos(b: number): void;
  };
  eng.instruments = [{ type: '303', fx: neutralFxParams() as unknown as Record<string, number | boolean>, p0: new Float32Array(4), p1: new Float32Array(4) }];
  eng.lfos = [{ ...defaultLfo(), shape: 0, sync: true, rateBeats: 1 }, defaultLfo(), defaultLfo(), defaultLfo()];
  eng.modRoutings = [{ source: 0, targetParamId: LVL.id, targetInstIdx: 0, depth: 0.3, bipolar: true }];
  eng.bpm = 120; eng.playing = true; eng.startFrame = 0; eng._songBeats = 0;

  eng.instruments[0].fx.master = 0;                 // volume 0 at play-start (snapshot captures 0)
  for (let b = 0; b < 5; b++) eng._applyLfos(b * BLOCK);
  eng.instruments[0].fx.master = 1.0;               // user drags volume to 1.0 mid-playback

  const vals: number[] = [];
  for (let b = 5; b < 60; b++) { eng._applyLfos(b * BLOCK); vals.push(eng.instruments[0].fx.master as number); }
  const mn = Math.min(...vals), mx = Math.max(...vals);
  assert(mx > 1.05, `LFO must swing ABOVE the new 1.0 base after a live edit (max ${mx.toFixed(3)})`);
  assert(mn < 0.95, `LFO must swing BELOW the new 1.0 base after a live edit (min ${mn.toFixed(3)})`);
});

test('routing/LFO normalization fills partial records', () => {
  const r = normalizeRouting({ targetParamId: 5 });
  assert(r.source === 0 && r.depth === 0 && r.bipolar === true && r.targetInstIdx === null,
    'partial routing defaults');
  const l = normalizeLfo({ shape: 2 });
  assert(l.shape === 2 && l.sync === true && l.rateBeats === 4 && l.rateHz === 1, 'partial LFO defaults');
  // Undefined → full default (must never throw).
  assert(normalizeRouting(undefined).targetParamId === -1, 'undefined routing → default off');
});

// ── modsrc: per-instrument sources as modulation TARGETS ─────────────────────

test('env → LFO Amount gives a vibrato fade-in', () => {
  const eng = makeInstEngine();
  const mod = defaultInstMod();
  mod.sources[1].lfo = { ...defaultLfo(), sync: false, rateHz: 8, shape: 0 };  // fast vibrato LFO
  mod.sources[1].amount = 0;                                                    // silent until the env opens it
  mod.sources[2].env = { a: 1.0, d: 0.1, s: 1, r: 0.2 };                        // ~1s attack swell
  mod.routes = [
    { source: 2, targetParamId: L2M.id, depth: 0.5, bipolar: false, invert: false },  // env → LFO2 Amount
    { source: 1, targetParamId: PITCH303.id, depth: 1, bipolar: true, invert: false }, // LFO2 → pitch
  ];
  (eng.instruments[0] as unknown as { mod: typeof mod }).mod = mod;

  let earlyMax = 0, lateMax = 0, allFinite = true;
  for (let b = 0; b < 160; b++) {
    eng.vd.freq[0] = 440;                         // pitch routes MULTIPLY vd.freq
    eng._applyInstMod(b * BLOCK);
    const dev = Math.abs(eng.vd.freq[0] - 440);
    if (!Number.isFinite(eng.vd.freq[0])) allFinite = false;
    if (b < 2) earlyMax = Math.max(earlyMax, dev);   // env still ~0 (one-block latency from rest)
    if (b >= 120) lateMax = Math.max(lateMax, dev);  // env at sustain → vibrato wide open
  }
  assert(allFinite, 'vd.freq stays finite throughout');
  assert(earlyMax < 5, `vibrato near zero before the env opens (early max ${earlyMax.toFixed(2)} Hz)`);
  assert(lateMax > 40, `vibrato is wide after the env opens (late max ${lateMax.toFixed(2)} Hz)`);
  assert(lateMax > earlyMax * 8, 'the env clearly fades the vibrato in');
});

test('LFO → LFO Rate changes the modulated LFO\'s cadence', () => {
  const run = (withRateRoute: boolean) => {
    const eng = makeInstEngine();
    const mod = defaultInstMod();
    mod.sources[0].lfo = { ...defaultLfo(), sync: false, rateHz: 1, shape: 0 };  // slow modulator
    mod.sources[1].lfo = { ...defaultLfo(), sync: false, rateHz: 8, shape: 0 };  // the carrier vibrato
    mod.routes = [
      { source: 1, targetParamId: PITCH303.id, depth: 1, bipolar: true, invert: false },
      ...(withRateRoute ? [{ source: 0, targetParamId: L2R.id, depth: 1, bipolar: false, invert: false }] : []),
    ];
    (eng.instruments[0] as unknown as { mod: typeof mod }).mod = mod;
    const out: number[] = [];
    for (let b = 0; b < 60; b++) { eng.vd.freq[0] = 440; eng._applyInstMod(b * BLOCK); out.push(eng.vd.freq[0]); }
    return out;
  };
  const base = run(false), modded = run(true);
  const finite = base.every(Number.isFinite) && modded.every(Number.isFinite);
  const maxDiff = Math.max(...base.map((v, i) => Math.abs(v - modded[i])));
  assert(finite, 'both runs stay finite');
  assert(maxDiff > 1, `modulating LFO 2's rate changes its output (maxDiff ${maxDiff.toFixed(2)} Hz)`);
});

test('global LFO → a per-instrument LFO Rate reaches into the instance', () => {
  const run = (withGlobal: boolean) => {
    const eng = makeInstEngine();
    const mod = defaultInstMod();
    mod.sources[1].lfo = { ...defaultLfo(), sync: false, rateHz: 8, shape: 0 };
    mod.routes = [{ source: 1, targetParamId: PITCH303.id, depth: 1, bipolar: true, invert: false }];
    (eng.instruments[0] as unknown as { mod: typeof mod }).mod = mod;
    eng.lfos = [{ ...defaultLfo(), sync: false, rateHz: 1, shape: 0 }, defaultLfo(), defaultLfo(), defaultLfo()];
    eng.modRoutings = withGlobal
      ? [{ source: 0, targetParamId: L2R.id, targetInstIdx: 0, depth: 1, bipolar: false, invert: false }]
      : [];
    const out: number[] = [];
    for (let b = 0; b < 60; b++) {
      eng.vd.freq[0] = 440;
      eng._applyInstMod(b * BLOCK);   // resolves the source (incl. global modsrc routings)
      eng._applyLfos(b * BLOCK);      // advances the song-beat clock; skips modsrc itself
      out.push(eng.vd.freq[0]);
    }
    return out;
  };
  const base = run(false), modded = run(true);
  const finite = base.every(Number.isFinite) && modded.every(Number.isFinite);
  const maxDiff = Math.max(...base.map((v, i) => Math.abs(v - modded[i])));
  assert(finite, 'both runs stay finite');
  assert(maxDiff > 1, `the global LFO measurably bends instrument 0's own LFO rate (maxDiff ${maxDiff.toFixed(2)} Hz)`);
});

test('an instance with NO modsrc route matches the closed-form LFO exactly (bit-identical path)', () => {
  const eng = makeInstEngine();
  const mod = defaultInstMod();
  const cfg = { ...defaultLfo(), sync: false, rateHz: 3, shape: 0 };
  mod.sources[0].lfo = cfg;                       // amount stays default 1
  mod.routes = [{ source: 0, targetParamId: PITCH303.id, depth: 0.5, bipolar: true, invert: false }];
  (eng.instruments[0] as unknown as { mod: typeof mod }).mod = mod;

  const b = 5;
  eng.vd.freq[0] = 440;
  eng._applyInstMod(b * BLOCK);
  // Reference = the pre-modsrc closed-form: a shared free-run LFO sampled at song time.
  const songSec = (b * BLOCK) / 48000;
  const cyclePos = songSec / lfoPeriodSec(cfg, 120);
  const off = lfoOffset(cfg, 0.5, true, cyclePos - Math.floor(cyclePos), Math.floor(cyclePos));
  const expected = 440 * Math.pow(2, off * PITCH303.max / 12);
  // vd.freq is a Float32Array, so the reference must be rounded to f32 too — then
  // the closed-form path must match EXACTLY (this is the bit-identical guarantee).
  assert(eng.vd.freq[0] === Math.fround(expected), `closed-form path unchanged (got ${eng.vd.freq[0]}, expected ${Math.fround(expected)})`);
});
