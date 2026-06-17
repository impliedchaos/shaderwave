// Tanpura — the Indian drone. Closed-form additive/modal synthesis (like 808/dx7,
// no recursion, no carried state): each sample is a sum of decaying partials, so a
// single fragment evaluates one output sample directly.
//
// The whole character lives in the JIVARI — the buzzing overtone bloom from the
// string grazing a curved bridge with a cotton thread (juari) under it. A real
// jivari continuously pumps energy from low modes into high ones during the decay,
// so the spectral centroid RISES then sustains bright (a normal plucked string
// does the opposite — highs die first). We model that as a gaussian spectral
// formant in log-frequency whose centre sweeps upward over `bloom` seconds and
// then holds, selectively boosting the partials it passes over → the "waaah" buzz.
//
// Params (per voice):
//   uP0 = (decay s [fundamental], jivari 0..1, brightTilt, pluckPos 0..1)
//   uP1 = (numPartials, inharmonicity B, bloom s, attack s)
// Phase is continuous across blocks because t is note-on-relative (uOnRel), the
// same trick the 808 uses; partial phases are seeded from (n,voice) so a pluck is
// onset-locked (identical every trigger) rather than wall-clock dependent.

const int TANPURA_MAXN = 64;

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  // Closed-form: no recursive state to carry. Always write the MRT outputs (even
  // on early-return) so the 4 bound draw buffers never get undefined values.
  outState = vec4(0.0);
  outPhase = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;     // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate; // seconds since note-off (<0 while held)

  float f0     = uFreq[v];
  float vel    = uVel[v];
  // Effect-column pitch continuity (see engine._accumPhaseOff): te == t for a steady
  // drone (uPhaseOff 0 → bit-identical), and keeps the partials phase-continuous if a
  // slide/vibrato moves the pitch mid-note.
  float te     = t + uPhaseOff[v] / max(f0, 1e-6);
  float decay  = max(uP0[v].x, 0.02);
  float jivari = uP0[v].y;
  float tilt   = uP0[v].z;     // how much faster high partials decay (0 = all equal)
  float pluck  = uP0[v].w;     // pluck position → comb in the initial spectrum
  int   N      = int(clamp(uP1[v].x, 1.0, float(TANPURA_MAXN)));
  float inharm = uP1[v].y;     // stiffness → slight stretch + beating
  float bloom  = max(uP1[v].z, 1e-3);
  float attack = max(uP1[v].w, 1e-4);
  bool  infinite = uP2[v].x > 0.5;   // drone forever: partials never decay

  // Jivari formant: centre frequency sweeps up from ~2nd to ~26th harmonic over
  // `bloom` seconds, then holds. width is in octaves (log2), so the bright band is
  // broad and the buzz reads as a sustained shimmer rather than a single tone.
  float center = mix(2.0 * f0, 26.0 * f0, 1.0 - exp(-t / bloom));
  float lc = log2(max(center, 1.0) / f0);
  const float WIDTH = 1.3;

  float nyq = uSampleRate * 0.45;
  float acc = 0.0;
  for (int n = 1; n <= TANPURA_MAXN; n++){
    if (n > N) break;
    float fn = f0 * float(n) * sqrt(1.0 + inharm * float(n * n));   // inharmonic stretch
    if (fn > nyq) break;

    // Base pluck spectrum: comb from the pluck point (a string plucked at p has
    // node-suppressed harmonics) with a gentle ~1/n rolloff.
    float a = abs(sin(PI * float(n) * pluck)) / float(n);

    // Per-partial decay: higher partials decay faster (tilt). Kept gentle so the
    // jivari can keep the highs alive — that long bright tail is the tanpura.
    // Infinite mode holds every partial at full so the drone never dies (the
    // global attack still fades it in; note-off still releases it).
    float tau = decay / (1.0 + tilt * float(n - 1));
    float env = infinite ? 1.0 : exp(-t / tau);

    // Jivari bloom: gaussian in log-freq centred on the sweeping formant.
    float lf = log2(fn / f0);
    float d = (lf - lc) / WIDTH;
    float bump = exp(-d * d);
    float gain = a * (1.0 + jivari * bump * 5.0);

    float phi = hash11(float(n) + float(v) * 7.13);          // fixed per (partial, voice)
    acc += gain * env * sin(TAU * (fn * te + phi));
  }

  // Attack fade-in (a few ms, no click) + a short broadband pluck "chiff", seeded
  // onset-locked (rel = samples since note-on) like the 808 drums.
  float atk = clamp(t / attack, 0.0, 1.0);
  float rel = float(x) - uOnRel[v];
  float chiff = noise1(rel + float(v) * 17.0) * exp(-t * 90.0) * 0.2;

  // Note-off release: a gentle exponential tail so a key-up doesn't click.
  float relGate = tRel < 0.0 ? 1.0 : exp(-tRel / 0.4);

  float s = (acc * 0.16 + chiff) * atk * relGate * vel;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
