// Wavewright ("WVT") — a wavetable synth. Two oscillators read a baked wavetable
// texture (16 morph banks × 64 frames × 1024 samples — see src/instruments/
// wavetables.ts), each at a continuous morph Position, mixed with a sine sub and
// an optional cross-FM (osc2 phase-modulates osc1). One fragment = one output
// sample; oscillator phase is PHASE-ACCUMULATED across blocks via the MRT phase
// carry (see main), so detune/pitch modulation stays click-free.
//
// The wavetable is BAND-LIMITED: the renderer uploads WT_MIPS harmonic-limited
// copies of every frame and wtSample() picks/blends the mip whose top harmonic
// stays under Nyquist for the playing note (anti-aliasing).
//
// Params (per voice) — automatable ones live in p0/p1:
//   uP0 = (attack s, decay s, sustain 0..1, release s)            — ADSR
//   uP1 = (osc1 Position 0..1, osc2 Position 0..1, detune2 semis, FM amount 0..1)
//   uP2 = (osc1 bank 0..7, osc2 bank 0..7, sub level 0..1, sub octave)
//   uP3 = (osc1 level 0..1, osc2 level 0..1, -, -)

uniform highp sampler2D uWavetable;   // R32F: width = samples, height = mips*banks*frames

// Must match WT_SAMPLES / WT_FRAMES / WT_MIPS / WT_MAXH in wavetables.ts.
const int WT_SAMPLES = 1024;
const int WT_FRAMES  = 64;
const int WT_MIPS    = 8;
const int WT_MAXH    = 128;                       // mip 0 harmonic ceiling
const int WT_ROWS_PER_MIP = 1024;                 // WT_BANK_COUNT (16) * WT_FRAMES (64)

float wtFetch(int row, int s){ return texelFetch(uWavetable, ivec2(s, row), 0).r; }

// Bilinear table read within ONE mip: between the two nearest morph frames and the
// two nearest samples. texelFetch (no hardware filtering) avoids bleeding across
// bank/mip rows; we interpolate manually instead.
float wtSampleMip(float bank, float pos, float phase, int mip){
  int b = int(bank + 0.5);
  float fx = clamp(pos, 0.0, 1.0) * float(WT_FRAMES - 1);
  int j0 = int(floor(fx)); float ft = fx - float(j0);
  if (j0 >= WT_FRAMES - 1) { j0 = WT_FRAMES - 2; ft = 1.0; }
  if (j0 < 0) { j0 = 0; ft = 0.0; }
  int base = mip * WT_ROWS_PER_MIP + b * WT_FRAMES;
  int row0 = base + j0, row1 = base + j0 + 1;
  float sp = fract(phase) * float(WT_SAMPLES);
  int s0 = int(floor(sp)); float st = sp - float(s0);
  s0 = s0 % WT_SAMPLES; if (s0 < 0) s0 += WT_SAMPLES;
  int s1 = (s0 + 1) % WT_SAMPLES;
  float a  = mix(wtFetch(row0, s0), wtFetch(row0, s1), st);
  float bb = mix(wtFetch(row1, s0), wtFetch(row1, s1), st);
  return mix(a, bb, ft);
}

