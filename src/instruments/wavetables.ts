// Shared wavetable bank definitions + a CPU baker. The SINGLE SOURCE OF TRUTH for
// the Wavewright engine, the per-oscillator UI scopes, and the LFO "wavetable"
// shape readout. Pure math — imports nothing from the project, so it can be used
// anywhere (engine, renderer, UI, descriptors) without import cycles.
//
// A "bank" is a 1-D morph axis: a short list of keyframe waveforms (one cycle
// each, phase p∈[0,1) → sample) that Position crossfades through. bakeBank()
// renders a bank to a flat Float32Array of `frames` × `samples` (row-major, one
// row per morph position); sampleTable() reads it back bilinearly. The keyframe
// fns run ONLY at bake time, so they can be as heavy as we like (additive sums,
// formant spectra); audio/scope/LFO read the baked arrays, never the fns.
//
// Lifted from test/wavetable-proto.html (the keystone prototype). Bank 0 order +
// the phase-aligned (descending) saw were locked by ear — see MEMORY.md.

const TAU = Math.PI * 2;
const fracp = (p: number) => p - Math.floor(p);

// ── keyframe helpers (bake-time only) ──
function additive(p: number, amps: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < amps.length; k++) if (amps[k]) s += amps[k] * Math.sin(TAU * (k + 1) * p);
  return s;
}
const pulse = (p: number, d: number) => (fracp(p) < d ? 1 : -1);
const fm = (p: number, ratio: number, idx: number) => Math.sin(TAU * p + idx * Math.sin(TAU * ratio * p));
const fold = (p: number, drive: number) => Math.sin(Math.PI * drive * Math.sin(TAU * p));
const crush = (v: number, levels: number) => Math.round(v * levels) / levels;
const sawc = (p: number) => 1 - 2 * fracp(p);   // phase-aligned (descending) saw — fundamental = +sin

// Resonant peak scanning the harmonic series — a "filter sweep" with no filter.
function resoWave(p: number, center: number, q: number, nH = 48): number {
  let s = 0;
  for (let n = 1; n <= nH; n++) {
    const bump = q * Math.exp(-0.5 * ((n - center) / 2.0) ** 2);
    s += ((0.22 + bump) / n) * Math.sin(TAU * n * p);
  }
  return s;
}
// Vowel = glottal (1/n) source shaped by formant resonances. Single-cycle tables
// hold only integer harmonics, so vowels are approximated at a reference f0.
const F0_REF = 120;
function vowelAmps(formants: [number, number, number][], nH = 48): Float32Array {
  const a = new Float32Array(nH);
  for (let n = 1; n <= nH; n++) {
    const fHz = n * F0_REF; let g = 0;
    for (const [Ff, amp, bw] of formants) g += amp * Math.exp(-0.5 * ((fHz - Ff) / bw) ** 2);
    a[n - 1] = (g + 0.015) / n;
  }
  return a;
}
const VOW = {
  U: vowelAmps([[325, 1, 120], [700, 0.6, 150], [2500, 0.1, 350]]),
  O: vowelAmps([[450, 1, 120], [800, 0.7, 160], [2830, 0.1, 350]]),
  A: vowelAmps([[700, 1, 130], [1100, 0.8, 160], [2450, 0.2, 350]]),
  E: vowelAmps([[530, 1, 120], [1840, 0.7, 220], [2480, 0.3, 350]]),
  I: vowelAmps([[270, 1, 100], [2300, 0.8, 260], [3000, 0.4, 380]]),
};

