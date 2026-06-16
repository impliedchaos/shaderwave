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
//   • DETUNED STRING CHOIR — 3 strings (trichord) per note in the mid/treble, 2 in the
//       tenor, 1 wound string in the bass, with an asymmetric detune spread that beats.
//   • COHERENT STRIKE + PER-VOICE DETUNE — partials start at phase 0 (zero-start, no
//       click; a defined percussive tone, not a random-phase "synth strings" wash),
//       while a few-cents per-voice detune stops a CHORD's notes phase-locking harshly.
//   • REGISTER VOICING — bass notes carry many more partials and ring longer/brighter;
//       treble is sparser, shorter, softer (key tracking).
//   • SOUNDBOARD BODY — fixed low-mid formant bumps so it reads as a resonant box.
//   • HAMMER NOISE — a short broadband thunk at onset (the felt contact).
//
// Params (per voice):
//   uP0 = (decay s [aftersound], inharmonicity B, hardness 0..1, hammer 0..1)
//   uP1 = (partials 1..32, detune, damping [hi-partial decay tilt], release s)

const int PIPI_MAXN = 64;

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
  float det    = uP1[v].y;                // string detune (fractional)
  float damp   = max(uP1[v].z, 0.0);      // higher → high partials decay faster
  float rel    = max(uP1[v].w, 0.005);    // damper time on key-up (large ≈ sustain pedal)

  // KEY TRACKING — register, ~1 at the bottom of the keyboard, 0 at A4 (440 Hz),
  // negative up top. A real piano rings longer & richer low, shorter & softer high.
  float reg = clamp(log2(440.0 / max(f0, 1.0)) / 4.0, -0.7, 1.0);
  decay *= mix(0.85, 1.7, clamp(reg, 0.0, 1.0));   // bass sustains longer (≈1.0 at middle C)
  decay *= mix(1.0, 0.62, clamp(-reg, 0.0, 1.0));  // treble dies faster

  // MORE PARTIALS IN THE BASS — a low string is rich well past the 1·f0..32·f0 the
  // old fixed cap allowed; treble runs out of room below Nyquist and breaks early.
  float regBoost = clamp(330.0 / max(f0, 1.0), 1.0, 4.0);
  int   N = int(clamp(uP1[v].x * regBoost, 1.0, float(PIPI_MAXN)));

  // STRING COUNT — most notes are a 3-string trichord; the tenor drops to 2 and the
  // lowest notes to a single wound string (monochord).
  float strands = f0 < 110.0 ? 1.0 : (f0 < 220.0 ? 2.0 : 3.0);

  // Per-VOICE micro-detune (a few cents). Inaudible on one note, but it stops a
  // chord's voices from phase-locking on their shared partials — they chorus
  // naturally instead of fusing into a harsh, static beat.
  float vdet = 1.0 + (hash11(float(v) * 3.7 + 11.7) - 0.5) * 0.0035;

  // Brightness rises with hammer hardness, velocity, and (slightly) lower register.
  float bright  = clamp(hard * 0.7 + vel * 0.45 + max(reg, 0.0) * 0.1, 0.0, 1.0);
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

    // SOUNDBOARD BODY — a couple of fixed low-mid formant bumps so the tone reads as
    // a resonant box, not a bare string.
    float body = 1.0 + 0.5 * exp(-pow((fn - 130.0) / 70.0, 2.0))
                     + 0.35 * exp(-pow((fn - 280.0) / 140.0, 2.0));
    a *= body;

    // Two-rate, frequency-dependent decay (high partials faster; double-decay shape).
    float tauSlow = decay / (1.0 + damp * float(n - 1));
    float tauFast = tauSlow * 0.28;
    float env = 0.72 * exp(-t / tauFast) + 0.28 * exp(-t / tauSlow);

    // COHERENT STRIKE — every partial starts at phase 0, so the note begins exactly
    // at zero (no onset click) and the harmonics sum to a defined, percussive piano
    // tone (random phases smear it into a generic "synth strings" wash). The string
    // pair/trio beats via the detune spread; the per-voice vdet keeps CHORDS from
    // phase-locking (so stacked notes don't go harsh) without smearing the timbre.
    float ph = TAU * fn * vdet * t;
    float s = sin(ph);                                          // reference string
    if (strands >= 2.0) s += sin(ph * (1.0 + det));             // sharp string
    if (strands >= 3.0) s += sin(ph * (1.0 - det * 0.7));       // flat string
    acc += a * env * s / strands;
  }

  // Hammer thunk: short broadband contact noise, brighter with a harder hammer;
  // onset-locked (rel0 = samples since note-on) like the 808/tabla.
  float rel0  = float(x) - uOnRel[v];
  float thunk = noise1(rel0 + float(v) * 19.0) * exp(-t * mix(120.0, 320.0, hard)) * hammer * 0.5;

  // Damper on key-up (a long Release simulates the sustain pedal).
  float relGate = tRel < 0.0 ? 1.0 : exp(-tRel / rel);

  // Output trimmed (0.6 → 0.48) so dense, loud chords keep headroom rather than
  // slamming the mix/limiter into harshness; bump the instrument/song level to taste.
  float s = (acc * 0.48 + thunk) * relGate * vel;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
