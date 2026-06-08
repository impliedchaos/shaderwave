#version 300 es
// Bitcrusher carry-state update (renders ONE texel). Writes the held SOURCE value
// for the LAST sample of this block, so the next block can continue a sample-&-hold
// window that straddles the block boundary (see fx-bitcrush.glsl). holdPeriod < BLOCK
// for any rate ≥ ~100 Hz, so the last sample's window always starts within this
// block (heldI ≥ 0) — no recursion needed.
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform int uBlockStart, uBlock;
uniform float uBitcrushRate, uSampleRate;

out vec4 outColor;

void main() {
  float holdPeriod = max(1.0, floor(uSampleRate / max(uBitcrushRate, 1.0)));
  int last = uBlock - 1;
  float holdIdx = floor(float(uBlockStart + last) / holdPeriod) * holdPeriod;
  int heldI = clamp(int(holdIdx) - uBlockStart, 0, uBlock - 1);
  outColor = vec4(texelFetch(uIn, ivec2(heldI, 0), 0).rg, 0.0, 1.0);
}