// tanh-saturated sine (warm clip → square), normalized to unit peak.
const sat = (p: number, drive: number) => Math.tanh(drive * Math.sin(TAU * p)) / (Math.tanh(drive) || 1);
// comb/phaser: saw harmonics scalloped by a cosine comb whose depth morphs.
function combWave(p: number, depth: number, nH = 32): number {
  let s = 0;
  for (let n = 1; n <= nH; n++) s += ((1 / n) * Math.abs(Math.cos(Math.PI * n * depth))) * Math.sin(TAU * n * p);
  return s;
}
// asymmetric triangle: peak at s (s→0 ramp-up, 0.5 triangle, s→1 ramp-down).
function skew(p: number, s: number): number {
  const x = fracp(p), sc = Math.min(Math.max(s, 0.02), 0.98);
  return x < sc ? (-1 + 2 * x / sc) : (1 - 2 * (x - sc) / (1 - sc));
}
// fixed pseudo-random single cycle (band-limited-ish): harmonics with hashed phases.
const _nph = (n: number) => { const x = Math.sin(n * 78.233) * 43758.5453; return (x - Math.floor(x)) * TAU; };
function noiseWave(p: number, nH = 16): number {
  let s = 0;
  for (let n = 1; n <= nH; n++) s += (1 / Math.sqrt(n)) * Math.sin(TAU * n * p + _nph(n));
  return s;
}

export interface WtKeyframe { name: string; fn: (p: number) => number; }
export interface WtBank { name: string; keyframes: WtKeyframe[]; }

