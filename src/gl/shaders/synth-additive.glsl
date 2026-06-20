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
//   uP4 = (Stereo spread 0..1 [partials fanned L↔R], Freeze 0..1 [resynth: hold sustain spectrum], -, -)
//
// Velocity opens the spectrum (folds into the tilt exponent, anchored at full velocity).
// Coherence / Shimmer / Formant / Stereo default to 0 → bit-identical to the legacy mono formula sound.
//
// RESYNTHESIS (Phase 2): if this voice's instance has an analyzed sample, uSpectra holds
// a TIME-VARYING harmonic profile in 3 rows from slot*ADD_SPECTRA_ROWS — attack amps,
// sustain amps, and a per-harmonic decay rate (harmonic n at texel n-1). Each partial's
// analyzed amplitude morphs attack→sustain over the onset then decays at its own rate, so
// the strike is bright/complex and settles into the body. Morph crossfades the formula
// amplitude into this. Frequencies stay on the harmonic grid for both, so Morph is
// click-free and automatable; morph==0 skips the whole branch → bit-identical to formula.

const int TILE_SZ  = 32;       // partials summed per fragment (must match ADD_TILE in synth-renderer.ts)
const int ADD_MAXN = 2048;     // hard cap (must match ADD_MAXN in synth-renderer.ts)
const int ADD_SPECTRA_K    = 512;  // analyzed harmonics stored per slot (must match synth-renderer.ts)
const int ADD_SPECTRA_ROWS = 3;    // rows per slot: 0 = attack amps, 1 = sustain amps, 2 = decay rate (1/s)
const float ADD_ATK_BLEND  = 0.08; // seconds over which the analyzed attack spectrum morphs into the sustain one

uniform sampler2D uSpectra;    // analyzed profiles: each slot owns ADD_SPECTRA_ROWS rows from slot*ROWS; texel x = harmonic n-1
uniform float uAddSlot[VOICES];// this voice's spectral slot, or <0 if none

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
  float spread  = clamp(uP4[v].x, 0.0, 1.0);            // stereo spread: 0 = mono (bit-identical), 1 = partials fanned L↔R
  float freeze  = clamp(uP4[v].y, 0.0, 1.0);            // resynth Freeze: 0 = analyzed decay (bit-identical), 1 = hold the sustain spectrum forever
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
  float accL = 0.0, accR = 0.0;           // independent L/R sums (stereo spread); equal when spread = 0
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
    if (resynth && n <= ADD_SPECTRA_K) {                            // crossfade into the analyzed, TIME-VARYING profile
      int base    = slot * ADD_SPECTRA_ROWS;
      float aAtk  = texelFetch(uSpectra, ivec2(n - 1, base),     0).r;   // amps at the onset/attack frame
      float aSus  = texelFetch(uSpectra, ivec2(n - 1, base + 1), 0).r;   // amps in the sustain body
      float aRate = texelFetch(uSpectra, ivec2(n - 1, base + 2), 0).r;   // this harmonic's own decay rate (1/s)
      // Freeze: stop the per-harmonic decay AND hold the energetic ATTACK spectrum, not the
      // analyzed sustain — a plucked/struck sample's sustain frames are ~silent, so freezing
      // the sustain would just hold silence. (freeze=0 → ×1 + aBody==aSus, bit-identical.)
      aRate *= 1.0 - freeze;
      float aBody = mix(aSus, aAtk, freeze);
      float ap    = clamp(t / ADD_ATK_BLEND, 0.0, 1.0);                  // bright strike → settled body
      float aAmp  = mix(aAtk, aBody, ap) * exp(-t * aRate);             // sample-extracted per-partial decay
      amp = mix(amp, aAmp, morph);
    } else if (resynth) {
      amp = mix(amp, 0.0, morph);                                  // beyond the analyzed band: fade to silence
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
    float s = amp * env * sin(TAU * (fn * te + phi));
    // Stereo placement: fan each partial across the field by its index (voice-
    // independent, so a chord shares ONE coherent image). Balance law preserves the
    // centre gain (1,1), so spread=0 leaves accL==accR == the legacy mono sum.
    float d = (hash11(float(n) * 3.13) - 0.5) * 2.0 * spread;       // signed position in [-spread, spread]
    accL += s * (1.0 - max( d, 0.0));
    accR += s * (1.0 - max(-d, 0.0));
  }
  // *0.5 once overall (tiles sum in the reducer; final tanh there).
  outAudio = vec4(accL * vel * 0.5, accR * vel * 0.5, 0.0, 1.0);
}
