// Pipi — a physically-informed PIANO. Closed-form MODAL synthesis (like the tanpura/
// tabla: no recursion, no carried state) — each sample sums the string's decaying
// partials. A true waveguide would need per-voice delay lines carried across blocks;
// the modal model captures the defining piano physics in closed form instead:
//   • INHARMONICITY — a stiff steel string's partials stretch sharp:
//       fn = n·f0·sqrt(1 + B·n²)   (B ≈ 4e-4). This stretch is what makes a piano
//       sound like a piano and not an organ.
//   • HAMMER STRIKE SPECTRUM — the hammer strikes ~1/8 along the string, so partials
//       near multiples of 8 are suppressed (a comb); a softer/harder felt rolls the
//       highs off more/less (Hardness), and harder hits (velocity) are brighter.
//   • TWO-RATE, FREQUENCY-DEPENDENT DECAY — high partials die fast; each partial has
//       an initial faster stage over a long "aftersound" tail (the piano double-decay).
//   • DETUNED STRING PAIR — ~2 strings per note a few cents apart beat together for the
//       shimmer/aftersound (two slightly-detuned copies per partial).
//   • HAMMER NOISE — a short broadband thunk at onset (the felt contact).
//
// Params (per voice):
//   uP0 = (decay s [aftersound], inharmonicity B, hardness 0..1, hammer 0..1)
//   uP1 = (partials 1..32, detune, damping [hi-partial decay tilt], release s)

const int PIPI_MAXN = 32;

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0);
  outPhase = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;     // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate; // seconds since note-off (<0 held)

  float f0     = uFreq[v];
  float vel    = uVel[v];
  float decay  = max(uP0[v].x, 0.05);     // aftersound (slow) decay of the fundamental
  float B      = max(uP0[v].y, 0.0);      // inharmonicity coefficient
  float hard   = clamp(uP0[v].z, 0.0, 1.0);
  float hammer = clamp(uP0[v].w, 0.0, 1.0);
  int   N      = int(clamp(uP1[v].x, 1.0, float(PIPI_MAXN)));
  float det    = uP1[v].y;                // string-pair detune (fractional)
  float damp   = max(uP1[v].z, 0.0);      // higher → high partials decay faster
  float rel    = max(uP1[v].w, 0.005);    // damper time on key-up (large ≈ sustain pedal)

  // Brightness rises with hammer hardness AND velocity (ff is brighter than pp).
  float bright  = clamp(hard * 0.7 + vel * 0.45, 0.0, 1.0);
  float rolloff = mix(1.6, 0.25, bright);   // high-partial damping exponent
  const float STRIKE = 0.125;               // hammer ~1/8 along the string

  float nyq = uSampleRate * 0.45;
  float acc = 0.0;
  for (int n = 1; n <= PIPI_MAXN; n++){
    if (n > N) break;
    float fn = f0 * float(n) * sqrt(1.0 + B * float(n * n));
    if (fn > nyq) break;

    // Hammer strike spectrum: comb (strike position; floored for hammer width) ×
    // brightness rolloff × ~1/n so the fundamental stays dominant.
    float comb = 0.3 + 0.7 * abs(sin(PI * float(n) * STRIKE));
    float a = comb * exp(-float(n - 1) * rolloff * 0.18) / float(n);

    // Two-rate, frequency-dependent decay (high partials faster; double-decay shape).
    float tauSlow = decay / (1.0 + damp * float(n - 1));
    float tauFast = tauSlow * 0.28;
    float env = 0.72 * exp(-t / tauFast) + 0.28 * exp(-t / tauSlow);

    // Detuned string pair → beating / shimmer (onset-locked phases).
    float phi  = hash11(float(n) + float(v) * 7.13);
    float phi2 = hash11(float(n) * 1.7 + float(v) * 3.1 + 2.0);
    float s1 = sin(TAU * (fn * (1.0 - det) * t + phi));
    float s2 = sin(TAU * (fn * (1.0 + det) * t + phi2));
    acc += a * env * (s1 + s2) * 0.5;
  }

  // Hammer thunk: short broadband contact noise, brighter with a harder hammer;
  // onset-locked (rel0 = samples since note-on) like the 808/tabla.
  float rel0  = float(x) - uOnRel[v];
  float thunk = noise1(rel0 + float(v) * 19.0) * exp(-t * mix(120.0, 320.0, hard)) * hammer * 0.5;

  // Damper on key-up (a long Release simulates the sustain pedal).
  float relGate = tRel < 0.0 ? 1.0 : exp(-tRel / rel);

  float s = (acc * 0.6 + thunk) * relGate * vel;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
