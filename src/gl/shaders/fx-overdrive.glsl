#version 300 es
// Overdrive stage — Ibanez TS9 Tube Screamer voicing. Three signatures vs the
// DS-1: (1) a BASS CUT before the clipper (the TS feeds a high-passed signal into
// the diodes, so lows stay tight and never get muddy), (2) SOFT, slightly
// ASYMMETRIC clipping (op-amp + diodes → smooth, with even harmonics for warmth)
// instead of a hard clip, and (3) the famous MID-HUMP, which falls out of the
// pre-clip bass cut + post-clip treble roll (the Tone control). Stateless: the
// 1-pole filters are 2-tap FIRs reading the input at i-1 / i-2 (like fx-distortion).
precision highp float;
precision highp int;

uniform sampler2D uIn;
uniform int uOdOn;
uniform float uOdDrive, uOdTone, uOdLevel;

out vec4 outColor;

// Soft asymmetric clip of a bass-trimmed input. `lp` is the local 1-pole lowpass
// (mean of this + previous sample); subtracting part of it cuts lows pre-clip.
vec2 tsClip(vec2 x, vec2 lp, float drive) {
  vec2 tight = x - 0.45 * lp;                  // pre-clip bass cut → the TS "tightness"
  vec2 g = tight * drive;
  const vec2 bias = vec2(0.18);                // asymmetry → even harmonics (warmth)
  return (tanh(g + bias) - tanh(bias)) / tanh(vec2(drive));   // ~level-normalized
}

void main() {
  int i = int(gl_FragCoord.x);
  vec2 x  = texelFetch(uIn, ivec2(i, 0), 0).rg;
  if (uOdOn == 0) { outColor = vec4(x, 0.0, 1.0); return; }
  vec2 x1 = (i > 0) ? texelFetch(uIn, ivec2(i - 1, 0), 0).rg : x;
  vec2 x2 = (i > 1) ? texelFetch(uIn, ivec2(i - 2, 0), 0).rg : x1;

  float drive = max(uOdDrive, 1.0);
  vec2 cur  = tsClip(x,  (x + x1) * 0.5, drive);     // clipped current sample
  vec2 prev = tsClip(x1, (x1 + x2) * 0.5, drive);    // and the previous one (for the tone FIR)

  // Tone = post-clip treble roll. 0 = dark (lowpass), 1 = bright (full).
  vec2 lpOut = (cur + prev) * 0.5;
  vec2 toned = mix(lpOut, cur, clamp(uOdTone, 0.0, 1.0));

  outColor = vec4(toned * uOdLevel, 0.0, 1.0);
}
