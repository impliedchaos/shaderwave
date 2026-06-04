#version 300 es
// Tremolo / auto-pan stage — stateless amplitude LFO. L/R 180° out of phase so
// it pans. Reads BLOCK×1 stereo, writes BLOCK×1 stereo.
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform int uBlockStart;
uniform float uSampleRate, uTremoloRate, uTremoloMix;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  float t = float(uBlockStart + i) / uSampleRate;
  vec2 s = texelFetch(uIn, ivec2(i, 0), 0).rg;

  float lfoL = 0.5 + 0.5 * sin(2.0 * 3.14159265 * uTremoloRate * t);
  float lfoR = 0.5 + 0.5 * sin(2.0 * 3.14159265 * uTremoloRate * t + 3.14159265);
  vec2 scale = vec2(1.0 - uTremoloMix * lfoL, 1.0 - uTremoloMix * lfoR);

  outColor = vec4(s * scale, 0.0, 1.0);
}
