#version 300 es
// Terminal master stage — applies master gain and is drawn with additive blending
// so each instrument's processed output accumulates into the shared mix buffer.
// Always runs last, after the reorderable effect chain.
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform float uMaster;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  vec2 d = texelFetch(uIn, ivec2(i, 0), 0).rg;
  outColor = vec4(d * uMaster, 0.0, 1.0);
}
