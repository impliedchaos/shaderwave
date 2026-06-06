// Tabla — synthesized modelling of the Indian hand drums (dayan/bayan). Closed-form
// MODAL synthesis (like 808/tanpura: no recursion, no carried state) — each sample is
// a sum of exponentially-decaying, near-harmonic modes. On a real tabla the central
// syahi (tuning paste) loads the membrane so its low modes are ~harmonic, which is
// what gives the drum a definite musical PITCH (set by the played note) rather than a
// dull thud. A short strike transient is the finger/palm contact; Damp shortens the
// ring for closed strokes (te/ka); Bend gives the bayan's palm-heel pitch glide
// (ge/ghe). The bend is a LINEAR chirp so its phase is analytic (no per-block glitch),
// and every mode rides the same bend (phase_n = ratio_n · basePhase).
//
// Params (per voice):
//   uP0 = (decay s, damp 0..1 [open↔closed], strike 0..1, bend semitones)
//   uP1 = (modes 1..12, inharmonicity, bendTime s, tone 0..1 [bright])

const int TABLA_MAXN = 12;

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  // Closed-form: nothing carried. Always write the MRT buffers.
  outState = vec4(0.0);
  outPhase = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;     // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate; // seconds since note-off (<0 held)

  float f0     = uFreq[v];
  float vel    = uVel[v];
  float decay  = max(uP0[v].x, 0.02);
  float damp   = clamp(uP0[v].y, 0.0, 1.0);
  float strike = clamp(uP0[v].z, 0.0, 1.0);
  float bend   = uP0[v].w;                 // semitones (bayan glide; 0 = none)
  int   N      = int(clamp(uP1[v].x, 1.0, float(TABLA_MAXN)));
  float inharm = uP1[v].y;
  float bendT  = max(uP1[v].z, 0.001);
  float tone   = clamp(uP1[v].w, 0.0, 1.0);

  // --- analytic pitch bend: a linear chirp f0 → f1 over bendT, then constant f1.
  // basePhase = cycles of the fundamental accrued up to time t (∫f dt).
  float f1 = f0 * exp2(bend / 12.0);
  float k  = (f1 - f0) / bendT;            // Hz per second during the glide
  float basePhase;
  if (t < bendT) {
    basePhase = f0 * t + 0.5 * k * t * t;
  } else {
    float pT = f0 * bendT + 0.5 * k * bendT * bendT;
    basePhase = pT + f1 * (t - bendT);
  }

  // Closed strokes mute fast: damp shortens the ring (te/ka vs open na/ge).
  float dampMul = mix(1.0, 0.12, damp);

  float nyq = uSampleRate * 0.45;
  float acc = 0.0;
  for (int n = 1; n <= TABLA_MAXN; n++){
    if (n > N) break;
    float ratio = float(n) * sqrt(1.0 + inharm * float(n * n));   // near-harmonic, slight stretch
    float fn = f0 * ratio;
    if (fn > nyq) break;
    // Amplitude profile: strong low modes; Tone lifts the upper ones.
    float a = pow(1.0 / float(n), mix(1.1, 0.5, tone));
    // Per-mode decay: higher modes ring shorter; damp scales the whole tail.
    float tau = decay * dampMul / (1.0 + 0.5 * float(n - 1));
    float env = exp(-t / tau);
    float phi = hash11(float(n) + float(v) * 7.13);   // onset-locked per (mode, voice)
    acc += a * env * sin(TAU * (ratio * basePhase + phi));
  }

  // Strike transient: a short broadband contact click, onset-locked like the 808.
  float rel = float(x) - uOnRel[v];
  float click = noise1(rel + float(v) * 13.0) * exp(-t * 350.0) * strike * 0.6;

  // Gentle note-off mute (lets you choke a ring).
  float relGate = tRel < 0.0 ? 1.0 : exp(-tRel / 0.05);

  float s = (acc * 0.5 + click) * relGate * vel;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
