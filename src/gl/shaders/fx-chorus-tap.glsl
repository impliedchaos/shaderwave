#version 300 es
// Chorus stage — TAP pass. Reads two modulated taps from the chorus ring (L/R 90°
// out of phase) and blends them with the dry stage input. BLOCK×1 stereo out.
precision highp float;
precision highp int;

uniform sampler2D uIn;     // stage input, BLOCK×1 (RG)
uniform sampler2D uRing;   // updated chorus ring (RG), single row
uniform int uLen, uWpos, uBlockStart;
uniform float uSampleRate, uChorusRate, uChorusDepth, uChorusMix;

out vec4 outColor;

vec2 tapRing(float delaySamples, int i) {
  float pos = float(uWpos + i) - delaySamples;
  float wrapped = mod(mod(pos, float(uLen)) + float(uLen), float(uLen));
  float i0 = floor(wrapped);
  float i1 = mod(i0 + 1.0, float(uLen));
  float frac = fract(wrapped);
  vec2 v0 = texelFetch(uRing, ivec2(int(i0), 0), 0).rg;
  vec2 v1 = texelFetch(uRing, ivec2(int(i1), 0), 0).rg;
  return mix(v0, v1, frac);
}

void main() {
  int i = int(gl_FragCoord.x);
  float t = float(uBlockStart + i) / uSampleRate;
  vec2 dry = texelFetch(uIn, ivec2(i, 0), 0).rg;

  float base = 0.012 * uSampleRate;                       // 12 ms base delay
  float depth = (uChorusDepth / 1000.0) * uSampleRate;
  float dL = base + depth * sin(2.0 * 3.14159265 * uChorusRate * t);
  float dR = base + depth * sin(2.0 * 3.14159265 * uChorusRate * t + 1.57079632);

  vec2 cho = vec2(tapRing(dL, i).r, tapRing(dR, i).g);
  outColor = vec4(mix(dry, cho, uChorusMix), 0.0, 1.0);
}
