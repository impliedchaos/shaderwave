#version 300 es
// Delay stage — TAP pass. Reads the delayed sample from the (already-updated)
// delay ring and adds it to the dry stage input. BLOCK×1 stereo out.
precision highp float;
precision highp int;

uniform sampler2D uIn;      // stage input, BLOCK×1 (RG)
uniform sampler2D uDelay;   // updated delay ring (RG)
uniform int uW, uLen, uWpos, uDelaySamples;
uniform float uDelayMix;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  vec2 dry = texelFetch(uIn, ivec2(i, 0), 0).rg;
  int pd = (((uWpos + i - uDelaySamples) % uLen) + uLen) % uLen;
  vec2 del = texelFetch(uDelay, ivec2(pd % uW, pd / uW), 0).rg;
  outColor = vec4(dry + uDelayMix * del, 0.0, 1.0);
}
