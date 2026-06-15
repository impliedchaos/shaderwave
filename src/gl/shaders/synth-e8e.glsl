// 888State ("E8E") — a 3-oscillator additive synth with a deliberate 8-bit
// crunch. Closed-form (like 808/dx7/tanpura — no recursion, no carried state):
// one fragment evaluates one output sample as the sum of up to three band-limited
// oscillators through a standard ADSR. Each oscillator is sine / square / triangle
// / noise, and the summed signal is quantized down to 2^Bits levels — at the
// default 8 bits that's the 256-step staircase that gives the engine its lo-fi
// bite (a nod to 808 State, hence the chiptune flavour).
//
// Phase is continuous across blocks because t is note-on-relative (uOnRel keeps
// counting negative as the block window advances), the same trick the 808/tanpura
// use; no MRT state is read or written.
//
// Params (per voice) — the automatable expressive controls live in p0/p1 (only
// those two banks are inst-scope automatable, as with moog):
//   uP0 = (attack s, decay s, sustain 0..1, release s)              — ADSR
//   uP1 = (detune2 semitones, detune3 semitones, bits 1..16, drive 0..1)
//   uP2 = (wave1, wave2, wave3, oscCount 1..3)                      — waves: 0 sine 1 saw 2 square 3 tri 4 noise
//   uP3 = (level1, level2, level3, pulseWidth)

float e8eOsc(float wave, float phase, float dt, float pw, float frame){
  int w = int(wave + 0.5);
  if (w == 0) return oscSinePW(phase, pw);       // PulseW warps every shape, not
  if (w == 1) return oscSawPW(phase, dt, pw);    // just the square (pw=0.5 → the
  if (w == 2) return oscSquare(phase, dt, pw);   // plain wave, bit-for-bit)
  if (w == 3) return oscTriPW(phase, pw);
  return noise1(frame);              // 4 = white noise
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  // Closed-form: nothing carried. Always write the MRT buffers so the bound
  // draw buffers never hold undefined values, even on early return.
  outState = vec4(0.0);
  outPhase = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;     // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate; // seconds since note-off (<0 while held)

  float f0  = uFreq[v];
  float vel = uVel[v];

  float atk = uP0[v].x, dec = uP0[v].y, sus = uP0[v].z, rel = uP0[v].w;

  float det2  = uP1[v].x;            // osc2 detune, semitones (fractional → beating)
  float det3  = uP1[v].y;            // osc3 detune, semitones
  float bits  = clamp(uP1[v].z, 1.0, 16.0);
  float drive = max(uP1[v].w, 0.0);
  float w1 = uP2[v].x, w2 = uP2[v].y, w3 = uP2[v].z;
  int   nOsc  = int(clamp(uP2[v].w, 1.0, 3.0) + 0.5);
  float l1 = uP3[v].x, l2 = uP3[v].y, l3 = uP3[v].z;
  float pw    = clamp(uP3[v].w, 0.02, 0.98);

  float sr = uSampleRate;
  float frame = uBlockStart + float(x);   // absolute frame → continuous noise hiss

  float f1 = f0;
  float f2 = f0 * exp2(det2 / 12.0);
  float f3 = f0 * exp2(det3 / 12.0);

  float acc = l1 * e8eOsc(w1, fract(f1 * t), f1 / sr, pw, frame);
  if (nOsc >= 2) acc += l2 * e8eOsc(w2, fract(f2 * t), f2 / sr, pw, frame + 101.0);
  if (nOsc >= 3) acc += l3 * e8eOsc(w3, fract(f3 * t), f3 / sr, pw, frame + 211.0);
  acc *= 0.5;                         // headroom for three summed oscillators

  // The signature: quantize to 2^bits levels across [-1,1]. 8 bits → 256 steps.
  float steps = exp2(bits - 1.0);
  acc = floor(acc * steps + 0.5) / steps;

  if (drive > 0.0) acc = tanh(acc * (1.0 + drive * 4.0));

  float env = adsr(t, tRel, atk, dec, sus, rel);
  outAudio = vec4(acc * env * vel, 0.0, 0.0, 1.0);
}
