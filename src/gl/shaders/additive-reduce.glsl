#version 300 es
// Additive reducer: one log-step of summing the Spectra engine's tile texture.
//
// The synth pass (synth-additive.glsl) writes a BLOCK × (TILES·VOICES) texture, row-
// packed tile-major / voice-minor. Each pass here HALVES the tile axis: output row
// `outRow` (= k*VOICES + v) is the sum of input rows (2k)·VOICES+v and (2k+1)·VOICES+v
// — i.e. two adjacent tiles of the same voice. Run log2(TILES) times (64→…→1),
// ping-ponging textures, until the height is just VOICES — that final write IS the
// engine's BLOCK×VOICES audio texture, where uFinal soft-clips the summed partials.
precision highp float;
precision highp int;
#define VOICES 8

uniform sampler2D uSrc;
uniform int uFinal;        // 1 on the last pass (height → VOICES): tanh the sum

out vec4 outColor;

void main(){
  int x      = int(gl_FragCoord.x);
  int outRow = int(gl_FragCoord.y);
  int k = outRow / VOICES;
  int v = outRow - k * VOICES;
  float a = texelFetch(uSrc, ivec2(x, (2 * k)     * VOICES + v), 0).r;
  float b = texelFetch(uSrc, ivec2(x, (2 * k + 1) * VOICES + v), 0).r;
  float s = a + b;
  if (uFinal == 1) s = tanh(s);
  outColor = vec4(s, 0.0, 0.0, 1.0);
}
