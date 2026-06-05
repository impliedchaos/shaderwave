// DX7-flavoured FM voice. FM is feed-forward (no recursion), so this is computed
// directly per sample. A faithful DX7 is 6 operators over 32 algorithms. We
// implement all 32 algorithms and 6 operators analytically, with detune and
// output scaling based on the active carrier count.
//
// Params (per voice):
//   uP0 = (carrierRatio, modRatio, modIndex, feedback 0..1)
//   uP1 = (algorithm[1..32], modDecay s, ampDecay s, ratioC)

// Per-voice operator config, packed into two vec4 arrays (indexed [v*6 + op]) to
// keep the fragment-uniform-vector count low. Filled by the engine per active voice.
//   uOpA = (coarse, fine, level, detune)   uOpB = (mode, sustain, release, decay)
uniform vec4 uOpA[VOICES * 6];
uniform vec4 uOpB[VOICES * 6];
uniform vec4 uOpC[VOICES * 6];
uniform vec4 uOpD[VOICES * 6];

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }
  int b = v * 6;   // base index into the per-voice operator arrays

  float t = (float(x) - uOnRel[v]) / uSampleRate;
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate;

  float freq = uFreq[v], vel = uVel[v];
  vec4 p0 = uP0[v], p1 = uP1[v];
  float cR = p0.x, mR = p0.y, idx = p0.z, fb = p0.w;
  int algo = int(p1.x + 0.5);
  float mDecay = p1.y, aDecay = p1.z, cR2 = p1.w;

  float env1 = env4(t, tRel, uOpC[b+0], uOpD[b+0]);
  float env2 = env4(t, tRel, uOpC[b+1], uOpD[b+1]);
  float env3 = env4(t, tRel, uOpC[b+2], uOpD[b+2]);
  float env4_ = env4(t, tRel, uOpC[b+3], uOpD[b+3]);
  float env5 = env4(t, tRel, uOpC[b+4], uOpD[b+4]);
  float env6 = env4(t, tRel, uOpC[b+5], uOpD[b+5]);

  // DX7 Level to Gain formula: gain = 2^((Level + 99*env - 198) / 8)
  float lvl1 = uOpA[b+0].z <= 0.0 ? 0.0 : exp2((uOpA[b+0].z + 99.0 * env1 - 198.0) / 8.0);
  float lvl2 = uOpA[b+1].z <= 0.0 ? 0.0 : exp2((uOpA[b+1].z + 99.0 * env2 - 198.0) / 8.0);
  float lvl3 = uOpA[b+2].z <= 0.0 ? 0.0 : exp2((uOpA[b+2].z + 99.0 * env3 - 198.0) / 8.0);
  float lvl4 = uOpA[b+3].z <= 0.0 ? 0.0 : exp2((uOpA[b+3].z + 99.0 * env4_ - 198.0) / 8.0);
  float lvl5 = uOpA[b+4].z <= 0.0 ? 0.0 : exp2((uOpA[b+4].z + 99.0 * env5 - 198.0) / 8.0);
  float lvl6 = uOpA[b+5].z <= 0.0 ? 0.0 : exp2((uOpA[b+5].z + 99.0 * env6 - 198.0) / 8.0);

  // op freq: B.x=mode (>0.5 = fixed Hz), A.x=coarse, A.y=fine, A.w=detune
  float f1 = uOpB[b+0].x > 0.5 ?
             pow(10.0, uOpA[b+0].x + uOpA[b+0].y * 0.01) * (1.0 + uOpA[b+0].w * 0.0002) :
             freq * (uOpA[b+0].x * (1.0 + uOpA[b+0].y * 0.01) + uOpA[b+0].w * 0.0002);
  float f2 = uOpB[b+1].x > 0.5 ?
             pow(10.0, uOpA[b+1].x + uOpA[b+1].y * 0.01) * (1.0 + uOpA[b+1].w * 0.0002) :
             freq * (uOpA[b+1].x * (1.0 + uOpA[b+1].y * 0.01) + uOpA[b+1].w * 0.0002);
  float f3 = uOpB[b+2].x > 0.5 ?
             pow(10.0, uOpA[b+2].x + uOpA[b+2].y * 0.01) * (1.0 + uOpA[b+2].w * 0.0002) :
             freq * (uOpA[b+2].x * (1.0 + uOpA[b+2].y * 0.01) + uOpA[b+2].w * 0.0002);
  float f4 = uOpB[b+3].x > 0.5 ?
             pow(10.0, uOpA[b+3].x + uOpA[b+3].y * 0.01) * (1.0 + uOpA[b+3].w * 0.0002) :
             freq * (uOpA[b+3].x * (1.0 + uOpA[b+3].y * 0.01) + uOpA[b+3].w * 0.0002);
  float f5 = uOpB[b+4].x > 0.5 ?
             pow(10.0, uOpA[b+4].x + uOpA[b+4].y * 0.01) * (1.0 + uOpA[b+4].w * 0.0002) :
             freq * (uOpA[b+4].x * (1.0 + uOpA[b+4].y * 0.01) + uOpA[b+4].w * 0.0002);
  float f6 = uOpB[b+5].x > 0.5 ?
             pow(10.0, uOpA[b+5].x + uOpA[b+5].y * 0.01) * (1.0 + uOpA[b+5].w * 0.0002) :
             freq * (uOpA[b+5].x * (1.0 + uOpA[b+5].y * 0.01) + uOpA[b+5].w * 0.0002);

  // Operator base phases
  float ph1 = fract(f1 * t);
  float ph2 = fract(f2 * t);
  float ph3 = fract(f3 * t);
  float ph4 = fract(f4 * t);
  float ph5 = fract(f5 * t);
  float ph6 = fract(f6 * t);

  // Self-feedback modulation (for algorithms containing feedback operators)
  float fbVal = fb * 0.38;
  float fb6 = fbVal * oscSine(ph6) * lvl6;
  float fb5 = fbVal * oscSine(ph5) * lvl5;
  float fb4 = fbVal * oscSine(ph4) * lvl4;
  float fb3 = fbVal * oscSine(ph3) * lvl3;
  float fb2 = fbVal * oscSine(ph2) * lvl2;

  float s = 0.0;
  float carriers = 1.0;

  if (algo <= 1) {
    carriers = 2.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o5) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 2) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o5) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2 + fb2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 3) {
    carriers = 2.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o5) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o4;
  } else if (algo == 4) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o5 + fb4) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o4;
  } else if (algo == 5) {
    carriers = 3.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3 + o5;
  } else if (algo == 6) {
    carriers = 3.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6 + fb5) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3 + o5;
  } else if (algo == 7) {
    carriers = 2.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4 + o5) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 8) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + fb4) * lvl4;
    float o3 = oscSine(ph3 + o4 + o5) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 9) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4 + o5) * lvl3;
    float o2 = oscSine(ph2 + fb2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 10) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3 + fb3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o4;
  } else if (algo == 11) {
    carriers = 2.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o4;
  } else if (algo == 12) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4 + o5 + o6) * lvl3;
    float o2 = oscSine(ph2 + fb2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 13) {
    carriers = 2.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4 + o5 + o6) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 14) {
    carriers = 2.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 15) {
    carriers = 2.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2 + fb2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3;
  } else if (algo == 16) {
    carriers = 1.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2 + o3 + o5) * lvl1;
    s = o1;
  } else if (algo == 17) {
    carriers = 1.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2 + fb2) * lvl2;
    float o1 = oscSine(ph1 + o2 + o3 + o5) * lvl1;
    s = o1;
  } else if (algo == 18) {
    carriers = 1.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o5) * lvl4;
    float o3 = oscSine(ph3 + fb3) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2 + o3 + o4) * lvl1;
    s = o1;
  } else if (algo == 19) {
    carriers = 3.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o6) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o4 + o5;
  } else if (algo == 20) {
    carriers = 3.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3 + fb3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o3) * lvl1;
    s = o1 + o2 + o4;
  } else if (algo == 21) {
    carriers = 4.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o6) * lvl4;
    float o3 = oscSine(ph3 + fb3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1 + o3) * lvl1;
    s = o1 + o2 + o4 + o5;
  } else if (algo == 22) {
    carriers = 4.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o6) * lvl4;
    float o3 = oscSine(ph3 + o6) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3 + o4 + o5;
  } else if (algo == 23) {
    carriers = 4.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o6) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o4 + o5;
  } else if (algo == 24) {
    carriers = 5.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o6) * lvl4;
    float o3 = oscSine(ph3 + o6) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o3 + o4 + o5;
  } else if (algo == 25) {
    carriers = 5.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4 + o6) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o3 + o4 + o5;
  } else if (algo == 26) {
    carriers = 3.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o4;
  } else if (algo == 27) {
    carriers = 3.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4 + o5 + o6) * lvl4;
    float o3 = oscSine(ph3 + fb3) * lvl3;
    float o2 = oscSine(ph2 + o3) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o4;
  } else if (algo == 28) {
    carriers = 3.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + fb5) * lvl5;
    float o4 = oscSine(ph4 + o5) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1 + o2) * lvl1;
    s = o1 + o3 + o6;
  } else if (algo == 29) {
    carriers = 4.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o3 + o5;
  } else if (algo == 30) {
    carriers = 4.0;
    float o6 = oscSine(ph6) * lvl6;
    float o5 = oscSine(ph5 + fb5) * lvl5;
    float o4 = oscSine(ph4 + o5) * lvl4;
    float o3 = oscSine(ph3 + o4) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o3 + o6;
  } else if (algo == 31) {
    carriers = 5.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5 + o6) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o3 + o4 + o5;
  } else { // algo == 32
    carriers = 6.0;
    float o6 = oscSine(ph6 + fb6) * lvl6;
    float o5 = oscSine(ph5) * lvl5;
    float o4 = oscSine(ph4) * lvl4;
    float o3 = oscSine(ph3) * lvl3;
    float o2 = oscSine(ph2) * lvl2;
    float o1 = oscSine(ph1) * lvl1;
    s = o1 + o2 + o3 + o4 + o5 + o6;
  }

  // Normalize by carrier count to prevent volume spikes / clipping
  s /= carriers;

  outAudio = vec4(s * vel * 0.88, 0.0, 0.0, 1.0);
}
