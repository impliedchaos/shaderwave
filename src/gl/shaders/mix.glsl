#version 300 es
// Mix pass: reads a single instrument's per-voice audio texture (BLOCK×VOICES),
// sums its voice rows with per-voice gain + equal-power pan, and writes one
// stereo row (BLOCK×1, R=left G=right).
//
// Source channels: mono engines write the sample in .r only. STEREO engines
// (uStereo == 1, e.g. Spectra) write independent L/R in .rg. For mono sources we
// read .r for BOTH channels, so the per-voice pan below is the sole stereo placer
// (bit-identical to the original equal-power mono path). For stereo sources the
// pan acts as a BALANCE on the engine's own image: centre (p=0.5) keeps the full
// stereo field at -3 dB; hard pan favours one channel (its far content fades out).
precision highp float;
precision highp int;
#define VOICES 8

uniform sampler2D uInstTex;
uniform float uGain[VOICES];
uniform float uPan[VOICES];   // 0 = left, 1 = right
uniform int   uStereo;        // 1 = source carries independent L/R in .rg; 0 = mono in .r

out vec4 outColor;

void main(){
  int x = int(gl_FragCoord.x);
  float l = 0.0, r = 0.0;
  for (int v = 0; v < VOICES; v++) {
    vec2 src = texelFetch(uInstTex, ivec2(x, v), 0).rg;
    float sl = src.r;
    float sr = uStereo == 1 ? src.g : src.r;   // mono → centre-sum (sr == sl)
    float g = uGain[v];
    float p = clamp(uPan[v], 0.0, 1.0);
    l += sl * g * cos(p * 1.5707963);   // equal-power pan / stereo balance
    r += sr * g * sin(p * 1.5707963);
  }
  outColor = vec4(l, r, 0.0, 1.0);
}
