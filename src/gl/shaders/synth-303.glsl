// TB-303 acid bassline voice: single oscillator (saw/square) → 4-pole ladder with
// a downward filter envelope. The recursive ladder forces the per-fragment loop:
// each sample recomputes the filter from block-start using carried state.
//
// Params (per voice):
//   uP0 = (cutoffHz, resonance 0..1, envMod 0..1, accent 0..1)
//   uP1 = (wave[0=saw,1=square,2=triangle,3=sine,4=noise], filterDecay s, ampDecay s, _)

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  if (!voiceLive(v)) { outAudio = vec4(0.0); outState = vec4(0.0); return; }

  // Checkpoint at the strip's left edge: the state after the previous sample.
  // For the first strip that's the previous block's last column; otherwise the
  // column the prior strip just wrote.
  int readCol = uSubOffset == 0 ? (uBlock - 1) : (uSubOffset - 1);
  vec4 st = texelFetch(uPrevState, ivec2(readCol, v), 0);
  float freq = uFreq[v], vel = uVel[v];
  vec4 p0 = uP0[v], p1 = uP1[v];
  float baseCut = p0.x, res = p0.y, envmod = p0.z, accent = p0.w;
  float wave = p1.x, fDecay = p1.y, aDecay = p1.z;
  float dt = freq / uSampleRate;

  float y = 0.0;
  for (int i = uSubOffset; i <= x; i++) {
    float t = (float(i) - uOnRel[v]) / uSampleRate;
    if (t < 0.0) continue;                       // before note-on: hold state
    float tRel = (float(i) - uOffRel[v]) / uSampleRate;
    float phase = fract(freq * t);
    float osc;
    if      (wave < 0.5) osc = oscSaw(phase, dt);
    else if (wave < 1.5) osc = oscSquare(phase, dt, 0.5);
    else if (wave < 2.5) osc = oscTri(phase);
    else if (wave < 3.5) osc = oscSine(phase);
    else                 osc = noise1(uBlockStart + float(i));   // filtered by the ladder

    float fenv = exp(-t / max(fDecay, 0.01));     // classic downward sweep
    float amp  = adsr(t, tRel, 0.002, aDecay, 0.85, 0.06);
    float accBoost = 1.0 + accent * 1.5;
    float fc = baseCut * (1.0 + envmod * accBoost * fenv * 6.0);
    fc = clamp(fc, 30.0, uSampleRate * 0.45);
    float g = cutoffToG(fc);
    float r = clamp(res + accent * 0.2, 0.0, 0.98);
    y = ladder(st, osc * amp * 1.3, g, r);
  }
  outAudio = vec4(y * vel, 0.0, 0.0, 1.0);
  outState = st;
}
