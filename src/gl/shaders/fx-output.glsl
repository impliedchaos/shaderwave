#version 300 es
// Effects OUTPUT pass — BLOCK×1 stereo. Reads the dry mix plus the (already
// updated) delay and FDN rings, sums them, then applies stereo chorus,
// Roland DS-1 diode hard-clipping distortion, auto-pan tremolo, and width.
precision highp float;
precision highp int;

uniform sampler2D uMix;     // dry, BLOCK×1
uniform sampler2D uDelay;   // updated delay ring (RG)
uniform sampler2D uFdn;     // updated FDN ring (R, 4 rows)
uniform int uW, uLen, uLenF;
uniform int uWpos, uWposF, uBlock, uDelaySamples;
uniform float uDelayMix, uReverbMix, uDist, uTone, uDistLevel, uWidth, uMaster;

// Chorus & Tremolo Uniforms
uniform int uBlockStart;
uniform float uSampleRate;
uniform float uChorusMix;
uniform float uChorusRate;
uniform float uChorusDepth; // in ms
uniform float uTremoloMix;
uniform float uTremoloRate;

// Bitcrusher uniforms
uniform int uBitcrushOn;
uniform float uBitcrushBits;   // bit depth (1–16)
uniform float uBitcrushRate;   // sample rate factor (0.01–1.0, lower = crunchier)

out vec4 outColor;

// Linearly interpolate samples from the delay ring texture
vec2 tapDelay(float delaySamples, int wpos, int i, int len, int w, sampler2D delayTex) {
  float pos = float(wpos + i) - delaySamples;
  // Wrap position around the ring buffer length
  float wrapped = mod(mod(pos, float(len)) + float(len), float(len));
  
  float idx0 = floor(wrapped);
  float idx1 = mod(idx0 + 1.0, float(len));
  float frac = fract(wrapped);
  
  vec2 val0 = texelFetch(delayTex, ivec2(int(idx0) % w, int(idx0) / w), 0).rg;
  vec2 val1 = texelFetch(delayTex, ivec2(int(idx1) % w, int(idx1) / w), 0).rg;
  
  return mix(val0, val1, frac);
}

