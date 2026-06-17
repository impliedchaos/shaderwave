// Additive resynthesis — offline spectral analysis (Phase 2 for the Spectra engine).
//
// Turns a PCM sample into a HARMONIC AMPLITUDE PROFILE amp[1..K]: the relative
// strength of each harmonic of the sample's detected fundamental. The Spectra shader
// then plays that profile back as a sustained additive tone (freq_n = playedNote·n),
// and the Morph knob crossfades between the synthetic formula spectrum and this
// analyzed one. We deliberately resample onto the HARMONIC grid (rather than tracking
// arbitrary inharmonic peaks) so both spectra share partial frequencies — that keeps
// Morph click-free and automatable, and reuses the engine's existing f·t phase path.
//
// This is the analysis half of resynthesis; "true" time-varying partial tracking
// (scrubbable phase-vocoder frames) is a possible Phase 3. Pure module — no GLSL — so
// it runs under plain node for tests.

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

export interface SpectrumAnalysis {
  amps: Float32Array;   // length K, harmonic amplitudes (peak-normalized to 1)
  f0: number;           // detected fundamental (Hz) — informational; playback is pitch-relative
}

// Analyze `pcm` into a K-harmonic amplitude profile. Averages a few windows from the
// sample's sustain region for stability, detects f0 via the Harmonic Product Spectrum,
// then samples the magnitude at each harmonic. Falls back to a 1/n profile if no clear
// pitch is found (so a percussive/noisy sample degrades gracefully instead of NaNing).
export function analyzeHarmonicSpectrum(
  pcm: Float32Array, sampleRate: number, K = 512, fftSize = 4096,
): SpectrumAnalysis {
  const amps = new Float32Array(K);
  if (!pcm || pcm.length < 64) { for (let n = 1; n <= K; n++) amps[n - 1] = 1 / n; return { amps, f0: 0 }; }

  // Average magnitude over up to 3 windows across the middle 60% of the sample.
  const usable = Math.max(0, pcm.length - fftSize);
  const starts = usable <= 0
    ? [0]
    : [0.2, 0.4, 0.6].map((p) => Math.floor(usable * p));
  const half = fftSize >> 1;
  const mag = new Float32Array(half);
  for (const st of starts) {
    const m = magFrame(pcm, st, fftSize);
    for (let k = 0; k < half; k++) mag[k] += m[k] / starts.length;
  }

  // f0 via Harmonic Product Spectrum over a musical range (~50–1200 Hz).
  const loBin = Math.max(2, Math.floor((50 * fftSize) / sampleRate));
  const hiBin = Math.min(half >> 2, Math.ceil((1200 * fftSize) / sampleRate));
  let bestBin = 0, bestVal = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const hps = mag[k] * mag[2 * k] * mag[3 * k] * mag[Math.min(4 * k, half - 1)];
    if (hps > bestVal) { bestVal = hps; bestBin = k; }
  }
  const f0 = bestBin > 0 ? (bestBin * sampleRate) / fftSize : 0;

  if (f0 <= 0) { for (let n = 1; n <= K; n++) amps[n - 1] = 1 / n; return { amps, f0: 0 }; }

  // Sample the magnitude at each harmonic n·f0; band-limit to Nyquist.
  let peak = 0;
  for (let n = 1; n <= K; n++) {
    const bin = (n * f0 * fftSize) / sampleRate;
    const a = bin < half - 1 ? magAt(mag, bin) : 0;
    amps[n - 1] = a;
    if (a > peak) peak = a;
  }
  if (peak > 0) for (let n = 0; n < K; n++) amps[n] /= peak;   // peak-normalize → max 1
  else for (let n = 1; n <= K; n++) amps[n - 1] = 1 / n;
  return { amps, f0 };
}