// The 8 morph banks. Each bank's keyframes are ordered so Position reads as ONE
// coherent axis. Bank 0 "Classic" is phase-aligned (every fundamental = +sin,
// incl. the descending saw) so crossfades reinforce instead of cancelling.
export const WT_BANKS: WtBank[] = [
  { name: 'Classic', keyframes: [
    { name: 'Sine',     fn: (p) => Math.sin(TAU * p) },
    { name: 'Triangle', fn: (p) => (2 / Math.PI) * Math.asin(Math.sin(TAU * p)) },
    { name: 'Square',   fn: (p) => (Math.sin(TAU * p) >= 0 ? 1 : -1) },
    { name: 'Saw',      fn: sawc },
  ] },
  { name: 'Harmonic', keyframes: [
    { name: 'Fund',   fn: (p) => additive(p, [1]) },
    { name: '+oct',   fn: (p) => additive(p, [1, 1]) },
    { name: '4-comb', fn: (p) => additive(p, [1, 1, 1, 1]) },
    { name: '8-comb', fn: (p) => additive(p, [1, 1, 1, 1, 1, 1, 1, 1]) },
  ] },
  { name: 'PWM', keyframes: [
    { name: 'Square', fn: (p) => pulse(p, 0.5) },
    { name: '35%',    fn: (p) => pulse(p, 0.65) },
    { name: '20%',    fn: (p) => pulse(p, 0.8) },
    { name: 'Thin',   fn: (p) => pulse(p, 0.93) },
  ] },
  { name: 'Formant', keyframes: [
    { name: 'U', fn: (p) => additive(p, VOW.U) },
    { name: 'O', fn: (p) => additive(p, VOW.O) },
    { name: 'A', fn: (p) => additive(p, VOW.A) },
    { name: 'E', fn: (p) => additive(p, VOW.E) },
    { name: 'I', fn: (p) => additive(p, VOW.I) },
  ] },
  { name: 'Resonant', keyframes: [
    { name: 'Low',  fn: (p) => resoWave(p, 1.5, 8) },
    { name: 'Mid',  fn: (p) => resoWave(p, 4, 8) },
    { name: 'Hi',   fn: (p) => resoWave(p, 10, 8) },
    { name: 'Peak', fn: (p) => resoWave(p, 22, 8) },
  ] },
  { name: 'Metallic', keyframes: [
    { name: 'r1',    fn: (p) => fm(p, 1, 2) },
    { name: 'r2',    fn: (p) => fm(p, 2, 4) },
    { name: 'r3',    fn: (p) => fm(p, 3, 6) },
    { name: 'clang', fn: (p) => fm(p, 4, 8) },
  ] },
  { name: 'Wavefolder', keyframes: [
    { name: 'Sine',  fn: (p) => fold(p, 0.4) },
    { name: 'Fold1', fn: (p) => fold(p, 1.2) },
    { name: 'Fold2', fn: (p) => fold(p, 2.2) },
    { name: 'Fold3', fn: (p) => fold(p, 3.5) },
  ] },
  { name: 'Digital', keyframes: [
    { name: 'Clean', fn: sawc },
    { name: 'Crush', fn: (p) => crush(sawc(p), 12) },
    { name: 'Bits',  fn: (p) => crush(sawc(Math.floor(p * 48) / 48), 5) },
    { name: 'Grit',  fn: (p) => crush(sawc(Math.floor(p * 16) / 16), 3) },
  ] },
  // ── Banks 9–16 ──
  { name: 'Organ', keyframes: [        // additive drawbars filling in
    { name: '8ft',    fn: (p) => additive(p, [1]) },
    { name: '+4ft',   fn: (p) => additive(p, [1, 0.8]) },
    { name: 'full',   fn: (p) => additive(p, [1, 0.8, 0.6, 0.7, 0, 0.5, 0, 0.4]) },
    { name: 'bright', fn: (p) => additive(p, [1, 0.9, 0.7, 0.8, 0.5, 0.6, 0.4, 0.6]) },
  ] },
  { name: 'Sync', keyframes: [         // oscillator-sync sweep (fractional ratio → hard edge)
    { name: 'x1',   fn: (p) => Math.sin(TAU * p) },
    { name: 'x2.5', fn: (p) => Math.sin(TAU * fracp(p) * 2.5) },
    { name: 'x4',   fn: (p) => Math.sin(TAU * fracp(p) * 4.0) },
    { name: 'x5.5', fn: (p) => Math.sin(TAU * fracp(p) * 5.5) },
  ] },
  { name: 'Saturate', keyframes: [     // sine driven into tanh (warm → square)
    { name: 'clean',  fn: (p) => sat(p, 1) },
    { name: 'warm',   fn: (p) => sat(p, 3) },
    { name: 'hot',    fn: (p) => sat(p, 6) },
    { name: 'square', fn: (p) => sat(p, 12) },
  ] },
  { name: 'Comb', keyframes: [         // comb/phaser scallops sweeping the spectrum
    { name: 'open', fn: (p) => combWave(p, 0.0) },
    { name: 'c1',   fn: (p) => combWave(p, 0.3) },
    { name: 'c2',   fn: (p) => combWave(p, 0.6) },
    { name: 'c3',   fn: (p) => combWave(p, 0.9) },
  ] },
  { name: 'Skew', keyframes: [         // asymmetric triangle: ramp-up → tri → ramp-down
    { name: 'rampU', fn: (p) => skew(p, 0.05) },
    { name: 'tri',   fn: (p) => skew(p, 0.5) },
    { name: 'rampD', fn: (p) => skew(p, 0.95) },
  ] },
  { name: 'Noise', keyframes: [        // tone → fixed pseudo-random cycle (breathy/airy)
    { name: 'tone',   fn: (p) => Math.sin(TAU * p) },
    { name: 'airy',   fn: (p) => 0.5 * Math.sin(TAU * p) + 0.5 * noiseWave(p) },
    { name: 'breath', fn: (p) => noiseWave(p) },
  ] },
  { name: 'Power', keyframes: [        // hollow stacked octave/fifth partials
    { name: 'root',  fn: (p) => additive(p, [1]) },
    { name: '+5th',  fn: (p) => additive(p, [1, 0, 0.7]) },
    { name: 'oct5',  fn: (p) => additive(p, [1, 0.6, 0.7]) },
    { name: 'stack', fn: (p) => additive(p, [1, 0.6, 0.7, 0.4, 0, 0.4]) },
  ] },
  { name: 'Glass', keyframes: [        // high-ratio low-index FM (sparse bright bell)
    { name: 'pure',    fn: (p) => fm(p, 7, 0.4) },
    { name: 'shimmer', fn: (p) => fm(p, 7, 0.9) },
    { name: 'bright',  fn: (p) => fm(p, 7, 1.5) },
    { name: 'bell',    fn: (p) => fm(p, 7, 2.2) },
  ] },
];

