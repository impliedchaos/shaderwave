// TR-808 style drum machine. Every voice is analytical (closed-form in t), so
// there's no recursion and no per-fragment loop — each fragment computes its one
// sample directly. State output is unused (zero).
//
// Params (per voice):
//   uP0 = (drumType, tone 0..1, decay 0..1, snappy 0..1)
// drumType: 0 BD  1 SD  2 CH  3 OH  4 CLAP  5 LOTOM  6 MIDTOM  7 HITOM  8 COWBELL

// Swept-sine phase, integrated analytically: f(t) = f1 + (f0-f1)·e^(−t/τ).
float sweepPhase(float t, float f0, float f1, float tau){
  return f1 * t + (f0 - f1) * tau * (1.0 - exp(-t / tau));
}

// Boxcar (moving-average) lowpass of white noise. noise1 is a pure function of
// absolute sample index, so we can average the previous k samples pointwise. A
// k-tap average rolls off above ~SR/(2k). Crucially this still sounds like HISS,
// not a tone — value noise at these rates reads as a pitched wobble, which is
// exactly the "slowed-down" artifact we're avoiding.
float boxNoise(float n, int k, float seed){
  float acc = 0.0;
  for (int j = 0; j < 64; j++){
    if (j >= k) break;
    acc += noise1(n - float(j) + seed);
  }
  return acc / float(k);   // amplitude ∝ band energy (std ≈ 1/sqrt(k))
}

