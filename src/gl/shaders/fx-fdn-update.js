// Reverb — feedback delay network (FDN) UPDATE pass.
//
// Four delay lines (one per texture row, ring length uLenF) with a 4×4
// Householder feedback matrix and a 1-zero damping lowpass in the feedback path.
// All line lengths are ≥ BLOCK, so reading the delayed line outputs never touches
// this block's freshly-written window → the whole update is parallel.
//
//   s_j[n] = send·x[n] + decay · (M · d)[j],   d_k = lp(line_k[n - len_k])
//   M = I − 0.5·11ᵀ   (Householder, energy-preserving)
export const FX_FDN_UPDATE = /* glsl */`#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uMix;       // dry stereo input, BLOCK×1
uniform sampler2D uPrevFdn;   // previous FDN state, uLenF×4 (R)
uniform int uLenF, uWpos, uBlock;
uniform int uLens[4];         // per-line delay lengths
uniform float uDecay, uDamp, uSend;

out vec4 outColor;

int wrap(int p){ return ((p % uLenF) + uLenF) % uLenF; }

void main(){
  int x = int(gl_FragCoord.x), row = int(gl_FragCoord.y);
  int rel = wrap(x - uWpos);
  if (rel >= uBlock) { outColor = texelFetch(uPrevFdn, ivec2(x, row), 0); return; }

  int n = rel;
  vec2 m = texelFetch(uMix, ivec2(n, 0), 0).rg;
  float xin = (m.r + m.g) * 0.5 * uSend;

  // Damped reads of all four lines at their delayed positions.
  float d[4];
  for (int k = 0; k < 4; k++) {
    int pk  = wrap(x - uLens[k]);
    int pk1 = wrap(pk - 1);
    float a = texelFetch(uPrevFdn, ivec2(pk,  k), 0).r;
    float b = texelFetch(uPrevFdn, ivec2(pk1, k), 0).r;
    d[k] = mix(a, b, uDamp);
  }
  float sum = d[0] + d[1] + d[2] + d[3];
  float fb = d[row] - 0.5 * sum;            // (M·d)[row]
  outColor = vec4(xin + uDecay * fb, 0.0, 0.0, 1.0);
}
`;
