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
    // Body: two sine tones at 180 + 330 Hz (808 snare drum tuning)
    float tone1 = oscSine(180.0 * t) * 0.65;
    float tone2 = oscSine(330.0 * t) * 0.35;
    float snareBody = (tone1 + tone2) * exp(-t / 0.055);

    // Noise rattle: ring-modulate raw noise with a HF sine to push energy
    // into the 3–8 kHz "sizzle" range without FIR artifacts.
    float noiseBase = nz;
    float rattleNoise = noiseBase * sin(TAU * 5500.0 * t) * 0.7
                      + noiseBase * sin(TAU * 3200.0 * t) * 0.3;

    float rattleDecay = mix(0.06, 0.35, decay);
    float rattleVol = snap * 1.2;
    float bodyVol = 0.85 - snap * 0.3;

    float click = nz * exp(-t * 600.0) * 0.15;
    s = (snareBody * bodyVol + click
       + rattleNoise * exp(-t / rattleDecay) * rattleVol) * 1.1;
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
    // TR-808 clap: bandpass-range noise through two parallel envelope paths.
    // Ring-modulate noise with sines at ~1 kHz and ~1.5 kHz to move energy
    // into the mid-range band that defines the 808 clap character.
    float n2 = noise1(uBlockStart + float(x) + float(v) * 131.0 + 7919.0);
    float bpNoise = nz  * sin(TAU * 1000.0 * t) * 0.55
                  + n2  * sin(TAU * 1500.0 * t) * 0.35
                  + nz  * sin(TAU * 2200.0 * t) * 0.10;

    // --- Path 1: multi-trigger snap (4 bursts, ~8 ms apart) ---
    float snapEnv = 0.0;
    float burstDecay = 180.0;
    snapEnv += exp(-t * burstDecay);
    if (t > 0.008) snapEnv += 0.85 * exp(-(t - 0.008) * burstDecay);
    if (t > 0.016) snapEnv += 0.70 * exp(-(t - 0.016) * burstDecay);
    if (t > 0.024) snapEnv += 0.55 * exp(-(t - 0.024) * burstDecay);
    snapEnv = min(snapEnv, 1.0);

    // --- Path 2: reverb tail ---
    float tailDec = mix(0.08, 0.4, decay);
    float tailEnv = 0.45 * exp(-t / tailDec);

    float env = snapEnv + tailEnv;
    s = bpNoise * env * 3.5;
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
