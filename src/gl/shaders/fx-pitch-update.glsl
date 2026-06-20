#version 300 es
// Pitch shifter — history ring UPDATE pass. Writes the incoming stage signal into a
// persistent 2D ring (uW×uH, linearised as uLen samples, RG = L/R) so the tap pass
// can read it back at a shifted rate. Mirrors the delay ring MINUS feedback (the
// pitch line is pure input history). Only the BLOCK-wide window starting at uWpos is
// rewritten each block; every other texel carries forward, so the ring always holds
// the most recent uLen samples.
precision highp float;
precision highp int;

uniform sampler2D uIn;     // dry stereo input, BLOCK×1 (RG)
uniform sampler2D uPrev;   // previous ring state (RG)
uniform int uW, uH, uLen;
uniform int uWpos, uBlock;

out vec4 outColor;

int wrap(int p){ return ((p % uLen) + uLen) % uLen; }

void main(){
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  int p = y * uW + x;
  int rel = wrap(p - uWpos);
  if (rel < uBlock) {
    outColor = vec4(texelFetch(uIn, ivec2(rel, 0), 0).rg, 0.0, 1.0);
  } else {
    outColor = texelFetch(uPrev, ivec2(x, y), 0);     // carry history forward
  }
}
