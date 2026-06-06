// Locked Groove ("GRV") — a vinyl-noise texture instrument: surface hiss, random
// crackle, dust pops, motor rumble, AND a rotation-locked defect layer that
// recurs once per platter revolution (33⅓ RPM → every 1.8 s). Closed-form, no
// recursion, no carried state — like the 808/E8E, each fragment evaluates one
// output sample as a pure function of the absolute frame, so the periodic ticks
// reconstruct identically in parallel across the whole block.
//
// Play it as a drone: one long note lays down the bed; velocity sets the level;
// pitch is ignored (it's noise). A gentle Fade in/out keeps note-on/off clickless.
//
// The rotation trick: P = (60/RPM)·SR samples per revolution. rev = floor(frame/P),
// angular phase phi = fract(frame/P). A small fixed set of defect slots each sit at
// a hashed angle theta and fire a pop when phi sweeps past — a pure function of
// (hash(i), phi-theta). Drift migrates theta slightly each revolution (a radial
// scratch crossing many grooves as the needle spirals in), and a per-rev hash makes
// defects breathe in and out so the ticks aren't robotic. Cycle blends the pop
// energy between fully-random and fully-rotation-locked.
//
// Params (per voice):
//   uP0 = (hiss, crackle, pop, wear)            — wear scales defect density+level
//   uP1 = (cycle 0..1, tone 0..1, rumble, drift)
//   uP2 = (rpm, defectCount 0..8, clickColor, fade s)
//   uP3 = (hissMod 0..1, modRate cyc/rev, -, -)   — cyclic hiss-cutoff wobble synced to rotation

// Smoothed value noise: noise held & interpolated over `p` units → a cheap, dark,
// low-passed source (cutoff ≈ SR/(2·hold)). Used for the hiss floor and rumble,
// which real vinyl shows as steeply low-tilted (energy piles up below ~200 Hz).
float grvValueNoise(float p){
  float i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(noise1(i), noise1(i + 1.0), f);
}

// A vinyl click/pop: an impulse edge (cos starts at the peak — the "snap") with a
// short damped ring at the groove/cartridge resonance. ds = samples since onset.
// A click = a hard JAGGED edge + a short body. The edge is a ~2-sample NOISE
// impulse — noise has hard sample-to-sample discontinuities, so it reads as a sharp
// dry click. A smooth cosine spike instead sounds "round" and turns into a finger-
// snap or water-bubble. snapAmt sets how much hard edge (crackle high → jagged tick;
// pops low → thuddy). The body is noiseMix between broadband noise and a damped ring.
float grvClick(float ds, float decaySamp, float ringHz, float sr, float nz,
               float noiseMix, float snapAmt){
  if (ds < 0.0) return 0.0;
  float edge = nz * exp(-ds / 1.5);
  float body = exp(-ds / max(decaySamp, 1.0)) * (noiseMix * nz + (1.0 - noiseMix) * cos(TAU * ringHz * ds / sr));
  return snapAmt * edge + body;
}

// Grain-based aperiodic clicks: chop time into gLen-sample grains; each grain has
// prob of firing a click at a hashed sub-position. Look back a few grains so a
// click can ring past its own grain. Pure function of frame → parallel-safe.
float grvGrains(float frame, float gLen, float prob, float decaySamp, float ringHz,
                float sr, float dark, float tailPow, float noiseMix, float snapAmt){
  float acc = 0.0;
  // Excitation noise: brighter white ↔ duller value-noise (dark→1).
  float nz = mix(noise1(frame * 1.31 + 5.0), grvValueNoise(frame / 7.0), dark);
  float gi = floor(frame / gLen);
  for (int k = 0; k <= 3; k++){
    float id = gi - float(k);
    if (hash11(id * 1.73 + 3.1) < prob){
      float pos = hash11(id * 2.31 + 7.7);
      float ds  = frame - (id + pos) * gLen;
      // Heavy-tailed amplitude: MOST clicks faint, a FEW loud — real crackle has a
      // wide dynamic spread. Uniform amplitudes sound like a continuous brook.
      float amp = pow(hash11(id * 0.91 + 1.3), tailPow);
      float rf  = ringHz * (0.7 + 0.6 * hash11(id * 5.13 + 2.2));
      acc += amp * grvClick(ds, decaySamp, rf, sr, nz, noiseMix, snapAmt);
    }
  }
  return acc;
}

