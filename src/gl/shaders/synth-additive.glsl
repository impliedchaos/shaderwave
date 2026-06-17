// Spectra — a MASSIVE additive engine, the one built to actually use the GPU.
//
// The modal engines (pipi/guitar/tanpura) sum a few dozen partials in a SERIAL inner
// loop inside one fragment, so the GPU's parallel width sits mostly idle. Here the
// partial sum is itself PARALLELISED: this pass renders a BLOCK × (TILES·VOICES)
// texture where each fragment computes a TILE of TILE_SZ partials for ONE sample of
// ONE voice. A separate log-reduce pass (additive-reduce.glsl) then sums the tiles
// down to the BLOCK×VOICES audio texture. Up to 2048 partials/voice → ~8M fragments
// per block — finally enough work to keep the silicon busy (and more than a CPU core
// wants to chew through in real time).
//
// Row packing: gl_FragCoord.y = tile*VOICES + voice  (tile-major, voice-minor) so the
// reducer halves the tile axis by combining adjacent row-pairs.
//
// The spectrum is FORMULA-DRIVEN for now (resynthesis-ready: swap the per-partial
// freq/amp for an uploaded spectral table later): a stretched harmonic series shaped
// by Tilt / Odd-Even / Comb, with per-partial decay and a decorrelated detune spread.
//
// Params (per voice):
//   uP0 = (Partials 1..2048, Tilt 0..1 [dark..bright], Stretch 0..1 [inharmonicity], Morph 0..1 [formula↔analyzed])
//   uP1 = (Decay s [0 = sustain], DecayTilt 0..1 [highs die faster], Detune 0..1 [partial spread], Comb 0..1)
//   uP2 = (Attack s, Release s, OddEven 0..1, Coherence 0..1 [0 = random phase wash, 1 = coherent strike])
//   uP3 = (Shimmer 0..1 [per-partial animation], Formant pos 0..1 [150..5000 Hz], Formant amt [0 = off], Formant BW octaves)
//
// Velocity opens the spectrum (folds into the tilt exponent, anchored at full velocity).
// Coherence / Shimmer / Formant default to 0 → bit-identical to the legacy formula sound.
//
// RESYNTHESIS (Phase 2): if this voice's instance has an analyzed sample, uSpectra holds
// its harmonic amplitude profile (row uAddSlot[v], harmonic n at texel n-1) and Morph
// crossfades the formula amplitude into it. Frequencies stay on the harmonic grid for
// both, so Morph is click-free and automatable.

const int TILE_SZ  = 32;       // partials summed per fragment (must match ADD_TILE in synth-renderer.ts)
const int ADD_MAXN = 2048;     // hard cap (must match ADD_MAXN in synth-renderer.ts)
const int ADD_SPECTRA_K = 512; // analyzed harmonics stored per slot (must match ADD_SPECTRA_K in synth-renderer.ts)

uniform sampler2D uSpectra;    // analyzed harmonic profiles: row = slot, texel x = harmonic n-1
uniform float uAddSlot[VOICES];// this voice's spectral slot row, or <0 if none

