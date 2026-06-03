// Stereo feedback delay — ring-buffer UPDATE pass.
//
// The delay line is a persistent 2D texture (uW × uH, linearised as a ring of
// uLen samples, RG = L/R) that ping-pongs across blocks. Each block we rewrite
// only the BLOCK-wide window starting at uWpos; every other texel is copied
// forward unchanged. Because the delay length is forced ≥ BLOCK, the feedback
// tap w[n-D] always lands in already-settled history, so the whole window is
// computed in parallel.
//
//   w[n] = x[n] + feedback · w[n-D]
export const FX_DELAY_UPDATE = /* glsl */`#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uMix;        // dry stereo input, BLOCK×1 (RG)
uniform sampler2D uPrevDelay;  // previous ring state (RG)
uniform int uW, uH, uLen;      // ring dims / length
uniform int uWpos, uBlock;     // write position (mod uLen), block size
uniform int uDelaySamples;     // D (>= uBlock)
uniform float uFeedback;

out vec4 outColor;

int wrap(int p){ return ((p % uLen) + uLen) % uLen; }

void main(){
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  int p = y * uW + x;
  int rel = wrap(p - uWpos);
  if (rel < uBlock) {
    int n = rel;                                 // local sample index in this block
    vec2 xin = texelFetch(uMix, ivec2(n, 0), 0).rg;
    int pd = wrap(p - uDelaySamples);
    vec2 wd = texelFetch(uPrevDelay, ivec2(pd % uW, pd / uW), 0).rg;
    outColor = vec4(xin + uFeedback * wd, 0.0, 1.0);
  } else {
    outColor = texelFetch(uPrevDelay, ivec2(x, y), 0); // carry history forward
  }
}
`;
