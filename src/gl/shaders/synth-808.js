// TR-808 style drum machine. Every voice is analytical (closed-form in t), so
// there's no recursion and no per-fragment loop — each fragment computes its one
// sample directly. State output is unused (zero).
//
// Params (per voice):
//   uP0 = (drumType, tone 0..1, decay 0..1, snappy 0..1)
// drumType: 0 BD  1 SD  2 CH  3 OH  4 CLAP  5 LOTOM  6 MIDTOM  7 HITOM  8 COWBELL
export const SYNTH_808 = /* glsl */`
// Swept-sine phase, integrated analytically: f(t) = f1 + (f0-f1)·e^(−t/τ).
float sweepPhase(float t, float f0, float f1, float tau){
  return f1 * t + (f0 - f1) * tau * (1.0 - exp(-t / tau));
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
    float tone1 = oscSine(180.0 * t) * 0.65;
    float tone2 = oscSine(330.0 * t) * 0.35;
    
    float click = nz * exp(-t * 600.0) * 0.15;
    float snareBody = (tone1 + tone2) * exp(-t / 0.055) + click;
    
    // 15-tap highpass filter (fc=1800Hz) with exactly 0 DC gain
    float hpNoise = 0.0;
    float snareCoeffs[15] = float[15](
      -0.037505, -0.040681, -0.049623, -0.063911, -0.081218, -0.097866, -0.109894,  0.961395,
      -0.109894, -0.097866, -0.081218, -0.063911, -0.049623, -0.040681, -0.037505
    );
    for (int k = 0; k < 15; k++) {
      hpNoise += snareCoeffs[k] * noise1(uBlockStart + float(x - k) + float(v) * 131.0);
    }
    
    float rattleDecay = mix(0.06, 0.35, decay);
    float rattleVol = snap * 1.15;
    float bodyVol = 0.85 - snap * 0.35;
    
    s = (snareBody * bodyVol + hpNoise * exp(-t / rattleDecay) * rattleVol) * 1.1;
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
    // 4 quick trigger pulses of descending amplitude (cap rattle emulation)
    float env = exp(-t * 750.0);
    if (t > 0.010) env = max(env, 0.85 * exp(-(t - 0.010) * 750.0));
    if (t > 0.020) env = max(env, 0.72 * exp(-(t - 0.020) * 750.0));
    if (t > 0.030) env = max(env, 0.60 * exp(-(t - 0.030) * 750.0));
    
    // Tail decay starting from the 4th trigger
    float dec = mix(0.06, 0.35, decay);
    if (t > 0.030) env = max(env, 0.60 * exp(-(t - 0.030) / dec));
    
    // 31-tap bandpass filter (800-1400Hz) with exactly 0 DC gain
    float bpNoise = 0.0;
    float clapCoeffs[31] = float[31](
      -0.186062, -0.183666, -0.182320, -0.178214, -0.167662, -0.147654, -0.116340, -0.073354, -0.019973,  0.040959,
       0.105296,  0.168041,  0.223913,  0.267960,  0.296150,  0.305852,  0.296150,  0.267960,  0.223913,  0.168041,
       0.105296,  0.040959, -0.019973, -0.073354, -0.116340, -0.147654, -0.167662, -0.178214, -0.182320, -0.183666,
      -0.186062
    );
    for (int k = 0; k < 31; k++) {
      bpNoise += clapCoeffs[k] * noise1(uBlockStart + float(x - k) + float(v) * 131.0);
    }
    
    // Add a bit of highpass noise (sizzle) for the high-end air of the clap
    float nzPrev1 = noise1(uBlockStart + float(x - 1) + float(v) * 131.0);
    float hpNoise = nz - nzPrev1;
    
    float clapNoise = mix(bpNoise, hpNoise, 0.12);
    s = clapNoise * env * 1.45;
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
`;
