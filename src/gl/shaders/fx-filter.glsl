#version 300 es
// Resonant multimode filter — a TPT (topology-preserving transform / Zavalishin)
// state-variable filter, the FX chain's first PER-SAMPLE RECURSIVE effect. Each
// output sample depends on the filter state left by the previous sample, so the
// block can't be computed in parallel; we render it in SUB-wide strips, carrying
// the two integrator states across strips (and across blocks) via the MRT
// outState texture — exactly the mechanism the 303/Moog ladder uses (see
// common.glsl / synth-moog.glsl).
//
// State layout (one RGBA texel per sample column): (ic1L, ic2L, ic1R, ic2R).
// Coefficients a1/a2/a3/k are computed once per block on the CPU from cutoff +
// resonance (block-rate is fine — that's how LFO/automation sweep it).
precision highp float;
precision highp int;

uniform sampler2D uIn;          // dry stereo, BLOCK×1 (rg = L,R)
uniform sampler2D uPrevState;   // carried filter state (rgba = ic1L,ic2L,ic1R,ic2R)
uniform int   uBlock;
uniform int   uSubOffset;       // first sample index of this strip
uniform int   uMode;            // 0 LP · 1 HP · 2 BP
uniform int   uBypass;          // 1 → pass dry straight through (effect off)
uniform float uA1, uA2, uA3, uK;
uniform float uMix;             // dry/wet

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outState;

// One TPT-SVF sample for one channel. st = (ic1, ic2); returns the selected mode.
float svf(inout vec2 st, float x) {
  float v3 = x - st.y;
  float v1 = uA1 * st.x + uA2 * v3;
  float v2 = st.y + uA2 * st.x + uA3 * v3;
  st.x = 2.0 * v1 - st.x;
  st.y = 2.0 * v2 - st.y;
  if (uMode == 0) return v2;                 // low-pass
  if (uMode == 1) return x - uK * v1 - v2;   // high-pass
  return v1;                                 // band-pass
}

void main() {
  int x = int(gl_FragCoord.x);

  if (uBypass == 1) {                         // cheap O(BLOCK) passthrough when off
    outColor = vec4(texelFetch(uIn, ivec2(x, 0), 0).rg, 0.0, 1.0);
    return;                                   // attachment 1 not bound → outState ignored
  }

  // Strip checkpoint: state going INTO this strip = state left after the sample
  // just left of it (the previous strip's last column; for the first strip, the
  // previous BLOCK's last column, which the ping-pong carries across blocks).
  int readCol = uSubOffset == 0 ? (uBlock - 1) : (uSubOffset - 1);
  vec4 s = texelFetch(uPrevState, ivec2(readCol, 0), 0);
  vec2 stL = s.xy, stR = s.zw;

  vec2 dry = vec2(0.0), wet = vec2(0.0);
  for (int i = uSubOffset; i <= x; i++) {
    dry = texelFetch(uIn, ivec2(i, 0), 0).rg;
    wet = vec2(svf(stL, dry.x), svf(stR, dry.y));
  }

  outColor = vec4(mix(dry, wet, uMix), 0.0, 1.0);
  outState = vec4(stL, stR);                  // state after sample x → carried forward
}