export const WT_BANK_COUNT = WT_BANKS.length;
export const WT_FRAMES = 64;
export const WT_SAMPLES = 1024;

// Continuous morph across a bank's keyframes at Position x∈[0,1].
export function morphSample(bank: WtBank, x: number, p: number): number {
  const K = bank.keyframes.length;
  const f = Math.max(0, Math.min(1, x)) * (K - 1);
  let i = Math.floor(f), t = f - i;
  if (i >= K - 1) { i = K - 2; t = 1; }
  const a = bank.keyframes[i].fn(p);
  const b = bank.keyframes[i + 1].fn(p);
  return a + (b - a) * t;
}

// Bake a bank → Float32Array[frames*samples], row-major (frame j, sample s). When
// `normalize`, each frame is scaled to ~unit peak so banks sit at an even level.
export function bakeBank(bank: WtBank, frames = WT_FRAMES, samples = WT_SAMPLES, normalize = true): Float32Array {
  const table = new Float32Array(frames * samples);
  for (let j = 0; j < frames; j++) {
    const x = frames > 1 ? j / (frames - 1) : 0;
    let peak = 1e-6;
    for (let s = 0; s < samples; s++) {
      const v = morphSample(bank, x, s / samples);
      table[j * samples + s] = v;
      const a = Math.abs(v); if (a > peak) peak = a;
    }
    if (normalize) {
      const g = 0.98 / peak;
      for (let s = 0; s < samples; s++) table[j * samples + s] *= g;
    }
  }
  return table;
}

// Read a baked table at continuous Position x∈[0,1] and phase p∈[0,1), bilinearly
// (between the two nearest frames and the two nearest samples). Used by the LFO
// wavetable-shape readout and the UI scopes.
export function sampleTable(table: Float32Array, frames: number, samples: number, x: number, p: number): number {
  const fx = Math.max(0, Math.min(1, x)) * (frames - 1);
  let j0 = Math.floor(fx); let ft = fx - j0;
  if (j0 >= frames - 1) { j0 = frames - 2; ft = 1; }
  if (j0 < 0) { j0 = 0; ft = 0; }
  const j1 = j0 + 1;
  const sp = fracp(p) * samples;
  let s0 = Math.floor(sp); const st = sp - s0;
  s0 = ((s0 % samples) + samples) % samples;
  const s1 = (s0 + 1) % samples;
  const a = table[j0 * samples + s0] * (1 - st) + table[j0 * samples + s1] * st;
  const b = table[j1 * samples + s0] * (1 - st) + table[j1 * samples + s1] * st;
  return a * (1 - ft) + b * ft;
}

// All 8 banks baked once at module load (normalized). ~2 MB total; shared by the
// LFO readout, the GPU texture upload, and the UI scopes. Index by bank number.
export const WT_TABLES: Float32Array[] = WT_BANKS.map((b) => bakeBank(b));

// Convenience for the LFO: one cycle's sample at fixed Position, given a bank id.
export function wtShape(bank: number, pos: number, phase: number): number {
  const b = (bank | 0);
  const tbl = WT_TABLES[b >= 0 && b < WT_TABLES.length ? b : 0];
  return sampleTable(tbl, WT_FRAMES, WT_SAMPLES, pos, phase);
}

// ── Band-limited mip atlas (for the GPU audio path) ─────────────────────────
// A single-cycle table aliases when played high (harmonic n·f exceeds Nyquist).
// We store WT_MIPS band-limited copies of every frame: mip m keeps harmonics up
// to WT_MAXH >> m. The shader picks/blends mips by playing frequency. Because the
// morph is a linear crossfade and the DFT is linear, we DFT only each bank's
// KEYFRAMES, interpolate their harmonic coefficients per frame, then re-synthesize
// — so analysis is ~36 DFTs, not 512. Trig is table-driven; ~1 s one-time bake.
export const WT_MAXH = 128;                 // mip 0 harmonic ceiling (top at 12.8 kHz @ 100 Hz)
export const WT_MIPS = 8;                   // topHarm = MAXH>>m = [128,64,32,16,8,4,2,1]
export const WT_ATLAS_ROWS_PER_MIP = WT_BANK_COUNT * WT_FRAMES;