// Rotation-locked defects: up to 8 slots at hashed angles, recurring every P
// samples, migrating by `drift` per revolution and breathing across revolutions.
float grvLocked(float frame, float P, int nDef, float drift, float wear,
                float decaySamp, float ringHz, float sr, float dark, float noiseMix, float snapAmt){
  float acc = 0.0;
  float rev = floor(frame / P);
  float phi = fract(frame / P);
  for (int i = 0; i < 8; i++){
    if (i >= nDef) break;
    float fi = float(i);
    float theta = fract(hash11(fi * 1.37 + 0.5) + drift * rev * (0.3 + 0.7 * hash11(fi * 3.1)));
    // breathe: a per-rev-group hash gated by wear → how present/strong this defect is.
    // Keep a floor so the recurring tick stays audible (it's the signature feature),
    // with wear-driven breathing on top.
    float amp = hash11(fi * 2.7 + floor(rev * 0.13));
    amp = mix(0.45, 1.0, smoothstep(1.0 - wear, 1.0, amp));
    float dphi = phi - theta;
    dphi -= floor(dphi + 0.5);              // wrap to [-0.5, 0.5)
    float ds = dphi * P;                    // samples from the tick (negative = before)
    float rf = ringHz * (0.4 + 0.5 * hash11(fi * 4.4 + 1.1));
    float nz = mix(noise1(frame * 1.91 + fi * 13.0), grvValueNoise(frame / 7.0 + fi * 3.0), dark);
    acc += amp * grvClick(ds, decaySamp, rf, sr, nz, noiseMix, snapAmt);
  }
  return acc;
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  // Closed-form: nothing carried. Always write the MRT buffers.
  outState = vec4(0.0);
  outPhase = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;     // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate; // seconds since note-off (<0 while held)

  float vel = uVel[v];
  float sr  = uSampleRate;
  float frame = uBlockStart + float(x);               // absolute frame → continuous texture

  float hissLvl = uP0[v].x;
  float crackle = uP0[v].y;
  float popLvl  = uP0[v].z;
  float wear    = clamp(uP0[v].w, 0.0, 1.0);
  float cycle   = clamp(uP1[v].x, 0.0, 1.0);
  float tone    = clamp(uP1[v].y, 0.0, 1.0);
  float rumbLvl = uP1[v].z;
  float drift   = uP1[v].w * 0.004;                   // small per-rev migration
  float rpm     = max(uP2[v].x, 1.0);
  int   nDef    = int(clamp(uP2[v].y, 0.0, 8.0) + 0.5);
  float color   = clamp(uP2[v].z, 0.0, 1.0);
  float fade    = max(uP2[v].w, 0.003);
  float hissMod = clamp(uP3[v].x, 0.0, 1.0);          // cyclic hiss-cutoff wobble depth
  float modRate = max(uP3[v].y, 0.0);                 // wobble cycles per revolution

  float P = (60.0 / rpm) * sr;                        // samples per revolution
  float rotPhase = fract(frame / P);                  // 0..1 within a revolution

  // --- hiss: a DARK low-passed floor (real vinyl hiss rolls off steeply), with a
  // touch of bright "air" on top. Tone sets the cutoff dark↔bright. The BRIGHTNESS
  // breathes with the rotation (hissMod): we modulate the air amount, NOT the noise
  // playback rate — rate-modulation pitch-warbles the hiss, which is far too audible.
  // This is a subtle timbral shift with no pitch artifact. ---
  float hold = mix(70.0, 6.0, tone);                  // hold length → LP cutoff (fixed)
  float lowHiss = 0.7 * grvValueNoise(frame / hold)
                + 0.3 * grvValueNoise(frame / (hold * 0.5));   // 2-octave fBm
  float airWob = 1.0 + hissMod * 0.5 * sin(TAU * modRate * rotPhase);
  float air = noise1(frame) * mix(0.04, 0.35, tone) * airWob;
  float hissSig = (lowHiss + air) * hissLvl * 0.24;

  // --- click voicings, tuned to measured LP click waveforms ---
  // Crackle: broadband, ~2.4kHz centroid, ~4ms decay → mostly noise (noiseMix .8),
  // mid-dull (dark .4). Pops: LOW ~350Hz damped thud, ~670Hz centroid, ~4ms → mostly
  // tonal (noiseMix .35), low ring.
  float tickDecay = mix(8.0, 22.0, color);      // ~0.2–0.5 ms — hard, dry tick
  float tickRing  = mix(3000.0, 2000.0, color);
  float popDecay  = mix(150.0, 280.0, color);   // ~3–6 ms
  float popRing   = mix(420.0, 300.0, color);   // low → thud, not bloop

  // --- aperiodic crackle: crisp SNAPS (sharp-edged ticks) + a faint fine sizzle ---
  // Each click is snap-dominated (impulsive edge), short, and lightly noisy — dry
  // ticks, not fizzy/bubbly blobs. The sizzle is a quiet sparse fine layer for
  // texture between the snaps (kept low — too much reads as frying static).
  float sizzle = grvGrains(frame, 200.0, 0.6, mix(12.0, 24.0, color),
                           mix(6000.0, 4000.0, color), sr, 0.2, 1.3, 0.55, 0.6);
  float snaps  = grvGrains(frame, 1000.0, crackle, tickDecay, tickRing, sr, 0.2, 3.5, 0.8, 0.7);
  float crackleSig = snaps * 1.4 + sizzle * crackle * 0.2;
  float randPops   = grvGrains(frame, 16000.0, wear * 0.4, popDecay, popRing, sr, 0.5, 1.5, 0.35, 0.2);
  float lockPops   = grvLocked(frame, P, nDef, drift, wear, popDecay, popRing, sr, 0.5, 0.35, 0.2);
  float popSig     = mix(randPops, lockPops, cycle) * popLvl * 1.2;

  // --- motor rumble: a low wandering tone ---
  float tt = frame / sr;
  // Deep low-end warmth: a wandering motor tone + dark sub-noise (real LPs pile up
  // energy below ~150 Hz). Pure sines alone read as hum, so blend in low value-noise.
  float rumbSig = (sin(TAU * 30.0 * tt) + 0.6 * sin(TAU * 47.0 * tt + 1.3)
                   + 0.6 * grvValueNoise(frame / 320.0)) * rumbLvl * 0.12;

  // --- clickless fade in/out ---
  float atk = clamp(t / fade, 0.0, 1.0);
  float relGate = tRel < 0.0 ? 1.0 : clamp(1.0 - tRel / fade, 0.0, 1.0);
  float env = atk * relGate * vel;

  float s = (hissSig + crackleSig + popSig + rumbSig) * env;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
