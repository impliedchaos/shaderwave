// Mini-Moog style mono/poly lead: three detuned saw oscillators → ladder filter
// driven by a dedicated ADSR filter envelope, plus an amp ADSR. Shares the
// recursive ladder with the 303, so it uses the same per-fragment loop.
//
// Params (per voice):
//   uP0 = (cutoffHz, resonance 0..1, filterEnvAmt 0..1, _)
//   uP1 = (detuneCents, ampSustain 0..1, filterDecay s, ampDecay s)

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  if (!voiceLive(v)) { outAudio = vec4(0.0); outState = vec4(0.0); return; }

  vec4 st = texelFetch(uPrevState, ivec2(uBlock - 1, v), 0);
  float freq = uFreq[v], vel = uVel[v];
  vec4 p0 = uP0[v], p1 = uP1[v];
  float baseCut = p0.x, res = p0.y, envAmt = p0.z;
  float detune = p1.x, ampSus = p1.y, fDecay = p1.z, aDecay = p1.w;

  float det = pow(2.0, detune / 1200.0);    // cents → ratio
  float f1 = freq, f2 = freq * det, f3 = freq / det;
  float dt1 = f1 / uSampleRate, dt2 = f2 / uSampleRate, dt3 = f3 / uSampleRate;

  float y = 0.0;
  for (int i = 0; i <= x; i++) {
    float t = (float(i) - uOnRel[v]) / uSampleRate;
    if (t < 0.0) continue;
    float tRel = (float(i) - uOffRel[v]) / uSampleRate;

    float osc = oscSaw(fract(f1 * t), dt1)
              + oscSaw(fract(f2 * t), dt2) * 0.7
              + oscSaw(fract(f3 * t), dt3) * 0.7;
    osc *= 0.4;

    float fEnv = adsr(t, tRel, 0.005, fDecay, 0.25, 0.4);
    float amp  = adsr(t, tRel, 0.006, aDecay, ampSus, 0.3);
    float fc = baseCut * (1.0 + envAmt * fEnv * 8.0);
    fc = clamp(fc, 30.0, uSampleRate * 0.45);
    y = ladder(st, osc * amp, cutoffToG(fc), clamp(res, 0.0, 0.95));
  }
  outAudio = vec4(y * vel, 0.0, 0.0, 1.0);
  outState = st;
}
