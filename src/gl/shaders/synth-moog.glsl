// Minimoog Model D voice: three oscillators (independent waveform + octave range)
// with analog drift, optional noise, into a 4-pole transistor ladder with mixer
// overdrive, driven by exponential (RC-curve) contour generators. Glide and
// drift are computed analytically so oscillator phase stays continuous across
// render blocks without needing extra state (the one state vec4 is the ladder).
//
// Params (per voice):
//   uP0 = (cutoffHz, resonance 0..1, filterEnvAmt 0..1, kbdTrack 0..1)
//   uP1 = (detuneCents, ampSustain 0..1, filterDecay s, ampDecay s)
//   uP2 = (osc1Wave, osc2Wave, osc3Wave, glide s)
//   uP3 = (osc1Oct, osc2Oct, osc3Oct, noiseMix 0..1)
//   uFreqFrom = pitch the voice glides FROM (set to the note freq when no glide)
// Waveform index: 0 Tri · 1 Saw · 2 Square · 3 Wide Pulse · 4 Narrow Pulse
// Octave index:   0 32' · 1 16' · 2 8' · 3 4' · 4 2'  (offset -2..+2 octaves)
uniform vec4  uP2[VOICES];
uniform vec4  uP3[VOICES];
uniform float uFreqFrom[VOICES];

float moogOsc(int w, float ph, float dt){
  if (w == 0) return oscTri(ph);
  if (w == 1) return oscSaw(ph, dt);
  if (w == 2) return oscSquare(ph, dt, 0.5);
  if (w == 3) return oscSquare(ph, dt, 0.30);
  return oscSquare(ph, dt, 0.12);
}

// Octave index 0..4 → frequency multiplier (32'..2', i.e. 2^-2 .. 2^+2).
float octMult(float idx){ return exp2(floor(idx + 0.5) - 2.0); }

// Exponential ADSR — the Model D's contours charge/discharge an RC, giving a
// snappier attack and a natural curved decay/release vs. a linear ramp.
float mEnvPre(float t, float a, float d, float s){
  if (t < a) return t / max(a, 1e-5);
  float dd = (t - a) / max(d, 1e-5);
  return s + (1.0 - s) * exp(-3.5 * dd);
}
float mAdsr(float t, float tRel, float a, float d, float s, float r){
  if (tRel < 0.0) return mEnvPre(t, a, d, s);
  float lvl = mEnvPre(t - tRel, a, d, s);
  return lvl * exp(-5.0 * tRel / max(r, 1e-5));
}

// Glide: instantaneous frequency and its phase integral (closed form for an
// exponential pitch ramp f0→f1 over T seconds, constant thereafter). Both are
// pure functions of t, so phase is continuous across blocks with no state.
float glideFreq(float f0, float f1, float T, float t){
  if (T < 1e-4 || abs(f1 - f0) < 1e-3 || f0 <= 0.0) return f1;
  return t >= T ? f1 : f0 * pow(f1 / f0, t / T);
}
float glidePhase(float f0, float f1, float T, float t){
  if (T < 1e-4 || abs(f1 - f0) < 1e-3 || f0 <= 0.0) return f1 * t;
  float lr = log(f1 / f0);
  if (t < T) return f0 * T / lr * (pow(f1 / f0, t / T) - 1.0);
  float pT = f0 * T / lr * (f1 / f0 - 1.0);
  return pT + f1 * (t - T);
}

