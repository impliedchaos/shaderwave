// Mix pass: reads a single instrument's per-voice audio texture (BLOCK×VOICES),
// sums its voice rows with per-voice gain + equal-power pan, and writes one
// stereo row (BLOCK×1, R=left G=right).
export const MIX_FS = /* glsl */`#version 300 es
precision highp float;
precision highp int;
#define VOICES 8

uniform sampler2D uInstTex;
uniform float uGain[VOICES];
uniform float uPan[VOICES];   // 0 = left, 1 = right

out vec4 outColor;

void main(){
  int x = int(gl_FragCoord.x);
  float l = 0.0, r = 0.0;
  for (int v = 0; v < VOICES; v++) {
    float mono = texelFetch(uInstTex, ivec2(x, v), 0).r;
    mono *= uGain[v];
    float p = clamp(uPan[v], 0.0, 1.0);
    l += mono * cos(p * 1.5707963);   // equal-power pan
    r += mono * sin(p * 1.5707963);
  }
  outColor = vec4(l, r, 0.0, 1.0);
}
`;
