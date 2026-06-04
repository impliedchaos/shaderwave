#version 300 es
// Stereo width stage — mid/side scaling. uWidth > 1 widens, < 1 narrows toward
// mono. Reads BLOCK×1 stereo, writes BLOCK×1 stereo.
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform float uWidth;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  vec2 d = texelFetch(uIn, ivec2(i, 0), 0).rg;
  float mid = (d.x + d.y) * 0.5;
  float side = (d.x - d.y) * 0.5 * uWidth;
  outColor = vec4(mid + side, mid - side, 0.0, 1.0);
}