// Band-limited read: choose the mip whose harmonic ceiling stays under Nyquist for
// this note, blending the two nearest mips so the timbre doesn't step across octave
// boundaries. mip m keeps topHarm = MAXH>>m; we need topHarm <= SR/(2·f), i.e.
// m >= log2(2·MAXH·f/SR). (Tiny aliasing can leak in the blend region — acceptable,
// and vastly better than full-bandwidth.)
float wtSample(float bank, float pos, float phase, float freq){
  float mipf = clamp(log2(2.0 * float(WT_MAXH) * max(freq, 1.0) / uSampleRate), 0.0, float(WT_MIPS - 1));
  int m0 = int(floor(mipf)); float mt = mipf - float(m0);
  int m1 = min(m0 + 1, WT_MIPS - 1);
  return mix(wtSampleMip(bank, pos, phase, m0), wtSampleMip(bank, pos, phase, m1), mt);
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  // PHASE-ACCUMULATING (uses the MRT phase carry). A continuing note advances its
  // oscillator phase from the carried end-of-last-block value rather than recomputing
  // f·t with the CURRENT f over all elapsed time — so a detune/pitch change between
  // blocks (LFO, slide) stays phase-continuous and click-free. Carry layout:
  //   outPhase = (osc1 phase, osc2 phase, sub phase, -), all fract'd to bound growth.
  int readCol = uSubOffset == 0 ? (uBlock - 1) : (uSubOffset - 1);
  vec4 pPhase = texelFetch(uPrevPhase, ivec2(readCol, v), 0);
  outState = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); outPhase = vec4(0.0); return; }

  float sr = uSampleRate;
  float onRel = uOnRel[v];
  float f0  = uFreq[v];
  float vel = uVel[v];

  float atk = uP0[v].x, dec = uP0[v].y, sus = uP0[v].z, rel = uP0[v].w;
  float pos1 = uP1[v].x, pos2 = uP1[v].y, det2 = uP1[v].z, fmAmt = max(uP1[v].w, 0.0);
  float bank1 = uP2[v].x, bank2 = uP2[v].y, subLvl = uP2[v].z, subOct = uP2[v].w;
  float lvl1 = uP3[v].x, lvl2 = uP3[v].y, envP1 = uP3[v].z, envP2 = uP3[v].w;

  float f2   = f0 * exp2(det2 / 12.0);
  float subF = f0 * exp2(subOct);

  // Carrier phase per oscillator. A note that starts THIS block (onRel ≥ 0) measures
  // from note-on (= absolute, resets cleanly); a continuing note accumulates from the
  // carry. Both branches agree at the block seam (fract(a)+b ≡ fract(a+b)).
  float ph1, ph2, phS;
  if (onRel >= 0.0) {
    float dt = (float(x) - onRel) / sr;
    ph1 = f0 * dt; ph2 = f2 * dt; phS = subF * dt;
  } else {
    float adv = (float(x) + 1.0) / sr;
    ph1 = pPhase.x + f0 * adv; ph2 = pPhase.y + f2 * adv; phS = pPhase.z + subF * adv;
  }
  // Carry the (bounded) carrier phases for the next block — written on EVERY column
  // so the checkpoint column is always valid, even before note-on / for silent rows.
  outPhase = vec4(fract(ph1), fract(ph2), fract(phS), 0.0);

  float t = (float(x) - onRel) / sr;                  // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / sr;          // seconds since note-off (<0 while held)
  float env = adsr(t, tRel, atk, dec, sus, rel);

  // The ADSR can also push the morph Position (env→pos amount per osc), so a patch
  // can sweep timbre over the note (e.g. bright→dark on decay). Per-sample → smooth
  // and click-free; layers ON TOP of the LFO/automation-modulated base Position.
  float pos1e = clamp(pos1 + envP1 * env, 0.0, 1.0);
  float pos2e = clamp(pos2 + envP2 * env, 0.0, 1.0);

  // osc2 first (it can phase-modulate osc1). Each osc's mip is chosen from its own
  // pitch so detuned/cross-FM voices stay band-limited. Carrier phase is stored
  // WITHOUT the FM offset; FM is applied only at the table read.
  float s2 = wtSample(bank2, pos2e, ph2, f2);
  float s1 = wtSample(bank1, pos1e, ph1 + fmAmt * s2 * 0.5, f0);

  float acc = s1 * lvl1 + s2 * lvl2;
  if (subLvl > 0.0) acc += subLvl * oscSine(phS);
  acc *= 0.5;   // headroom for the summed oscillators

  outAudio = vec4(acc * env * vel, 0.0, 0.0, 1.0);
}