// Band-passed white noise between loHz and hiHz: the difference of two boxcar
// lowpasses (bright minus dark). Brighter cutoff = shorter window. n is the
// absolute sample frame so the noise is continuous across blocks.
float bandNoise(float n, float loHz, float hiHz, float seed){
  int kHi = int(clamp(uSampleRate / (2.0 * hiHz), 1.0, 63.0));
  int kLo = int(clamp(uSampleRate / (2.0 * loHz), 1.0, 63.0));
  return boxNoise(n, kHi, seed) - boxNoise(n, kLo, seed);
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;
  if (t < 0.0) { outAudio = vec4(0.0); return; }

  int   drum  = int(uP0[v].x + 0.5);
  float tone  = uP0[v].y;
  float decay = uP0[v].z;
  float snap  = uP0[v].w;
  float vel   = uVel[v];
  float nz    = noise1(uBlockStart + float(x) + float(v) * 131.0);
  float s = 0.0;

  if (drum == 0) {                         // bass drum
    float dec = mix(0.12, 0.9, decay);
    float f0 = 120.0 + tone * 80.0, f1 = 45.0;
    float body = oscSine(sweepPhase(t, f0, f1, 0.045)) * exp(-t / dec);
    float click = nz * exp(-t * 350.0) * 0.4;
    s = body + click;
  } else if (drum == 1) {                  // snare
    // Matched to a real TR-808 SD sample: BODY-dominated. Two tuned partials at
    // ~180 + 330 Hz carry most of the energy (real spectral centroid ≈ 860 Hz),
    // with a quieter band of "snare wire" noise layered on top. tone bends the
    // body pitch slightly; snappy adds wire noise; decay lengthens the tails.
    float n = uBlockStart + float(x);
    float bodyF = 1.0 + (tone - 0.5) * 0.4;             // ±20% pitch trim
    float shellEnv = exp(-t * 33.0);                    // ≈ -20 dB @ 70 ms (matches ref)
    float shell = (oscSine(180.0 * bodyF * t) * 0.6
                 + oscSine(330.0 * bodyF * t) * 0.4) * shellEnv;

    // Wires: mid-band noise (~1.5–6 kHz), decaying a touch faster than the body.
    float wires = bandNoise(n, 1500.0, 6000.0, float(v) * 17.0)
                * exp(-t * mix(34.0, 16.0, decay));

    // Onset crack: a very short broadband tick for the attack transient.
    float crack = bandNoise(n, 1000.0, 10000.0, float(v) * 17.0 + 3.0) * exp(-t * 500.0);

    // Wires/crack stay well below the body so the snare keeps its "thock", not hiss.
    float wireAmt = 0.18 + snap * 0.35;
    s = (shell * 1.5 + (wires + crack * 0.4) * wireAmt) * 0.8;
  } else if (drum == 2 || drum == 3) {     // closed / open hat
    float dec = drum == 2 ? mix(0.02, 0.08, decay) : mix(0.15, 0.5, decay);
    
    // 6 metallic oscillators modeled after original 808
    float tPrev = t - 1.0 / uSampleRate;
    
    float metalCurrent = 0.0;
    metalCurrent += oscSquare(fract(t * 205.3), 205.3 / uSampleRate, 0.5);
    metalCurrent += oscSquare(fract(t * 369.6), 369.6 / uSampleRate, 0.5);
    metalCurrent += oscSquare(fract(t * 304.4), 304.4 / uSampleRate, 0.5);
    metalCurrent += oscSquare(fract(t * 522.7), 522.7 / uSampleRate, 0.5);
    metalCurrent += oscSquare(fract(t * 798.2), 798.2 / uSampleRate, 0.5);
    metalCurrent += oscSquare(fract(t * 890.0), 890.0 / uSampleRate, 0.5);
    metalCurrent /= 6.0;
    
    float metalPrev = 0.0;
    metalPrev += oscSquare(fract(tPrev * 205.3), 205.3 / uSampleRate, 0.5);
    metalPrev += oscSquare(fract(tPrev * 369.6), 369.6 / uSampleRate, 0.5);
    metalPrev += oscSquare(fract(tPrev * 304.4), 304.4 / uSampleRate, 0.5);
    metalPrev += oscSquare(fract(tPrev * 522.7), 522.7 / uSampleRate, 0.5);
    metalPrev += oscSquare(fract(tPrev * 798.2), 798.2 / uSampleRate, 0.5);
    metalPrev += oscSquare(fract(tPrev * 890.0), 890.0 / uSampleRate, 0.5);
    metalPrev /= 6.0;
    
    // First-order highpass filter on metal and noise via sample difference
    float hpMetal = metalCurrent - metalPrev;
    float nzPrev = noise1(uBlockStart + float(x - 1) + float(v) * 131.0);
    float hpNoise = nz - nzPrev;
    
    s = (hpMetal * 1.5 + hpNoise * 0.45) * exp(-t / dec);
  } else if (drum == 4) {                  // clap
    // Matched to a real TR-808 CP sample: a fairly narrow noise band centred
    // ~1.1 kHz (energy 500–2400 Hz, almost nothing above 3.5 kHz), gated by the
    // classic "multiple hands" gesture — three fast bursts ~10 ms apart, then a
    // long room tail (~-40 dB by ~300 ms). tone shifts the band, decay the tail.
    float n = uBlockStart + float(x);
    float hi = mix(2800.0, 3800.0, tone);
    float band = bandNoise(n, 750.0, hi, float(v) * 23.0 + 5.0);

    // --- Path 1: three sharp bursts (~3 ms each, 10 ms apart) ---
    float burstDecay = 320.0;
    float burst = exp(-t * burstDecay);
    if (t > 0.010) burst += 0.95 * exp(-(t - 0.010) * burstDecay);
    if (t > 0.020) burst += 0.90 * exp(-(t - 0.020) * burstDecay);
    burst = min(burst, 1.0);

    // --- Path 2: room tail ---
    float tail = 0.55 * exp(-t / mix(0.04, 0.12, decay));

    s = band * (burst + tail) * 2.0;
  } else if (drum >= 5 && drum <= 7) {     // toms (low/mid/high)
    float base = drum == 5 ? 90.0 : (drum == 6 ? 140.0 : 200.0);
    base *= (0.7 + tone * 0.6);
    float dec = mix(0.15, 0.5, decay);
    s = oscSine(sweepPhase(t, base * 2.0, base, 0.05)) * exp(-t / dec);
  } else {                                 // cowbell
    float dec = mix(0.1, 0.4, decay);
    float a = oscSquare(fract(540.0 * t), 540.0 / uSampleRate, 0.5);
    float b = oscSquare(fract(800.0 * t), 800.0 / uSampleRate, 0.5);
    s = (a + b) * 0.4 * exp(-t / dec);
  }

  outAudio = vec4(tanh(s * vel * 1.4), 0.0, 0.0, 1.0);
}
