// LFO invariants — including the tempo-sync phase-under-BPM regression.
//
// The bug (fixed 2026-06-08): a tempo-synced LFO computed its phase as
// songSec / lfoPeriodSec(bpm), so a mid-song BPM change retroactively rescaled the
// whole elapsed timeline → the phase jumped (audible click/lurch). The fix
// integrates phase in BEATS (`engine._songBeats`), like the row clock, so a BPM
// change only alters the FUTURE rate of accrual. These tests drive the real
// `engine._applyLfos` and assert the modulated value stays continuous across a
// mid-render tempo change.
import { test, assert, assertClose, maxStep } from './_harness.js';
import { Engine } from '../../src/tracker/engine.js';
import { TARGETS, normUnit, denormUnit } from '../../src/tracker/automation.js';
import { defaultLfo, lfoOffset, lfoPeriodSec } from '../../src/tracker/lfo.js';
import { BLOCK } from '../../src/constants.js';
import type { LfoConfig, ModRouting } from '../../src/types.js';

const VOL = TARGETS.find((t) => t.code === 'VOL')!;
const DEPTH = 0.3;

// Drive _applyLfos directly (bypassing the sequencer) with a single synced/free
// LFO routed to the global VOL target, recording the recovered normalized offset
// each block. Optionally flip BPM at `bpmChangeAt`.
function runOffsets(opts: {
  sync: boolean; rateBeats?: number; rateHz?: number;
  bpm0: number; bpm1?: number; bpmChangeAt?: number; blocks: number; sr?: number;
}): number[] {
  const sr = opts.sr ?? 48000;
  const eng = new Engine(sr);
  const src: LfoConfig = {
    shape: 0, sync: opts.sync,
    rateBeats: opts.rateBeats ?? 4, rateHz: opts.rateHz ?? 2,
    wtBank: 0, wtPos: 0,
  };
  const route: ModRouting = { source: 0, targetParamId: VOL.id, targetInstIdx: null, depth: DEPTH, bipolar: true };
  eng.lfos = [src, defaultLfo()];
  eng.modRoutings = [route];
  // Centre the VOL value so a ±DEPTH swing never clamps at 0/1.
  eng.songMaster = denormUnit(VOL, 0.5);
  eng.bpm = opts.bpm0;
  // Manually enter the "playing" state _applyLfos expects, without the sequencer.
  eng.playing = true;
  eng.startFrame = 0;
  eng._songBeats = 0;

  const offsets: number[] = [];
  for (let b = 0; b < opts.blocks; b++) {
    if (opts.bpmChangeAt !== undefined && b === opts.bpmChangeAt && opts.bpm1 !== undefined) {
      eng.bpm = opts.bpm1;
    }
    eng._applyLfos(b * BLOCK);
    offsets.push(normUnit(VOL, eng.vd.master) - 0.5);   // recover the signed LFO offset
  }
  return offsets;
}

test('lfoPeriodSec: synced period scales with beats/BPM, free-run with Hz', () => {
  const synced: LfoConfig = { ...defaultLfo(), sync: true, rateBeats: 4 };
  assertClose(lfoPeriodSec(synced, 120), 2.0, 1e-9, 'synced 4 beats @120bpm = 2s');
  assertClose(lfoPeriodSec(synced, 240), 1.0, 1e-9, 'synced 4 beats @240bpm = 1s');
  const free: LfoConfig = { ...defaultLfo(), sync: false, rateHz: 2 };
  assertClose(lfoPeriodSec(free, 120), 0.5, 1e-9, 'free 2Hz = 0.5s, BPM-independent');
  assertClose(lfoPeriodSec(free, 240), 0.5, 1e-9, 'free 2Hz unaffected by BPM');
});

test('lfoOffset: sine shape + bipolar/unipolar scaling', () => {
  const sine: LfoConfig = { ...defaultLfo(), shape: 0 };
  assertClose(lfoOffset(sine, 1, true, 0.25, 0), 1.0, 1e-9, 'bipolar sine peak at phase .25');
  assertClose(lfoOffset(sine, 1, true, 0.75, 0), -1.0, 1e-9, 'bipolar sine trough at phase .75');
  assertClose(lfoOffset(sine, 1, false, 0.25, 0), 1.0, 1e-9, 'unipolar sine peak = depth');
  assertClose(lfoOffset(sine, 1, false, 0.75, 0), 0.0, 1e-9, 'unipolar sine floor = 0');
});

test('synced LFO stays continuous across a mid-render BPM change (the regression)', () => {
  // 120 → 240 BPM at block 100. The fastest smooth per-block step is at 240 BPM:
  // beats/block = (BLOCK/SR)*(240/60); cyclePos step = that / rateBeats; the sine
  // contributes at most DEPTH·2π·(cyclePos step). A buggy retroactive rescale would
  // jolt the phase by a large fraction of a full cycle → a step near ±DEPTH.
  const blocks = 200, changeAt = 100;
  const offs = runOffsets({ sync: true, rateBeats: 4, bpm0: 120, bpm1: 240, bpmChangeAt: changeAt, blocks });
  for (const o of offs) assert(Number.isFinite(o), 'offset finite');

  const beatsPerBlock240 = (BLOCK / 48000) * (240 / 60);
  const smoothMax = DEPTH * 2 * Math.PI * (beatsPerBlock240 / 4) * 1.1;  // +10% margin
  assert(maxStep(offs) < smoothMax,
    `no phase jump: maxStep ${maxStep(offs).toFixed(5)} should be < smooth bound ${smoothMax.toFixed(5)}`);

  // The seam step (first block at the new tempo) must itself be smooth, not a jump.
  const seamStep = Math.abs(offs[changeAt] - offs[changeAt - 1]);
  assert(seamStep < smoothMax, `seam step ${seamStep.toFixed(5)} should be smooth (< ${smoothMax.toFixed(5)})`);

  // Sanity: the LFO actually moved over the run.
  assert(Math.max(...offs) - Math.min(...offs) > 0.2, 'LFO offset must span a meaningful range');
});

test('free-run LFO is unaffected by a BPM change', () => {
  const offs = runOffsets({ sync: false, rateHz: 2, bpm0: 120, bpm1: 240, bpmChangeAt: 100, blocks: 200 });
  const beatsIrrelevantStep = DEPTH * 2 * Math.PI * ((BLOCK / 48000) * 2) * 1.1;  // 2 Hz
  assert(maxStep(offs) < beatsIrrelevantStep,
    `free-run continuous regardless of tempo: maxStep ${maxStep(offs).toFixed(5)} < ${beatsIrrelevantStep.toFixed(5)}`);
});

test('LFO modulation is deterministic (export-safe)', () => {
  const a = runOffsets({ sync: true, rateBeats: 4, bpm0: 140, blocks: 64 });
  const b = runOffsets({ sync: true, rateBeats: 4, bpm0: 140, blocks: 64 });
  for (let i = 0; i < a.length; i++) assertClose(a[i], b[i], 0, `block ${i} identical across runs`);
});
