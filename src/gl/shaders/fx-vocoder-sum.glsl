#version 300 es
// Channel vocoder — sum/mix pass. Sums the per-band carrier×envelope rows produced
// by fx-vocoder.glsl back into one BLOCK×1 stereo signal, applies makeup level and
// a dry/wet blend. Non-recursive (a plain gather), so no state.
precision highp float;
precision highp int;

uniform sampler2D uBandTex;     // BLOCK×(bands+1): band rows = (carrierL,carrierR,env); row uBands = unvoiced  unit 0
uniform sampler2D uDry;         // carrier dry, BLOCK×1 (rg = L,R)                unit 1
uniform int   uBands;
uniform int   uBypass;          // 1 → pass carrier straight through (effect off / no key)
uniform float uLevel;           // makeup gain (band-splitting drops level)
uniform float uMix;             // dry/wet (1 = fully vocoded)
uniform float uUvMix;           // unvoiced/sibilance passthrough amount (0 = off)
uniform float uFormantBands;    // formant shift as a (fractional) band-index offset; + = formants up

layout(location = 0) out vec4 outColor;

void main() {
  int x = int(gl_FragCoord.x);
  vec2 dry = texelFetch(uDry, ivec2(x, 0), 0).rg;

  if (uBypass == 1) {
    outColor = vec4(dry, 0.0, 1.0);
    return;
  }

  // Synthesis: carrier band b is shaped by the envelope of band (b − formantOffset),
  // interpolated between the two nearest source bands (clamped at the edges). Because
  // the bank is log-spaced, a constant band offset == a constant frequency RATIO, so
  // this moves the formant peaks up/down without touching pitch (which is the carrier).
  vec2 wet = vec2(0.0);
  float maxB = float(uBands - 1);
  for (int b = 0; b < uBands; b++) {
    vec2 cb = texelFetch(uBandTex, ivec2(x, b), 0).rg;          // carrier band at fc[b]
    float bf = clamp(float(b) - uFormantBands, 0.0, maxB);      // envelope source band
    int b0 = int(floor(bf));
    int b1 = min(b0 + 1, uBands - 1);
    float frac = bf - float(b0);
    float e0 = texelFetch(uBandTex, ivec2(x, b0), 0).b;
    float e1 = texelFetch(uBandTex, ivec2(x, b1), 0).b;
    wet += cb * mix(e0, e1, frac);
  }
  wet *= uLevel;
  // Add the gated sibilance from the unvoiced detector row (× amount × a small boost).
  wet += (uUvMix * 1.5) * texelFetch(uBandTex, ivec2(x, uBands), 0).rg;
  wet = clamp(wet, -4.0, 4.0);    // explosion guard against resonant buildup; a
                                  // downstream limiter shapes the rest if it's hot
  outColor = vec4(mix(dry, wet, uMix), 0.0, 1.0);
}
