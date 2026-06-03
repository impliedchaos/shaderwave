// DX7-flavoured FM voice. FM is feed-forward (no recursion), so this is computed
// directly per sample. A faithful DX7 is 6 operators over 32 algorithms. We
// implement all 32 algorithms and 6 operators analytically, with detune and
// output scaling based on the active carrier count.
//
// Params (per voice):
//   uP0 = (carrierRatio, modRatio, modIndex, feedback 0..1)
//   uP1 = (algorithm[1..32], modDecay s, ampDecay s, ratioC)

uniform float uOpCoarse[6];
uniform float uOpFine[6];
uniform float uOpLevel[6];
uniform float uOpDetune[6];
uniform float uOpDecay[6];
uniform float uOpMode[6];
uniform float uOpSustain[6];
uniform float uOpRelease[6];

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate;

  float freq = uFreq[v], vel = uVel[v];
  vec4 p0 = uP0[v], p1 = uP1[v];
  float cR = p0.x, mR = p0.y, idx = p0.z, fb = p0.w;
  int algo = int(p1.x + 0.5);
  float mDecay = p1.y, aDecay = p1.z, cR2 = p1.w;

  float env1 = adsr(t, tRel, 0.002, uOpDecay[0], uOpSustain[0], uOpRelease[0]);
  float env2 = adsr(t, tRel, 0.002, uOpDecay[1], uOpSustain[1], uOpRelease[1]);
  float env3 = adsr(t, tRel, 0.002, uOpDecay[2], uOpSustain[2], uOpRelease[2]);
  float env4 = adsr(t, tRel, 0.002, uOpDecay[3], uOpSustain[3], uOpRelease[3]);
  float env5 = adsr(t, tRel, 0.002, uOpDecay[4], uOpSustain[4], uOpRelease[4]);
  float env6 = adsr(t, tRel, 0.002, uOpDecay[5], uOpSustain[5], uOpRelease[5]);

  // DX7 Level to Gain formula: gain = 2^((Level + 99*env - 198) / 8)
  float lvl1 = uOpLevel[0] <= 0.0 ? 0.0 : exp2((uOpLevel[0] + 99.0 * env1 - 198.0) / 8.0);
  float lvl2 = uOpLevel[1] <= 0.0 ? 0.0 : exp2((uOpLevel[1] + 99.0 * env2 - 198.0) / 8.0);
  float lvl3 = uOpLevel[2] <= 0.0 ? 0.0 : exp2((uOpLevel[2] + 99.0 * env3 - 198.0) / 8.0);
  float lvl4 = uOpLevel[3] <= 0.0 ? 0.0 : exp2((uOpLevel[3] + 99.0 * env4 - 198.0) / 8.0);
  float lvl5 = uOpLevel[4] <= 0.0 ? 0.0 : exp2((uOpLevel[4] + 99.0 * env5 - 198.0) / 8.0);
  float lvl6 = uOpLevel[5] <= 0.0 ? 0.0 : exp2((uOpLevel[5] + 99.0 * env6 - 198.0) / 8.0);

  float f1 = uOpMode[0] > 0.5 ?
             pow(10.0, uOpCoarse[0] + uOpFine[0] * 0.01) * (1.0 + uOpDetune[0] * 0.0002) :
             freq * (uOpCoarse[0] * (1.0 + uOpFine[0] * 0.01) + uOpDetune[0] * 0.0002);
  float f2 = uOpMode[1] > 0.5 ?
             pow(10.0, uOpCoarse[1] + uOpFine[1] * 0.01) * (1.0 + uOpDetune[1] * 0.0002) :
             freq * (uOpCoarse[1] * (1.0 + uOpFine[1] * 0.01) + uOpDetune[1] * 0.0002);
  float f3 = uOpMode[2] > 0.5 ?
             pow(10.0, uOpCoarse[2] + uOpFine[2] * 0.01) * (1.0 + uOpDetune[2] * 0.0002) :
             freq * (uOpCoarse[2] * (1.0 + uOpFine[2] * 0.01) + uOpDetune[2] * 0.0002);
  float f4 = uOpMode[3] > 0.5 ?
             pow(10.0, uOpCoarse[3] + uOpFine[3] * 0.01) * (1.0 + uOpDetune[3] * 0.0002) :
             freq * (uOpCoarse[3] * (1.0 + uOpFine[3] * 0.01) + uOpDetune[3] * 0.0002);
  float f5 = uOpMode[4] > 0.5 ?
             pow(10.0, uOpCoarse[4] + uOpFine[4] * 0.01) * (1.0 + uOpDetune[4] * 0.0002) :
             freq * (uOpCoarse[4] * (1.0 + uOpFine[4] * 0.01) + uOpDetune[4] * 0.0002);
  float f6 = uOpMode[5] > 0.5 ?
             pow(10.0, uOpCoarse[5] + uOpFine[5] * 0.01) * (1.0 + uOpDetune[5] * 0.0002) :
             freq * (uOpCoarse[5] * (1.0 + uOpFine[5] * 0.01) + uOpDetune[5] * 0.0002);

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
