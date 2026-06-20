// Additive resynthesis — offline spectral analysis (Phase 2 for the Spectra engine).
//
// Turns a PCM sample into a TIME-VARYING HARMONIC PROFILE: the relative strength of
// each harmonic of the sample's detected fundamental, captured at TWO moments — the
// onset/attack and the steady sustain — plus a per-harmonic DECAY RATE. The Spectra
// shader plays this back as freq_n = playedNote·n, crossfading attack→sustain over the
// onset and applying each harmonic's own decay, so a resynth tone has a bright, complex
// strike that settles into a simpler body and dies naturally (instead of the static
// averaged profile the first cut produced). The Morph knob crossfades between the
// synthetic formula spectrum and this analyzed one.
//
// We deliberately resample onto the HARMONIC grid (rather than tracking arbitrary
// inharmonic peaks) so both spectra share partial frequencies — that keeps Morph
// click-free and automatable, and reuses the engine's existing f·t phase path.
//
// "True" scrubbable phase-vocoder frames (full time-varying inharmonic partial tracks)
// remain a possible later step. Pure module — no GLSL — so it runs under plain node.

// In-place iterative radix-2 Cooley–Tukey FFT (length must be a power of two).
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1);
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Magnitude spectrum of one Hann-windowed frame of `pcm` starting at `start`.
function magFrame(pcm: Float32Array, start: number, fftSize: number): Float32Array {
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const s = start + i;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));   // Hann
    re[i] = (s < pcm.length ? pcm[s] : 0) * w;
  }
  fft(re, im);
  const half = fftSize >> 1;
  const mag = new Float32Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

// Linear-interpolated read of a magnitude array at a fractional bin.
function magAt(mag: Float32Array, bin: number): number {
  if (bin <= 0 || bin >= mag.length - 1) return 0;
  const i = Math.floor(bin), f = bin - i;
  return mag[i] * (1 - f) + mag[i + 1] * f;
}

// Decay rates above this (1/s) are clamped — a partial that vanishes faster than
// τ ≈ 25 ms reads as an instantaneous transient, and unbounded rates from noisy fits
// would make exp(-t·rate) underflow instantly. Informational only; not shader-shared.
const DECAY_RATE_CAP = 40;

export interface SpectrumAnalysis {
  atk: Float32Array;    // length K — harmonic amplitudes at the onset/attack frame
  sus: Float32Array;    // length K — harmonic amplitudes in the sustain region
                        // (atk & sus are jointly peak-normalized so their relative loudness survives)
  decay: Float32Array;  // length K — per-harmonic decay RATE in 1/s (0 = sustained); shader applies exp(-t·rate)
  f0: number;           // detected fundamental (Hz) — informational; playback is pitch-relative
}

