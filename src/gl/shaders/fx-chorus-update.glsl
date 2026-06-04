#version 300 es
// Chorus stage — ring UPDATE pass. A short single-row history ring (uLen samples,
// RG) of the chorus input signal, ping-ponged across blocks. Each block rewrites
// the BLOCK-wide window at uWpos; all other texels carry forward. No feedback.
precision highp float;
precision highp int;

uniform sampler2D uIn;     // stage input, BLOCK×1 (RG)
uniform sampler2D uPrev;   // previous ring state (RG)
uniform int uLen, uWpos, uBlock;

out vec4 outColor;

int wrap(int p){ return ((p % uLen) + uLen) % uLen; }

void main() {
  int x = int(gl_FragCoord.x);
  int rel = wrap(x - uWpos);
  if (rel < uBlock) {
    outColor = vec4(texelFetch(uIn, ivec2(rel, 0), 0).rg, 0.0, 1.0);
  } else {
    outColor = texelFetch(uPrev, ivec2(x, 0), 0);
  }
}
