#version 300 es
// 3-Band Equalizer (Low Shelf, Peaking Mid, High Shelf) using two 1st-order
// Linkwitz-Riley crossover filters. A PER-SAMPLE RECURSIVE effect: state is carried
// across samples and blocks in strips via the MRT outState texture.
//
// State layout (one RGBA texel per sample column): (s_low_L, s_high_L, s_low_R, s_high_R)
precision highp float;
precision highp int;

uniform sampler2D uIn;          // dry stereo, BLOCK×1 (rg = L,R)
uniform sampler2D uPrevState;   // carried EQ state (rgba = s_low_L, s_high_L, s_low_R, s_high_R)
uniform int   uBlock;
uniform int   uSubOffset;       // first sample index of this strip
uniform int   uBypass;          // 1 → pass dry straight through (effect off)

// Crossover coefficients (TPT 1st-order LPF)
uniform float uGLow, uALow;
uniform float uGHigh, uAHigh;

// Band gains (linear amplitude)
uniform float uLowGain;
uniform float uMidGain;
uniform float uHighGain;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outState;

void main() {
  int x = int(gl_FragCoord.x);

  if (uBypass == 1) {
    outColor = vec4(texelFetch(uIn, ivec2(x, 0), 0).rg, 0.0, 1.0);
    return;
  }

  int readCol = uSubOffset == 0 ? (uBlock - 1) : (uSubOffset - 1);
  vec4 s = texelFetch(uPrevState, ivec2(readCol, 0), 0);
  float s_low_L = s.x;
  float s_high_L = s.y;
  float s_low_R = s.z;
  float s_high_R = s.w;

  vec2 dry = vec2(0.0);
  vec2 wet = vec2(0.0);

  for (int i = uSubOffset; i <= x; i++) {
    dry = texelFetch(uIn, ivec2(i, 0), 0).rg;

    // Left channel
    float y_low_L = (dry.x * uGLow + s_low_L) * uALow;
    s_low_L = 2.0 * y_low_L - s_low_L;

    float y_high_L = (dry.x * uGHigh + s_high_L) * uAHigh;
    s_high_L = 2.0 * y_high_L - s_high_L;

    float low_L = y_low_L;
    float mid_L = y_high_L - y_low_L;
    float high_L = dry.x - y_high_L;
    wet.x = uLowGain * low_L + uMidGain * mid_L + uHighGain * high_L;

    // Right channel
    float y_low_R = (dry.y * uGLow + s_low_R) * uALow;
    s_low_R = 2.0 * y_low_R - s_low_R;

    float y_high_R = (dry.y * uGHigh + s_high_R) * uAHigh;
    s_high_R = 2.0 * y_high_R - s_high_R;

    float low_R = y_low_R;
    float mid_R = y_high_R - y_low_R;
    float high_R = dry.y - y_high_R;
    wet.y = uLowGain * low_R + uMidGain * mid_R + uHighGain * high_R;
  }

  outColor = vec4(wet, 0.0, 1.0);
  outState = vec4(s_low_L, s_high_L, s_low_R, s_high_R);
}
