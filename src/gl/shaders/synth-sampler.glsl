// (common.glsl is prepended by the build; uniforms/helpers from there are in scope)
uniform highp sampler2D uSamplePcm;     // R32F tiled atlas, width = SMP_ATLAS_W
uniform float uSmpSlot[VOICES];         // -1 = no sample loaded
uniform float uSmpBaseRow[VOICES];      // first atlas ROW of this slot
uniform float uSmpLen[VOICES];          // sample length in frames
uniform float uSmpRootFreq[VOICES];     // freq at unity playback rate
uniform float uSmpLoopStart[VOICES], uSmpLoopEnd[VOICES], uSmpLoopMode[VOICES];

const int SMP_W = 4096;                 // MUST match SMP_ATLAS_W in synth-renderer.ts

float pcmAt(float baseRow, int i){      // linear frame i within the slot → texel
  int g = int(baseRow) * SMP_W + i;
  return texelFetch(uSamplePcm, ivec2(g % SMP_W, g / SMP_W), 0).r;
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0); outPhase = vec4(0.0); outPhase2 = vec4(0.0);   // closed-form: always zero
  if (!voiceLive(v) || uSmpSlot[v] < 0.0) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate;   // <0 while held

  // params: pick a layout and KEEP IT STABLE (ids persist). Suggested:
  float tune   = uP0[v].x;     // semitones
  float start  = uP0[v].y;     // 0..1 start offset (× len)
  float gain   = uP0[v].z;     // linear out gain
  float atk    = uP1[v].x, dec = uP1[v].y, sus = uP1[v].z, rel = uP1[v].w;

  float rate = (uFreq[v] / max(uSmpRootFreq[v], 1.0)) * pow(2.0, tune / 12.0);
  float pos  = start * uSmpLen[v] + t * uSampleRate * rate;   // read position in frames

  float ls = uSmpLoopStart[v], le = uSmpLoopEnd[v];
  if (uSmpLoopMode[v] > 0.5 && le > ls + 1.0) {
    if (pos >= le) pos = ls + mod(pos - ls, le - ls);          // forward loop
  } else if (pos >= uSmpLen[v] - 1.0) {                        // one-shot: done
    outAudio = vec4(0.0); return;
  }

  // linear interpolation between frame i and i+1 (NEAREST texture → interp by hand)
  int i = int(floor(pos)); float fr = pos - float(i);
  float a = pcmAt(uSmpBaseRow[v], i);
  float b = pcmAt(uSmpBaseRow[v], i + 1);
  float s = mix(a, b, fr);

  float amp = adsr(t, tRel, atk, dec, sus, rel);   // common.glsl ADSR
  outAudio = vec4(s * amp * gain * uVel[v], 0.0, 0.0, 1.0);
}
