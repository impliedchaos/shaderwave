#version 300 es
// Bitcrusher — bit-depth quantize + sample-rate decimation (zero-order hold) with
// a dry/wet mix. The decimation's sample-&-hold is carried ACROSS blocks via a
// 1-texel state (uPrevHold, written by fx-bitcrush-update.glsl): when the current
// hold window started in the previous block (heldI < 0) we read the carried value
// instead of falling back to the undecimated sample (which caused a ~93 Hz glitch).
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform sampler2D uPrevHold;        // 1 texel: held source value carried from the previous block
uniform int uBitcrushOn, uBlockStart, uBlock;
uniform float uBitcrushBits, uBitcrushRate, uBitcrushMix, uSampleRate;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  vec2 dry = texelFetch(uIn, ivec2(i, 0), 0).rg;
  if (uBitcrushOn == 0) { outColor = vec4(dry, 0.0, 1.0); return; }

  // Decimate: hold the sample captured at the start of each hold window. holdPeriod
  // is whole samples, so the effective rate is SR/N (intentionally stepped/gritty).
  float holdPeriod = max(1.0, floor(uSampleRate / max(uBitcrushRate, 1.0)));
  float holdIdx = floor(float(uBlockStart + i) / holdPeriod) * holdPeriod;
  int heldI = int(holdIdx) - uBlockStart;
  vec2 v = (heldI >= 0) ? texelFetch(uIn, ivec2(heldI, 0), 0).rg     // window started this block
                        : texelFetch(uPrevHold, ivec2(0, 0), 0).rg;  // …or in the previous block

  // Bit-reduce: true mid-tread N-bit → 2^N−1 evenly-spaced levels over [−1,1] that
  // KEEP 0 (silence preserved), symmetric rails, one code unused. bits floored at 2
  // (1-bit degenerates to {0}); ≥33 = bypass quantization. clamp because the float
  // signal can exceed ±1 between stages (saturating quantizer at the rails).
  vec2 crushed = v;
  if (uBitcrushBits < 33.0) {
    float q = exp2(max(uBitcrushBits, 2.0) - 1.0) - 1.0;   // number of steps from 0 to a rail
    crushed = clamp(floor(v * q + 0.5) / q, -1.0, 1.0);
  }

  outColor = vec4(mix(dry, crushed, clamp(uBitcrushMix, 0.0, 1.0)), 0.0, 1.0);
}