// Cosine/sine LUTs over one cycle so synthesis avoids per-sample Math.cos.
const _COS = new Float32Array(WT_SAMPLES);
const _SIN = new Float32Array(WT_SAMPLES);
for (let k = 0; k < WT_SAMPLES; k++) { _COS[k] = Math.cos(TAU * k / WT_SAMPLES); _SIN[k] = Math.sin(TAU * k / WT_SAMPLES); }

// Real DFT of one keyframe cycle → harmonic coeffs a[n], b[n], n=1..maxH.
function keyframeCoeffs(fn: (p: number) => number, maxH: number): { a: Float32Array; b: Float32Array } {
  const S = WT_SAMPLES;
  const buf = new Float32Array(S);
  for (let s = 0; s < S; s++) buf[s] = fn(s / S);
  const a = new Float32Array(maxH + 1), b = new Float32Array(maxH + 1);
  for (let n = 1; n <= maxH; n++) {
    let ar = 0, br = 0;
    for (let s = 0; s < S; s++) { const k = (n * s) % S; ar += buf[s] * _COS[k]; br += buf[s] * _SIN[k]; }
    a[n] = 2 * ar / S; b[n] = 2 * br / S;
  }
  return { a, b };
}

let _atlas: { data: Float32Array; mips: number; rowsPerMip: number; samples: number } | null = null;

// Build (and memoize) the band-limited atlas. Layout row = mip*rowsPerMip +
// bank*WT_FRAMES + frame; one R32F texel per sample. Built lazily (first audio).
export function bakeWavetableAtlas() {
  if (_atlas) return _atlas;
  const S = WT_SAMPLES, F = WT_FRAMES, B = WT_BANK_COUNT, M = WT_MIPS, H = WT_MAXH;
  const rowsPerMip = WT_ATLAS_ROWS_PER_MIP;
  const data = new Float32Array(M * rowsPerMip * S);
  const a = new Float32Array(H + 1), b = new Float32Array(H + 1);

  for (let bk = 0; bk < B; bk++) {
    const kf = WT_BANKS[bk].keyframes;
    const K = kf.length;
    const coeffs = kf.map((k) => keyframeCoeffs(k.fn, H));
    for (let j = 0; j < F; j++) {
      const x = F > 1 ? j / (F - 1) : 0;
      const f = Math.max(0, Math.min(1, x)) * (K - 1);
      let i = Math.floor(f); let t = f - i;
      if (i >= K - 1) { i = K - 2; t = 1; }
      const c0 = coeffs[i], c1 = coeffs[i + 1];
      for (let n = 1; n <= H; n++) { a[n] = c0.a[n] + (c1.a[n] - c0.a[n]) * t; b[n] = c0.b[n] + (c1.b[n] - c0.b[n]) * t; }

      // Synthesize the finest mip first to derive a shared per-frame gain (so mip
      // transitions don't change level), then every mip with that gain.
      let peak = 1e-6;
      for (let m = 0; m < M; m++) {
        const top = H >> m;
        const off = (m * rowsPerMip + bk * F + j) * S;
        for (let s = 0; s < S; s++) {
          let acc = 0;
          for (let n = 1; n <= top; n++) { const k = (n * s) % S; acc += a[n] * _COS[k] + b[n] * _SIN[k]; }
          data[off + s] = acc;
          if (m === 0) { const av = Math.abs(acc); if (av > peak) peak = av; }
        }
      }
      const g = 0.98 / peak;
      for (let m = 0; m < M; m++) {
        const off = (m * rowsPerMip + bk * F + j) * S;
        for (let s = 0; s < S; s++) data[off + s] *= g;
      }
    }
  }
  _atlas = { data, mips: M, rowsPerMip, samples: S };
  return _atlas;
}
