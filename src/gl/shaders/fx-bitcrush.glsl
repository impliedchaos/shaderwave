#version 300 es
// Bitcrusher stage — bit-depth quantize + sample-rate decimation (sample & hold).
// Because this runs as its own stage, the input is already the fully-processed
// upstream signal, so the held sample is just re-read from the input texture
// (no need to re-derive distortion as the old monolithic pass did).
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform int uBitcrushOn, uBlockStart, uBlock;
uniform float uBitcrushBits, uBitcrushRate, uSampleRate;

out vec4 outColor;

void main() {
  int i = int(gl_FragCoord.x);
  vec2 s = texelFetch(uIn, ivec2(i, 0), 0).rg;

  if (uBitcrushOn != 0) {
    float levels = pow(2.0, uBitcrushBits);
    // Decimate: hold the sample at the start of each hold period.
    float holdPeriod = max(1.0, floor(uSampleRate / max(uBitcrushRate, 1.0)));
    float sampleIdx = float(uBlockStart + i);
    float holdIdx = floor(sampleIdx / holdPeriod) * holdPeriod;
    int heldI = int(holdIdx) - uBlockStart;
    vec2 v = (heldI >= 0 && heldI < uBlock) ? texelFetch(uIn, ivec2(heldI, 0), 0).rg : s;
    s = floor(v * levels + 0.5) / levels;
  }

  outColor = vec4(s, 0.0, 1.0);
}
