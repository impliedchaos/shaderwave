#version 300 es
// Pitch shifter — TAP pass. A time-domain (granular delay-line) pitch shifter: the
// read pointer sweeps the history ring at rate r = 2^(semitones/12) per output
// sample, so playback is slowed / sped up → pitch shifted down / up. d(readpos)/di =
// 1 - uRate·uGrain = r. The wrap discontinuity when the read pointer laps the grain
// window is hidden by running TWO read taps half a window out of phase and
// crossfading them with Hann windows (which sum to unity at the 0.5 offset → no
// amplitude ripple). Output blends dry↔wet by uMix.
//
// Phase continuity: the per-sample read phase is uPhase0 + uRate·i, with uPhase0
// accumulated on the CPU across blocks, so there is no click at block boundaries and
// no float-precision drift over long playback.
precision highp float;
precision highp int;

uniform sampler2D uIn;     // stage input, BLOCK×1 (RG) — the dry signal
uniform sampler2D uRing;   // updated history ring (RG)
uniform int uW, uLen, uWpos;
uniform float uGrain;      // grain / window length in samples
uniform float uPhase0;     // voice 1 read phase at sample 0 of this block, in [0,1)
uniform float uRate;       // voice 1 per-sample phase increment = (1 - r) / grain
uniform float uPhase02;    // voice 2 (harmony) read phase at sample 0, in [0,1)
uniform float uRate2;      // voice 2 (harmony) per-sample phase increment
uniform float uV2Level;    // harmony voice level (0 = off → bit-identical single voice)
uniform float uMix;        // dry/wet (0 = dry, 1 = fully harmonized voices)

out vec4 outColor;
const float TAU = 6.28318530718;

vec2 readRing(float pos){
  float L = float(uLen);
  float w = mod(mod(pos, L) + L, L);             // d-samples-ago wraps to valid history (d < uLen)
  float i0 = floor(w);
  float i1 = mod(i0 + 1.0, L);
  int a = int(i0), b = int(i1);
  vec2 v0 = texelFetch(uRing, ivec2(a % uW, a / uW), 0).rg;
  vec2 v1 = texelFetch(uRing, ivec2(b % uW, b / uW), 0).rg;
  return mix(v0, v1, fract(w));
}

// One pitched voice: two Hann-windowed grain taps half a window out of phase,
// crossfaded (windows sum to unity) to hide the read-pointer wrap. `head` is this
// output sample's ring index; `phase0`/`rate` set the sweep (pitch ratio).
vec2 pitchVoice(float phase0, float rate, float fi, float head){
  float ph0 = fract(phase0 + rate * fi);         // GLSL fract handles rate<0 (pitch up)
  float ph1 = fract(ph0 + 0.5);
  vec2 g0 = readRing(head - ph0 * uGrain);
  vec2 g1 = readRing(head - ph1 * uGrain);
  float w0 = 0.5 - 0.5 * cos(TAU * ph0);
  float w1 = 0.5 - 0.5 * cos(TAU * ph1);
  return g0 * w0 + g1 * w1;
}

void main(){
  int i = int(gl_FragCoord.x);
  vec2 dry = texelFetch(uIn, ivec2(i, 0), 0).rg;
  float fi = float(i), head = float(uWpos + i);    // ring index of this output sample's "now"

  vec2 wet = pitchVoice(uPhase0, uRate, fi, head);              // voice 1
  if (uV2Level > 0.0)
    wet += uV2Level * pitchVoice(uPhase02, uRate2, fi, head);   // voice 2 (harmony), 0 → skipped

  outColor = vec4(mix(dry, wet, uMix), 0.0, 1.0);
}