// Analyze `pcm` into a time-varying K-harmonic profile (attack spectrum + sustain
// spectrum + per-harmonic decay). Frames the whole sample, detects f0 via the Harmonic
// Product Spectrum (parabolically refined) over the steady region, then samples each
// harmonic across frames. Falls back to a static 1/n profile if no clear pitch is found
// (so a percussive/noisy sample degrades gracefully instead of NaNing).
export function analyzeHarmonicSpectrum(
  pcm: Float32Array, sampleRate: number, K = 512, fftSize = 4096,
): SpectrumAnalysis {
  const atk = new Float32Array(K), sus = new Float32Array(K), decay = new Float32Array(K);
  const fallback = (f0 = 0): SpectrumAnalysis => {
    for (let n = 1; n <= K; n++) { atk[n - 1] = 1 / n; sus[n - 1] = 1 / n; }
    return { atk, sus, decay, f0 };
  };
  if (!pcm || pcm.length < 64) return fallback();

  const half = fftSize >> 1;

  // --- Frame the whole sample (centres span onset → tail) so decay is observable. ---
  const hop = fftSize >> 1;
  const lastStart = Math.max(0, pcm.length - fftSize);
  const nFrames = Math.min(48, Math.max(1, Math.floor(lastStart / hop) + 1));
  const starts: number[] = [];
  if (nFrames === 1) starts.push(0);
  else for (let f = 0; f < nFrames; f++) starts.push(Math.round((f * lastStart) / (nFrames - 1)));
  const frameMag = starts.map((st) => magFrame(pcm, st, fftSize));
  const frameTime = starts.map((st) => (st + fftSize / 2) / sampleRate);   // centre time (s)

  // --- f0 from the steady region (middle..end frames averaged), HPS + parabolic refine. ---
  const susLo = nFrames === 1 ? 0 : Math.floor(nFrames * 0.4);   // skip the transient when detecting pitch
  const avg = new Float32Array(half);
  let avgCount = 0;
  for (let f = susLo; f < nFrames; f++) { const m = frameMag[f]; for (let k = 0; k < half; k++) avg[k] += m[k]; avgCount++; }
  if (avgCount > 0) for (let k = 0; k < half; k++) avg[k] /= avgCount;

  const loBin = Math.max(2, Math.floor((50 * fftSize) / sampleRate));
  const hiBin = Math.min(half >> 2, Math.ceil((1200 * fftSize) / sampleRate));
  let bestBin = 0, bestVal = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const hps = avg[k] * avg[2 * k] * avg[3 * k] * avg[Math.min(4 * k, half - 1)];
    if (hps > bestVal) { bestVal = hps; bestBin = k; }
  }
  if (bestBin <= 0) return fallback();
  // Parabolic interpolation of the peak bin → sub-bin f0 (sharper harmonic sampling).
  let delta = 0;
  if (bestBin > 0 && bestBin < half - 1) {
    const a = avg[bestBin - 1], b = avg[bestBin], c = avg[bestBin + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }
  const f0 = ((bestBin + delta) * sampleRate) / fftSize;
  if (!(f0 > 0)) return fallback();

  // --- Sample each harmonic across every frame → Hn[frame][n]. ---
  const Hn: Float32Array[] = frameMag.map((mag) => {
    const h = new Float32Array(K);
    for (let n = 1; n <= K; n++) {
      const bin = (n * f0 * fftSize) / sampleRate;
      h[n - 1] = bin < half - 1 ? magAt(mag, bin) : 0;
    }
    return h;
  });

  // --- Attack frame = the frame with the most harmonic energy (the onset peak). ---
  let attackFrame = 0, attackEnergy = -1;
  for (let f = 0; f < nFrames; f++) {
    let e = 0; const h = Hn[f]; for (let n = 0; n < K; n++) e += h[n];
    if (e > attackEnergy) { attackEnergy = e; attackFrame = f; }
  }
  for (let n = 0; n < K; n++) atk[n] = Hn[attackFrame][n];

  // --- Sustain = mean over the latter-half frames (steady body). ---
  let susN = 0;
  for (let f = susLo; f < nFrames; f++) { const h = Hn[f]; for (let n = 0; n < K; n++) sus[n] += h[n]; susN++; }
  if (susN > 0) for (let n = 0; n < K; n++) sus[n] /= susN;
  else for (let n = 0; n < K; n++) sus[n] = atk[n];

  // --- Joint peak-normalize atk & sus → max 1 (relative attack-vs-body loudness kept). ---
  let peak = 0;
  for (let n = 0; n < K; n++) { if (atk[n] > peak) peak = atk[n]; if (sus[n] > peak) peak = sus[n]; }
  if (peak > 0) for (let n = 0; n < K; n++) { atk[n] /= peak; sus[n] /= peak; }
  else return fallback(f0);

  // --- Per-harmonic decay rate: slope of ln(amp) vs time from the attack frame on. ---
  // Linear-regress only frames above 5% of that harmonic's peak (ignore noise-floor tail);
  // rate = -slope, clamped ≥ 0 (no growth) and ≤ cap. Needs ≥ 2 usable frames.
  for (let n = 0; n < K; n++) {
    let hPeak = 0;
    for (let f = attackFrame; f < nFrames; f++) if (Hn[f][n] > hPeak) hPeak = Hn[f][n];
    if (hPeak <= 0) continue;
    const floor = hPeak * 0.05;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    const t0 = frameTime[attackFrame];
    for (let f = attackFrame; f < nFrames; f++) {
      const a = Hn[f][n];
      if (a < floor) continue;
      const x = frameTime[f] - t0, y = Math.log(a);
      sx += x; sy += y; sxx += x * x; sxy += x * y; cnt++;
    }
    if (cnt < 2) continue;
    const denom = cnt * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (cnt * sxy - sx * sy) / denom;
    decay[n] = Math.max(0, Math.min(DECAY_RATE_CAP, -slope));
  }

  return { atk, sus, decay, f0 };
}
