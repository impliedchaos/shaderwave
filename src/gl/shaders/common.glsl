#version 300 es
// Shared GLSL prelude prepended to every instrument fragment shader. It declares
// the uniform contract, the two MRT outputs, and a library of audio primitives
// (band-limited oscillators, noise, ADSR, the transistor ladder filter).
//
// Coordinate convention for every synth shader:
//   gl_FragCoord.x  → sample index within the block  (0 .. uBlock-1)
//   gl_FragCoord.y  → voice / tracker-channel index  (0 .. VOICES-1)
//
// A voice belongs to exactly one instrument; a program only renders rows where
// uInst[v] == uInstId, writing silence elsewhere so the mix can blindly sum.
//
// Times are all relative to note-on (uOnRel), which keeps float magnitudes small
// and makes oscillator phase reset cleanly at each note.
precision highp float;
precision highp int;
#define VOICES 8

uniform float uSampleRate;
uniform float uBlockStart;      // absolute frame of sample x=0 (for noise continuity)
uniform int   uBlock;
uniform int   uSubOffset;       // first sample index of the current sub-block strip (recursive synths)
uniform int   uInstId;
uniform int   uActive[VOICES];
uniform int   uInst[VOICES];
uniform float uFreq[VOICES];
uniform float uVel[VOICES];
uniform float uOnRel[VOICES];   // note-on frame, relative to block start (may be < 0)
uniform float uOffRel[VOICES];  // note-off frame, relative; +1e9 sentinel while held
uniform vec4  uP0[VOICES];      // per-instrument param bank A
uniform vec4  uP1[VOICES];      // per-instrument param bank B
uniform sampler2D uPrevState;   // previous block's end-of-block state (ladder etc.)
uniform sampler2D uPrevPhase;   // previous block's end-of-block phase
uniform sampler2D uPrevPhase2;  // for DX7 operators 5/6

layout(location = 0) out vec4 outAudio;  // R = this voice's mono sample
layout(location = 1) out vec4 outState;  // carried recursive state (e.g. ladder)
layout(location = 2) out vec4 outPhase;  // carried phase
layout(location = 3) out vec4 outPhase2; // carried phase 2

const float PI  = 3.14159265358979;
const float TAU = 6.28318530717959;

// --- noise -----------------------------------------------------------------
// NB: the multiplier must not be a rational approximation of anything with a
// short period. 1/π (0.3183099) is fatal here — 355·(1/π) ≈ 113, so fract()
// repeats every 355 samples and "noise" becomes a 135 Hz buzz. 0.1031 (Dave
// Hoskins' hash) has no such short period.
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float noise1(float x){ return hash11(x) * 2.0 - 1.0; }

// --- band-limited oscillators (polyBLEP) -----------------------------------
float polyBlep(float t, float dt){
  if (t < dt)        { t /= dt;            return t + t - t * t - 1.0; }
  if (t > 1.0 - dt)  { t = (t - 1.0) / dt; return t * t + t + t + 1.0; }
  return 0.0;
}
float oscSaw(float phase, float dt){
  return (2.0 * phase - 1.0) - polyBlep(phase, dt);
}
float oscSquare(float phase, float dt, float pw){
  float v = phase < pw ? 1.0 : -1.0;
  v += polyBlep(phase, dt);
  v -= polyBlep(fract(phase + (1.0 - pw)), dt);
  return v;
}
float oscTri(float phase){ return 1.0 - 4.0 * abs(fract(phase + 0.25) - 0.5); }
float oscSine(float phase){ return sin(TAU * phase); }

// --- envelope --------------------------------------------------------------
// Pre-release ADSR value at time t (seconds since note-on).
float envPre(float t, float a, float d, float s){
  if (t < a)     return t / max(a, 1e-5);
  if (t < a + d) return 1.0 - (1.0 - s) * ((t - a) / max(d, 1e-5));
  return s;
}
// Full ADSR. tRel = seconds since note-off (negative while held). Linear release
// from whatever level the pre-release envelope had reached at the moment of release.
float adsr(float t, float tRel, float a, float d, float s, float r){
  if (tRel < 0.0) return envPre(t, a, d, s);
  float lvlAtRelease = envPre(t - tRel, a, d, s);
  return max(0.0, lvlAtRelease * (1.0 - tRel / max(r, 1e-5)));
}

// 4-stage envelope (DX7 style)
float envPre4(float t, vec4 times, vec4 levels) {
  if (t < times.x) return mix(0.0, levels.x, t / max(times.x, 1e-5));
  t -= times.x;
  if (t < times.y) return mix(levels.x, levels.y, t / max(times.y, 1e-5));
  t -= times.y;
  if (t < times.z) return mix(levels.y, levels.z, t / max(times.z, 1e-5));
  return levels.z;
}

float env4(float t, float tRel, vec4 times, vec4 levels) {
  if (tRel < 0.0) return envPre4(t, times, levels);
  float lvlAtRelease = envPre4(t - tRel, times, levels);
  float rt = clamp(tRel / max(times.w, 1e-5), 0.0, 1.0);
  return mix(lvlAtRelease, levels.w, rt);
}

// --- transistor ladder filter (4-pole, nonlinear feedback) -----------------
// state.xyzw = the four one-pole stage outputs. g = per-sample coefficient
// (≈ 1 - exp(-2π·fc/SR)), res in 0..1 (→ feedback up to self-oscillation).
float ladder(inout vec4 st, float x, float g, float res){
  float k = res * 4.0;
  float in0 = x - k * st.w;
  st.x += g * (tanh(in0) - tanh(st.x));
  st.y += g * (tanh(st.x) - tanh(st.y));
  st.z += g * (tanh(st.y) - tanh(st.z));
  st.w += g * (tanh(st.z) - tanh(st.w));
  return st.w;
}
float cutoffToG(float fcHz){
  return clamp(1.0 - exp(-TAU * fcHz / uSampleRate), 0.0001, 0.99);
}

// Is this fragment a live voice for the current instrument program?
bool voiceLive(int v){ return uActive[v] == 1 && uInst[v] == uInstId; }