void main(){
  int x   = int(gl_FragCoord.x);          // sample within the block
  int row = int(gl_FragCoord.y);          // tile*VOICES + voice
  int v    = row % VOICES;
  int tile = row / VOICES;
  // Closed-form: nothing carried. (Only COLOR_ATTACHMENT0 is bound for this pass,
  // but assign the MRT outs anyway so no declared output is left undefined.)
  outAudio = vec4(0.0); outState = vec4(0.0); outPhase = vec4(0.0); outPhase2 = vec4(0.0);
  if (uActive[v] != 1 || uInst[v] != uInstId) return;

  float t = (float(x) - uOnRel[v]) / uSampleRate;
  if (t < 0.0) return;
  float tRel = (float(x) - uOffRel[v]) / uSampleRate;   // <0 while held

  float f0  = uFreq[v];
  float te  = t + uPhaseOff[v] / max(f0, 1e-6);         // effect-column pitch continuity
  float vel = uVel[v];

  int   N       = int(clamp(uP0[v].x, 1.0, float(ADD_MAXN)) + 0.5);
  float tilt    = clamp(uP0[v].y, 0.0, 1.0);
  float stretch = clamp(uP0[v].z, 0.0, 1.0);
  float morph   = clamp(uP0[v].w, 0.0, 1.0);
  float decay   = max(uP1[v].x, 0.0);
  float decayT  = clamp(uP1[v].y, 0.0, 1.0);
  float detune  = clamp(uP1[v].z, 0.0, 1.0);
  float comb    = clamp(uP1[v].w, 0.0, 1.0);
  float atk     = max(uP2[v].x, 0.0005);
  float rel     = max(uP2[v].y, 0.005);
  float oddeven = clamp(uP2[v].z, 0.0, 1.0);
  float coher   = clamp(uP2[v].w, 0.0, 1.0);            // 0 = decorrelated phase (legacy), 1 = coherent strike
  float shimmer = clamp(uP3[v].x, 0.0, 1.0);            // per-partial amplitude animation depth
  float fmtPos  = clamp(uP3[v].y, 0.0, 1.0);            // formant centre (0..1 → 150..5000 Hz)
  float fmtAmt  = max(uP3[v].z, 0.0);                   // formant peak boost (0 = off → branch skipped)
  float fmtW    = uP3[v].w;                             // formant width in octaves
  int   slot    = int(uAddSlot[v] + 0.5);
  bool  resynth = uAddSlot[v] > -0.5 && morph > 0.0;   // analyzed spectrum available + dialed in

  float B       = stretch * stretch * 0.0015;           // inharmonicity (string → bell/metallic)
  // Velocity opens the spectrum (harder = brighter), anchored at full velocity so vel==1 is neutral.
  float tiltAmt = clamp(tilt + (vel - 1.0) * 0.4, 0.0, 1.0);
  float tiltExp = mix(1.6, 0.25, tiltAmt);              // amplitude rolloff: dark → bright
  float nyq     = uSampleRate * 0.45;

  // One global amplitude envelope (attack → sustain → release) shared by every partial,
  // on top of each partial's own decay.
  float aenv = t < atk ? t / atk : 1.0;
  if (tRel >= 0.0) aenv *= max(0.0, 1.0 - tRel / rel);

  int first = tile * TILE_SZ;             // the partial indices this fragment owns
  float acc = 0.0;
  for (int j = 0; j < TILE_SZ; j++){
    int n = first + j + 1;                // 1-based partial number
    if (n > N) break;
    float fn = f0 * float(n);
    fn *= 1.0 + (hash11(float(n) * 1.7) - 0.5) * detune * 0.03;     // decorrelated detune → chorus/animation
    fn *= sqrt(1.0 + B * float(n * n));                            // inharmonic stretch
    if (fn > nyq) continue;                                         // band-limit
    float amp = pow(1.0 / float(n), tiltExp);                       // spectral tilt
    amp *= (n % 2 == 0) ? mix(1.0, 0.35, oddeven) : mix(0.6, 1.0, oddeven);   // odd/even balance
    amp *= mix(1.0, abs(sin(float(n) * PI * 0.125)), comb);         // pluck-position comb notch
    if (resynth) {                                                  // crossfade into the analyzed harmonic profile
      float aAmp = (n <= ADD_SPECTRA_K) ? texelFetch(uSpectra, ivec2(n - 1, slot), 0).r : 0.0;
      amp = mix(amp, aAmp, morph);
    }
    if (fmtAmt > 0.0) {                                             // movable formant resonance (vowel / body)
      float lf = log2(fn / mix(150.0, 5000.0, fmtPos)) / max(fmtW, 0.05);
      amp *= 1.0 + fmtAmt * exp(-lf * lf * 0.5);
    }
    if (shimmer > 0.0) {                                            // per-partial amplitude animation → alive pad
      float rate = mix(0.5, 6.0, hash11(float(n) * 2.3));           // decorrelated Hz per partial
      float sph  = hash11(float(n) * 4.1 + float(v) * 1.7);
      amp *= 1.0 + shimmer * 0.5 * sin(TAU * (rate * t + sph));
    }
    float env = aenv;
    if (decay > 0.0) {                                              // per-partial decay; highs die faster
      float tau = decay / (1.0 + decayT * 6.0 * float(n - 1) / float(max(N - 1, 1)));
      env *= exp(-t / tau);
    }
    float rnd = hash11(float(n) * 0.731 + float(v) * 5.17);         // decorrelated phase (legacy) → bounded RMS
    float phi = mix(rnd, 0.0, coher);                               // coher=1 → coherent strike (defined attack), click-free
    acc += amp * env * sin(TAU * (fn * te + phi));
  }
  outAudio = vec4(acc * vel * 0.5, 0.0, 0.0, 1.0);    // *0.5 once overall (tiles sum in the reducer; final tanh there)
}
