#version 300 es
// Channel vocoder — sum/mix pass. Sums the per-band carrier×envelope rows produced
// by fx-vocoder.glsl back into one BLOCK×1 stereo signal, applies makeup level and
// a dry/wet blend. Non-recursive (a plain gather), so no state.
precision highp float;
precision highp int;

uniform sampler2D uBandTex;     // BLOCK×bands, .rg = carrier band × envelope    unit 0
uniform sampler2D uDry;         // carrier dry, BLOCK×1 (rg = L,R)                unit 1
uniform int   uBands;
uniform int   uBypass;          // 1 → pass carrier straight through (effect off / no key)
uniform float uLevel;           // makeup gain (band-splitting drops level)
uniform float uMix;             // dry/wet (1 = fully vocoded)

layout(location = 0) out vec4 outColor;

void main() {
  int x = int(gl_FragCoord.x);
  vec2 dry = texelFetch(uDry, ivec2(x, 0), 0).rg;

  if (uBypass == 1) {
    outColor = vec4(dry, 0.0, 1.0);
    return;
  }

  vec2 wet = vec2(0.0);
  for (int b = 0; b < uBands; b++) wet += texelFetch(uBandTex, ivec2(x, b), 0).rg;
  wet *= uLevel;
  wet = clamp(wet, -4.0, 4.0);    // explosion guard against resonant buildup; a
                                  // downstream limiter shapes the rest if it's hot
  outColor = vec4(mix(dry, wet, uMix), 0.0, 1.0);
}
