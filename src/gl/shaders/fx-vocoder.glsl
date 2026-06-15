#version 300 es
// Channel vocoder — analysis/synthesis pass. Imposes the spectral envelope of a
// MODULATOR (another instrument instance, read from the sidechain dry bus) onto a
// CARRIER (this effect's insert signal). For each of N frequency bands we bandpass
// BOTH carrier and modulator, follow the modulator band's amplitude, and multiply
// the carrier band by that envelope. A later pass sums the bands.
//
// BANDS RUN AS TEXTURE ROWS (like the reverb FDN's lines): the output + state
// textures are BLOCK×(bands+1), so band b lives in row b and carries its own
// per-sample recursive state. This is the only way to hold N bands of state — the
// shared _recursive helper carries just one RGBA texel, nowhere near enough.
//
// THE EXTRA ROW (index == uBands) is the UNVOICED DETECTOR. Consonants/sibilants
// (s, t, f, sh) are broadband noise a tonal carrier can't voice, so they smear. This
// row measures how "unvoiced" the modulator is (high-freq energy vs low-freq energy)
// and emits the modulator's own high-passed signal gated by that measure; the sum
// pass mixes it in (× vocUnvoiced) so the real sibilants are heard on top of the
// vocoded body. It reuses the exact strip + MRT state-carry mechanism.
//
// PER-SAMPLE RECURSIVE: each sample depends on the previous sample's state, so the
// block is rendered in SUB-wide strips that carry state across strips (and blocks)
// via the MRT outState textures, exactly like fx-filter/fx-eq.
//
// Band rows  — State A: carrier SVF (ic1L,ic2L,ic1R,ic2R); State B: (ic1mod,ic2mod,env,-)
// Unvoiced row — State A: (lpLo, lpHi, envLF, envHF); State B: unused
precision highp float;
precision highp int;

#define MAX_BANDS 16

uniform sampler2D uIn;          // carrier (dry stereo), BLOCK×1 (rg = L,R)        unit 0
uniform sampler2D uPrevStateA;  // carrier SVF state per band                       unit 1
uniform sampler2D uPrevStateB;  // modulator SVF + envelope per band                unit 2
uniform sampler2D uKeyTex;      // modulator dry bus (instDryTex), BLOCK×rows        unit 5
uniform int   uBlock;
uniform int   uSubOffset;       // first sample index of this strip
uniform int   uBands;           // active band count (≤ MAX_BANDS); row uBands = unvoiced
uniform int   uKeyRow;          // modulator instance row in uKeyTex (≥ 0 here)
uniform float uA1[MAX_BANDS], uA2[MAX_BANDS], uA3[MAX_BANDS], uK[MAX_BANDS];
uniform float uAtk, uRel;       // band envelope follower one-pole coefficients

// Unvoiced detector (the extra row): two 1st-order TPT low-passes split the
// modulator into low/high energy; fast envelopes + a gate decide "sibilance".
uniform float uUvGLo, uUvALo;   // low corner (~voiced energy, e.g. 700 Hz)
uniform float uUvGHi, uUvAHi;   // high corner (~sibilance, e.g. 3500 Hz)
uniform float uUvAtk, uUvRel;   // detector envelope coefficients (fast)
uniform float uUvThr;           // gate threshold on HF/(HF+LF)

layout(location = 0) out vec4 outColor;    // band: carrier band × env (stereo); uv row: gated HF
layout(location = 1) out vec4 outStateA;
layout(location = 2) out vec4 outStateB;

// One TPT/Zavalishin SVF sample for one channel; returns the BANDPASS tap (v1). The
// caller scales by k (=1/Q) so the band has UNITY peak gain at center regardless of
// Q — the normalization a naive vocoder omits, which makes the bank explode at high Q.
float svfbp(inout vec2 st, float x, float a1, float a2, float a3) {
  float v3 = x - st.y;
  float v1 = a1 * st.x + a2 * v3;
  float v2 = st.y + a2 * st.x + a3 * v3;
  st.x = 2.0 * v1 - st.x;
  st.y = 2.0 * v2 - st.y;
  return v1;
}

void main() {
  int x = int(gl_FragCoord.x);
  int b = int(gl_FragCoord.y);          // row: 0..uBands-1 = band; uBands = unvoiced detector

  // Strip checkpoint: state going into this strip = state after the sample just left
  // of it (previous strip's last column; for strip 0 the previous block's last column,
  // carried by the ping-pong). Read at this row.
  int readCol = uSubOffset == 0 ? (uBlock - 1) : (uSubOffset - 1);

  if (b >= uBands) {
    // ── Unvoiced detector row ────────────────────────────────────────────────
    vec4 sA = texelFetch(uPrevStateA, ivec2(readCol, b), 0);
    float lpLo = sA.x, lpHi = sA.y, envLF = sA.z, envHF = sA.w;
    float uv = 0.0;
    for (int i = uSubOffset; i <= x; i++) {
      vec2 key = texelFetch(uKeyTex, ivec2(i, uKeyRow), 0).rg;
      float m = 0.5 * (key.x + key.y);
      float yLo = (m * uUvGLo + lpLo) * uUvALo; lpLo = 2.0 * yLo - lpLo;
      float yHi = (m * uUvGHi + lpHi) * uUvAHi; lpHi = 2.0 * yHi - lpHi;
      float hf = m - yHi;                          // high-passed modulator = sibilance
      float lf = yLo;                              // low-passed = voiced energy
      float aHF = abs(hf), aLF = abs(lf);
      envHF += (aHF > envHF ? uUvAtk : uUvRel) * (aHF - envHF);
      envLF += (aLF > envLF ? uUvAtk : uUvRel) * (aLF - envLF);
      float u = envHF / (envHF + envLF + 1e-5);    // 0 voiced … 1 unvoiced
      float gate = smoothstep(uUvThr, uUvThr + 0.25, u);
      uv = hf * gate;
    }
    outColor  = vec4(uv, uv, 0.0, 1.0);            // mono sibilance into both channels
    outStateA = vec4(lpLo, lpHi, envLF, envHF);
    outStateB = vec4(0.0);
    return;
  }

  // ── Voiced band row (b < uBands ≤ MAX_BANDS, so uA*[b] is in range) ──────────
  float a1 = uA1[b], a2 = uA2[b], a3 = uA3[b], k = uK[b];
  vec4 sA = texelFetch(uPrevStateA, ivec2(readCol, b), 0);
  vec4 sB = texelFetch(uPrevStateB, ivec2(readCol, b), 0);
  vec2 stCarL = sA.xy, stCarR = sA.zw;
  vec2 stMod = sB.xy;
  float env = sB.z;

  vec2 cband = vec2(0.0);
  for (int i = uSubOffset; i <= x; i++) {
    vec2 car = texelFetch(uIn, ivec2(i, 0), 0).rg;
    vec2 key = texelFetch(uKeyTex, ivec2(i, uKeyRow), 0).rg;
    float m = 0.5 * (key.x + key.y);                 // modulator summed to mono

    cband = vec2(k * svfbp(stCarL, car.x, a1, a2, a3),
                 k * svfbp(stCarR, car.y, a1, a2, a3));

    float mb = k * svfbp(stMod, m, a1, a2, a3);       // modulator band (unity-normalized)
    float d = abs(mb);
    float coef = d > env ? uAtk : uRel;               // attack rising, release falling
    env += coef * (d - env);
  }

  outColor  = vec4(cband * env, 0.0, 1.0);
  outStateA = vec4(stCarL, stCarR);
  outStateB = vec4(stMod, env, 0.0);
}
