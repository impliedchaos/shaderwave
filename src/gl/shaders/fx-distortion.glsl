#version 300 es
// Distortion stage — Roland/BOSS DS-1 diode hard-clip + a 2-tap FIR tone tilt.
// Reads BLOCK×1 stereo, writes BLOCK×1 stereo. The tone filter needs the previous
// sample, which it reads straight from the input texture at i-1 (i==0 reuses i).
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform float uDist, uTone, uDistLevel;

out vec4 outColor;

vec2 dsClip(vec2 wet, float distVal, float norm, float level) {
  vec2 inp = wet * distVal;
  vec2 d = inp / pow(vec2(1.0) + pow(abs(inp), vec2(3.0)), vec2(1.0 / 3.0));
  return d * norm * level;
}

void main() {
  int i = int(gl_FragCoord.x);
  vec2 wet = texelFetch(uIn, ivec2(i, 0), 0).rg;

  float distVal = max(uDist, 0.001);
  float norm = pow(1.0 + pow(distVal, 3.0), 1.0 / 3.0) / distVal;

  vec2 cur = dsClip(wet, distVal, norm, uDistLevel);
  vec2 wetPrev = (i > 0) ? texelFetch(uIn, ivec2(i - 1, 0), 0).rg : wet;
  vec2 prev = dsClip(wetPrev, distVal, norm, uDistLevel);

  // FIR tone tilt: blend toward the lowpass (dark) or highpass (bright) half.
  vec2 LP = (cur + prev) * 0.5;
  vec2 HP = cur - LP;
  vec2 driven = cur;
  if (uTone < 0.5) driven = mix(LP, cur, uTone * 2.0);
  else             driven = mix(cur, HP * 2.5, (uTone - 0.5) * 2.0);

  outColor = vec4(driven, 0.0, 1.0);
}
