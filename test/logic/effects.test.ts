// Effects-chain helpers — chiefly normalizeFxOrder, the robustness guard for the
// reorderable per-instrument chain: a saved/hand-edited order must never silently
// drop an effect (missing keys are appended) or run an unknown one (dropped).
import { test, assert, assertEq } from './_harness.js';
import { normalizeFxOrder, DEFAULT_FX_ORDER, defaultFxParams } from '../../src/gl/effects.js';

test('normalizeFxOrder: undefined → the full default order', () => {
  const o = normalizeFxOrder(undefined);
  assertEq(o.length, DEFAULT_FX_ORDER.length, 'length matches registry');
  assertEq(o.join(','), DEFAULT_FX_ORDER.join(','), 'identical to default');
});

test('normalizeFxOrder: keeps given order, appends missing registry keys', () => {
  // A partial order (limiter first, then filter) — every other effect must still
  // appear, in default order, after them. No effect vanishes.
  const o = normalizeFxOrder(['limiter', 'filter']);
  assertEq(o[0], 'limiter', 'explicit first kept');
  assertEq(o[1], 'filter', 'explicit second kept');
  assertEq(o.length, DEFAULT_FX_ORDER.length, 'all effects present');
  for (const k of DEFAULT_FX_ORDER) assert(o.includes(k), `missing effect ${k} appended`);
});

test('normalizeFxOrder: drops unknown keys and de-dupes', () => {
  const o = normalizeFxOrder(['filter', 'bogus', 'filter', 'compressor']);
  assert(!o.includes('bogus'), 'unknown key dropped');
  assertEq(o.filter((k) => k === 'filter').length, 1, 'duplicate collapsed');
  assertEq(o.length, DEFAULT_FX_ORDER.length, 'still a complete chain');
  assertEq(o[0], 'filter', 'first kept'); assertEq(o[1], 'compressor', 'second kept');
});

test('every effect key has a stable place (compressor + limiter registered)', () => {
  assert(DEFAULT_FX_ORDER.includes('compressor'), 'compressor in registry');
  assert(DEFAULT_FX_ORDER.includes('limiter'), 'limiter in registry');
  assert(DEFAULT_FX_ORDER.includes('filter'), 'filter in registry');
  assert(DEFAULT_FX_ORDER.includes('eq'), 'eq in registry');
  assertEq(DEFAULT_FX_ORDER[DEFAULT_FX_ORDER.length - 1], 'limiter', 'limiter defaults to dead last');
});

test('equalizer and compressor sidechain parameters are in defaultFxParams()', () => {
  const p = defaultFxParams();
  assertEq(p.eqOn, false, 'EQ starts off');
  assertEq(p.eqLow, 0, 'EQ low default is 0 dB');
  assertEq(p.eqMid, 0, 'EQ mid default is 0 dB');
  assertEq(p.eqHigh, 0, 'EQ high default is 0 dB');
  assertEq(p.eqLowFreq, 200, 'EQ low cutoff default');
  assertEq(p.eqHighFreq, 3000, 'EQ high cutoff default');
  assertEq(p.compSource, -1, 'compressor sidechain source default is self');
});
