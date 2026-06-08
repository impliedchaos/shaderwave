// Automation registry invariants — id stability (persisted in patterns, so the
// table is append-only) and the norm/denorm round-trips that LFOs + MIDI rely on.
import { test, assert, assertEq, assertClose } from './_harness.js';
import {
  TARGETS, targetById, targetByCode, denorm, normByte, normUnit, denormUnit,
} from '../../src/tracker/automation.js';

test('target ids are contiguous and self-consistent', () => {
  for (let i = 0; i < TARGETS.length; i++) assertEq(TARGETS[i].id, i, `TARGETS[${i}].id`);
});

test('inst block is frozen to 303 first (historical AUTO_ORDER)', () => {
  // Target id 0 must remain a 303 inst param — ids are persisted in saved/demo
  // patterns, so this anchor must never drift. (MEMORY: 303 occupies the low ids.)
  const t0 = targetById(0)!;
  assertEq(t0.scope, 'inst', 'target 0 scope');
  assertEq(t0.type, '303', 'target 0 engine');
});

test('fx / chan / global targets resolve and sit after the inst block', () => {
  const vol = targetByCode('303', 'VOL')!;
  const pan = targetByCode('303', 'PAN')!;
  const bpm = targetByCode('303', 'BPM')!;
  assertEq(vol.scope, 'global', 'VOL scope');
  assertEq(pan.scope, 'chan', 'PAN scope');
  assertEq(bpm.scope, 'global', 'BPM scope');
  // The first inst target precedes every fx/chan/global one.
  const firstInst = TARGETS.findIndex((t) => t.scope === 'inst');
  assert(firstInst >= 0 && firstInst < vol.id, 'inst targets precede globals');
});

test('toggle targets are boolean-ish (byte 0 = off, ≥1 = on)', () => {
  const distOn = targetByCode('303', 'DSO')!;
  assert(distOn.toggle === true, 'DSO is a toggle');
  assertEq(denorm(distOn, 0), 0, 'byte 0 → off');
  assertEq(denorm(distOn, 1), 1, 'byte 1 → on');
  assertEq(denorm(distOn, 255), 1, 'byte 255 → on');
  assertEq(normByte(distOn, 0), 0, 'off → byte 0');
  assertEq(normByte(distOn, 1), 255, 'on → byte 255');
});

test('resonant filter fx targets resolve (cutoff log, mix lin, on toggle)', () => {
  const flc = targetByCode('303', 'FLC')!, flr = targetByCode('303', 'FLR')!;
  const flm = targetByCode('303', 'FLM')!, flo = targetByCode('303', 'FLO')!;
  assertEq(flc.scope, 'fx', 'FLC is fx-scope (LFO/automation sweepable)');
  assertEq(flc.curve, 'log', 'cutoff sweeps logarithmically');
  assertEq(flc.key, 'filterCutoff', 'FLC → filterCutoff');
  assertEq(flr.key, 'filterReso', 'FLR → filterReso');
  assertEq(flm.key, 'filterMix', 'FLM → filterMix');
  assert(flo.toggle === true, 'FLO is a toggle');
});

test('normUnit/denormUnit round-trip (linear and log curves)', () => {
  const lin = targetByCode('303', 'VOL')!;             // linear
  const log = targetByCode('303', 'BCR')!;             // log (crush rate, Hz)
  for (const x of [0, 0.13, 0.5, 0.87, 1]) {
    assertClose(normUnit(lin, denormUnit(lin, x)), x, 1e-9, `linear round-trip @${x}`);
    assertClose(normUnit(log, denormUnit(log, x)), x, 1e-9, `log round-trip @${x}`);
  }
});

test('normByte ↔ denorm endpoints land on the rails', () => {
  const lin = targetByCode('303', 'VOL')!;
  assertEq(normByte(lin, denorm(lin, 0)), 0, 'byte 0 stable');
  assertEq(normByte(lin, denorm(lin, 255)), 255, 'byte 255 stable');
});
