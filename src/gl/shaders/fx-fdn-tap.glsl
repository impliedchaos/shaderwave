#version 300 es
// Reverb stage — TAP pass. Decodes the four FDN lines (already updated) into a
// stereo reverb signal and adds it to the dry stage input. BLOCK×1 stereo out.
precision highp float;
precision highp int;

uniform sampler2D uIn;    // stage input, BLOCK×1 (RG)
uniform sampler2D uFdn;   // updated FDN ring (R, 4 rows)
uniform int uLenF, uWposF;
uniform float uReverbMix;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  vec2 dry = texelFetch(uIn, ivec2(i, 0), 0).rg;

  int pf = (((uWposF + i) % uLenF) + uLenF) % uLenF;
  float s0 = texelFetch(uFdn, ivec2(pf, 0), 0).r;
  float s1 = texelFetch(uFdn, ivec2(pf, 1), 0).r;
  float s2 = texelFetch(uFdn, ivec2(pf, 2), 0).r;
  float s3 = texelFetch(uFdn, ivec2(pf, 3), 0).r;
  vec2 rev = vec2(s0 - s1 + s2 - s3, s0 + s1 - s2 + s3) * 0.5;

  outColor = vec4(dry + uReverbMix * rev, 0.0, 1.0);
}