void main(){
  int i = int(gl_FragCoord.x);
  float t = float(uBlockStart + i) / uSampleRate; // absolute time in seconds
  
  vec2 dry = texelFetch(uMix, ivec2(i, 0), 0).rg;

  // --- Delay Output Tap ---
  int pd = (((uWpos + i - uDelaySamples) % uLen) + uLen) % uLen;
  vec2 del = texelFetch(uDelay, ivec2(pd % uW, pd / uW), 0).rg;

  // --- Reverb Output Tap ---
  int pf = (((uWposF + i) % uLenF) + uLenF) % uLenF;
  float s0 = texelFetch(uFdn, ivec2(pf, 0), 0).r;
  float s1 = texelFetch(uFdn, ivec2(pf, 1), 0).r;
  float s2 = texelFetch(uFdn, ivec2(pf, 2), 0).r;
  float s3 = texelFetch(uFdn, ivec2(pf, 3), 0).r;
  vec2 rev = vec2(s0 - s1 + s2 - s3, s0 + s1 - s2 + s3) * 0.5;

  // Initial sum of dry + delay + reverb
  vec2 wet = dry + uDelayMix * del + uReverbMix * rev;

  // --- Stereo Chorus Effect ---
  // Modulate delay times between 8ms and 15ms (L and R are 90 degrees out of phase)
  float baseDelaySamples = 0.012 * uSampleRate; // 12ms base delay
  float modDepthSamples = (uChorusDepth / 1000.0) * uSampleRate; // depth in samples
  
  float delayL = baseDelaySamples + modDepthSamples * sin(2.0 * 3.14159265 * uChorusRate * t);
  float delayR = baseDelaySamples + modDepthSamples * sin(2.0 * 3.14159265 * uChorusRate * t + 1.57079632);
  
  vec2 cho = vec2(
    tapDelay(delayL, uWpos, i, uLen, uW, uDelay).r, // Left tap
    tapDelay(delayR, uWpos, i, uLen, uW, uDelay).g  // Right tap
  );
  
  // Blend chorus with the signal
  wet = mix(wet, cho, uChorusMix);

  // --- Roland/BOSS DS-1 Diode Hard-Clipping Emulation ---
  float distVal = max(uDist, 0.001);
  vec2 inputSignal = wet * distVal;
  vec2 driven_curr = inputSignal / pow(vec2(1.0) + pow(abs(inputSignal), vec2(3.0)), vec2(1.0 / 3.0));
  float norm = pow(1.0 + pow(distVal, 3.0), 1.0 / 3.0) / distVal;
  driven_curr *= norm * uDistLevel;

  // For FIR Tone Filter, compute the driven value of the previous sample (i - 1)
  vec2 wet_prev = wet;
  if (i > 0) {
    int prev_i = i - 1;
    vec2 dry_prev = texelFetch(uMix, ivec2(prev_i, 0), 0).rg;
    int pd_prev = (((uWpos + prev_i - uDelaySamples) % uLen) + uLen) % uLen;
    vec2 del_prev = texelFetch(uDelay, ivec2(pd_prev % uW, pd_prev / uW), 0).rg;
    int pf_prev = (((uWposF + prev_i) % uLenF) + uLenF) % uLenF;
    float s0_prev = texelFetch(uFdn, ivec2(pf_prev, 0), 0).r;
    float s1_prev = texelFetch(uFdn, ivec2(pf_prev, 1), 0).r;
    float s2_prev = texelFetch(uFdn, ivec2(pf_prev, 2), 0).r;
    float s3_prev = texelFetch(uFdn, ivec2(pf_prev, 3), 0).r;
    vec2 rev_prev = vec2(s0_prev - s1_prev + s2_prev - s3_prev, s0_prev + s1_prev - s2_prev + s3_prev) * 0.5;
    wet_prev = dry_prev + uDelayMix * del_prev + uReverbMix * rev_prev;
  }
  vec2 inputSignalPrev = wet_prev * distVal;
  vec2 driven_prev = inputSignalPrev / pow(vec2(1.0) + pow(abs(inputSignalPrev), vec2(3.0)), vec2(1.0 / 3.0));
  driven_prev *= norm * uDistLevel;

  // FIR Tone Tilt Filter
  vec2 LP = (driven_curr + driven_prev) * 0.5;
  vec2 HP = driven_curr - (driven_curr + driven_prev) * 0.5;
  vec2 driven = driven_curr;
  if (uTone < 0.5) {
    driven = mix(LP, driven_curr, uTone * 2.0);
  } else {
    driven = mix(driven_curr, HP * 2.5, (uTone - 0.5) * 2.0);
  }

  // --- Stereo Tremolo / Auto-Pan ---
  // Amplitude modulation: Left and Right are 180 degrees out of phase for auto-pan
  float lfoL = 0.5 + 0.5 * sin(2.0 * 3.14159265 * uTremoloRate * t);
  float lfoR = 0.5 + 0.5 * sin(2.0 * 3.14159265 * uTremoloRate * t + 3.14159265);
  
  vec2 tremScale = vec2(
    1.0 - uTremoloMix * lfoL,
    1.0 - uTremoloMix * lfoR
  );
  driven *= tremScale;

  // --- Bitcrusher ---
  if (uBitcrushOn != 0) {
    // Bit depth reduction: quantize to 2^bits levels
    float levels = pow(2.0, uBitcrushBits);
    driven = floor(driven * levels + 0.5) / levels;

    // Compute the effective decimation period in samples using target sample rate (Hz)
    float holdPeriod = max(1.0, floor(uSampleRate / max(uBitcrushRate, 1.0)));
    float sampleIdx = float(uBlockStart + i);
    float holdIdx = floor(sampleIdx / holdPeriod) * holdPeriod;
    // Re-read the held sample from the dry input and re-process
    int heldI = int(holdIdx) - uBlockStart;
    if (heldI >= 0 && heldI < uBlock && heldI != i) {
      vec2 heldDry = texelFetch(uMix, ivec2(heldI, 0), 0).rg;
      // Apply same delay+reverb sum as main path
      int hpd = (((uWpos + heldI - uDelaySamples) % uLen) + uLen) % uLen;
      vec2 heldDel = texelFetch(uDelay, ivec2(hpd % uW, hpd / uW), 0).rg;
      int hpf = (((uWposF + heldI) % uLenF) + uLenF) % uLenF;
      float hs0 = texelFetch(uFdn, ivec2(hpf, 0), 0).r;
      float hs1 = texelFetch(uFdn, ivec2(hpf, 1), 0).r;
      float hs2 = texelFetch(uFdn, ivec2(hpf, 2), 0).r;
      float hs3 = texelFetch(uFdn, ivec2(hpf, 3), 0).r;
      vec2 heldRev = vec2(hs0 - hs1 + hs2 - hs3, hs0 + hs1 - hs2 + hs3) * 0.5;
      vec2 heldWet = heldDry + uDelayMix * heldDel + uReverbMix * heldRev;
      // Re-apply distortion to the held sample
      vec2 heldInput = heldWet * distVal;
      vec2 heldDriven = heldInput / pow(vec2(1.0) + pow(abs(heldInput), vec2(3.0)), vec2(1.0 / 3.0));
      heldDriven *= norm * uDistLevel;
      // Quantize
      driven = floor(heldDriven * levels + 0.5) / levels;
    }
  }

  // --- Mid/Side Width & Output Master Gain ---
  float mid = (driven.x + driven.y) * 0.5;
  float side = (driven.x - driven.y) * 0.5 * uWidth;
  outColor = vec4(vec2(mid + side, mid - side) * uMaster, 0.0, 1.0);
}