// Moog transistor ladder: 4-pole, tanh saturation, resonance feedback (k→4 self-
// oscillates). No makeup gain, so the low end thins as resonance rises — a Model
// D trait — and a little input drive lets the mixer overdrive the filter.
float ladderMoog(inout vec4 st, float x, float g, float res){
  float k = res * 4.0;
  float in0 = tanh(1.2 * x - k * st.w);
  st.x += g * (in0        - tanh(st.x));
  st.y += g * (tanh(st.x) - tanh(st.y));
  st.z += g * (tanh(st.y) - tanh(st.z));
  st.w += g * (tanh(st.z) - tanh(st.w));
  return st.w;
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  if (!voiceLive(v)) { outAudio = vec4(0.0); outState = vec4(0.0); return; }

  vec4 st = texelFetch(uPrevState, ivec2(uBlock - 1, v), 0);
  float freq = uFreq[v], vel = uVel[v];
  float fromFreq = uFreqFrom[v] > 1.0 ? uFreqFrom[v] : freq;
  vec4 p0 = uP0[v], p1 = uP1[v], p2 = uP2[v], p3 = uP3[v];
  float baseCut = p0.x, res = clamp(p0.y, 0.0, 0.98), envAmt = p0.z, kbdTrack = p0.w;
  float ampSus = p1.y, fDecay = p1.z, aDecay = p1.w;
  float glide = p2.w, noiseMix = p3.w;
  int w1 = int(p2.x + 0.5), w2 = int(p2.y + 0.5), w3 = int(p2.z + 0.5);

  float det = pow(2.0, p1.x / 1200.0);              // symmetric fine detune (osc 2/3)
  float m1 = octMult(p3.x), m2 = octMult(p3.y), m3 = octMult(p3.z);

  // Per-voice static detune so no two notes are perfectly in tune (analog beat).
  float vs = hash11(float(v) * 2.17 + 0.5);
  float s1 = pow(2.0, ((hash11(vs + 0.11) * 2.0 - 1.0) * 2.5) / 1200.0);
  float s2 = pow(2.0, ((hash11(vs + 0.37) * 2.0 - 1.0) * 2.5) / 1200.0);
  float s3 = pow(2.0, ((hash11(vs + 0.71) * 2.0 - 1.0) * 2.5) / 1200.0);

  float invSR = 1.0 / uSampleRate;
  float track = pow(max(freq, 1.0) / 261.6256, kbdTrack);   // filter keyboard tracking

  float y = 0.0;
  for (int i = 0; i <= x; i++) {
    float t = (float(i) - uOnRel[v]) * invSR;
    if (t < 0.0) continue;
    float tRel = (float(i) - uOffRel[v]) * invSR;

    // Slow, subtle drift as a phase offset (continuous & stateless).
    float dr1 = 0.04 * sin(t * 1.3 + vs * 6.28);
    float dr2 = 0.04 * sin(t * 1.7 + vs * 9.42 + 2.0);
    float dr3 = 0.04 * sin(t * 1.1 + vs * 3.14 + 4.0);

    float f0a = fromFreq * m1 * s1,        f1a = freq * m1 * s1;
    float f0b = fromFreq * m2 * det * s2,  f1b = freq * m2 * det * s2;
    float f0c = fromFreq * m3 / det * s3,  f1c = freq * m3 / det * s3;

    float ph1 = fract(glidePhase(f0a, f1a, glide, t) + dr1);
    float ph2 = fract(glidePhase(f0b, f1b, glide, t) + dr2);
    float ph3 = fract(glidePhase(f0c, f1c, glide, t) + dr3);

    float osc = moogOsc(w1, ph1, glideFreq(f0a, f1a, glide, t) * invSR)
              + moogOsc(w2, ph2, glideFreq(f0b, f1b, glide, t) * invSR) * 0.85
              + moogOsc(w3, ph3, glideFreq(f0c, f1c, glide, t) * invSR) * 0.85;
    osc += noiseMix * noise1(uBlockStart + float(i)) * 1.4;
    osc *= 0.34;

    float fEnv = mAdsr(t, tRel, 0.005, fDecay, 0.25, 0.4);
    float amp  = mAdsr(t, tRel, 0.006, aDecay, ampSus, 0.3);
    float fc = baseCut * track * (1.0 + envAmt * fEnv * 8.0);
    fc = clamp(fc, 20.0, uSampleRate * 0.45);
    y = ladderMoog(st, osc * amp, cutoffToG(fc), res);
  }
  outAudio = vec4(y * vel, 0.0, 0.0, 1.0);
  outState = st;
}
