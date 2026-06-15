// Bitcrusher sample-&-hold CONTINUITY across block boundaries.
//
// The decimator holds the sample captured at the start of each hold window. A
// window is `holdPeriod = floor(SR/rate)` samples wide and is keyed off the GLOBAL
// sample index, so a window routinely straddles a 512-sample block boundary. The
// GPU path carries the held source value across that seam in a 1-texel state
// (fx-bitcrush-update.glsl → uPrevHold in fx-bitcrush.glsl); the regression it
// guards is the old fallback to the *undecimated* sample at i=0 of each block,
// which injected a buzz at the block rate (~93 Hz = SR/BLOCK at 48 kHz).
//
// The real shader runs on the GPU and is covered for bit-identity by
// test/golden-render.html. This is the CPU model of its INTEGER windowing: it pins
// the algebra (block-alignment independence) so a refactor of that math is caught
// in the fast node suite, without a GPU. It mirrors the two .glsl files line-for-
// line — keep them in sync.
import { test, assert, assertEq } from './_harness.js';
import { BLOCK } from '../../src/constants.js';

const SR = 48000;
const holdPeriod = (rate: number) => Math.max(1, Math.floor(SR / Math.max(rate, 1)));

// Single-pass reference: decimate the whole signal at once. out[n] is the source
// at the start of n's hold window — the ground truth the chunked path must match.
function decimateWhole(src: Float32Array, rate: number): Float32Array {
  const hp = holdPeriod(rate);
  const out = new Float32Array(src.length);
  for (let n = 0; n < src.length; n++) out[n] = src[Math.floor(n / hp) * hp];
  return out;
}

// Block-by-block, mirroring fx-bitcrush(-update).glsl. `carry` is the 1-texel
// ping-pong: each block first writes the held source value for ITS last sample
// (consumed by the NEXT block), then crushes reading the PREVIOUS block's carry.
// `naive` = the pre-fix behaviour (fall back to the undecimated sample) to prove
// the carry is load-bearing.
function decimateBlocked(src: Float32Array, rate: number, naive = false): Float32Array {
  const hp = holdPeriod(rate);
  const out = new Float32Array(src.length);
  let carry = 0;                                   // reset() clears the texel to 0
  for (let B = 0; B < src.length; B += BLOCK) {
    const n = Math.min(BLOCK, src.length - B);
    // update: held SOURCE value at this block's last sample (fx-bitcrush-update.glsl)
    const last = n - 1;
    const holdLast = Math.floor((B + last) / hp) * hp;
    const heldLast = Math.min(Math.max(holdLast - B, 0), n - 1);
    const nextCarry = src[B + heldLast];
    // main: crush, reading the PREVIOUS block's carry for the straddling region
    for (let i = 0; i < n; i++) {
      const holdIdx = Math.floor((B + i) / hp) * hp;
      const heldI = holdIdx - B;
      out[B + i] = heldI >= 0 ? src[B + heldI] : (naive ? src[B + i] : carry);
    }
    carry = nextCarry;
  }
  return out;
}

const maxAbsDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

// A smooth multi-block test signal (several full blocks + a partial tail).
function ramp(len: number): Float32Array {
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) s[i] = Math.sin((i / SR) * 2 * Math.PI * 220);
  return s;
}

test('bitcrush: hold window straddles block boundaries (the case the carry exists for)', () => {
  // For any musically-relevant rate the window is shorter than a block, so its
  // start can land in the previous block — that is exactly when uPrevHold is read.
  for (const rate of [1000, 4000, 11025]) {
    assert(holdPeriod(rate) < BLOCK, `holdPeriod(${rate})=${holdPeriod(rate)} < BLOCK so windows straddle`);
  }
});

test('bitcrush: blocked decimation is bit-identical to single-pass (block-alignment independent)', () => {
  const src = ramp(BLOCK * 5 + 137);              // 5 blocks + a partial block
  // Rates whose period does NOT divide BLOCK → windows genuinely cross the seam.
  for (const rate of [4000, 3000, 11025, 6300, 999]) {
    const whole = decimateWhole(src, rate);
    const blocked = decimateBlocked(src, rate);
    assertEq(maxAbsDiff(whole, blocked), 0, `rate ${rate}: blocked == single-pass (continuous across blocks)`);
  }
});

test('bitcrush: the cross-block carry is load-bearing (naive fallback diverges)', () => {
  // Sanity that the test can actually fail: the old naive path (no carry) must
  // differ from the reference for a straddling rate — otherwise the equality above
  // would pass trivially and prove nothing.
  const src = ramp(BLOCK * 3);
  const whole = decimateWhole(src, 4000);
  const naive = decimateBlocked(src, 4000, /*naive*/ true);
  assert(maxAbsDiff(whole, naive) > 0, 'naive (no-carry) decimation introduces a boundary discontinuity');
});

test('bitcrush: a rate dividing BLOCK never reads the carry (windows align to the seam)', () => {
  // SR/rate = BLOCK → every block starts a fresh window; the carry path is dead.
  // Here naive and carried paths must agree (nothing straddles).
  const rate = SR / BLOCK;                          // hp === BLOCK
  assertEq(holdPeriod(rate), BLOCK, 'hold period equals one block');
  const src = ramp(BLOCK * 4);
  assertEq(maxAbsDiff(decimateBlocked(src, rate), decimateBlocked(src, rate, true)), 0,
    'aligned windows: carried and naive paths coincide');
});
