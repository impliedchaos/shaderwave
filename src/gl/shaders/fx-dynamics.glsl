#version 300 es
// Shared dynamics processor — drives both the Compressor and the (transparent)
// Limiter (same math, different param ranges). A PER-SAMPLE RECURSIVE effect: the
// envelope follower's output feeds back into its next sample, so it renders in
// strips carrying the envelope across strips/blocks via the MRT outState texture
// (the same mechanism as fx-filter / the synth ladder — see EffectsChain._recursive).
//
// Detection is STEREO-LINKED: one peak detector on max(|L|,|R|) → one gain applied
// equally to both channels, so the stereo image is preserved (no L/R wander). The
// gain law is computed in the log domain but expressed in closed form:
//   above threshold:  gain = (env / thresh) ^ (-slope),  slope = 1 - 1/ratio
//   → ratio 4   ⇒ slope 0.75 (gentle compression)
//   → ratio ∞   ⇒ slope 1.0  ⇒ gain = thresh/env ⇒ peak pinned to thresh (limiter)
// State (one texel): env in .r.
precision highp float;
precision highp int;

uniform sampler2D uIn;          // dry stereo, BLOCK×1 (rg = L,R)
uniform sampler2D uPrevState;   // carried envelope (r = env)
uniform int   uBlock;
uniform int   uSubOffset;
uniform int   uBypass;          // 1 → pass dry through (effect off)
uniform float uAtkCoef, uRelCoef;   // one-pole attack/release coefficients
uniform float uThreshLin;       // threshold / ceiling (linear amplitude)
uniform float uSlope;           // 1 - 1/ratio
uniform float uMakeup;          // linear makeup gain (limiter: 1)

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outState;

void main() {
  int x = int(gl_FragCoord.x);

  if (uBypass == 1) {            // cheap O(BLOCK) passthrough when off
    outColor = vec4(texelFetch(uIn, ivec2(x, 0), 0).rg, 0.0, 1.0);
    return;
  }

  int readCol = uSubOffset == 0 ? (uBlock - 1) : (uSubOffset - 1);
  float env = texelFetch(uPrevState, ivec2(readCol, 0), 0).r;

  vec2 dry = vec2(0.0);
  for (int i = uSubOffset; i <= x; i++) {
    dry = texelFetch(uIn, ivec2(i, 0), 0).rg;
    float d = max(abs(dry.x), abs(dry.y));        // stereo-linked peak detector
    float coef = d > env ? uAtkCoef : uRelCoef;   // attack rising, release falling
    env += coef * (d - env);
  }

  float gain = env > uThreshLin ? pow(env / uThreshLin, -uSlope) : 1.0;
  outColor = vec4(dry * gain * uMakeup, 0.0, 1.0);
  outState = vec4(env, 0.0, 0.0, 0.0);
}
