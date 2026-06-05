// @ts-nocheck
import { createProgram, drawQuad } from '../gl/program.js';

const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uBPM;
uniform float uPlaying;
uniform vec3 uAccentColor;

uniform sampler2D uFreqTex;
uniform sampler2D uWaveTex;

float getFreq(float x) {
  return texture(uFreqTex, vec2(x, 0.5)).r;
}

float getWave(float x) {
  return texture(uWaveTex, vec2(x, 0.5)).r - 0.5;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution.xy) / uResolution.y;
  
  float bass = 0.0;
  for(int i = 0; i < 8; i++) {
    bass += getFreq(float(i) / 100.0);
  }
  bass /= 8.0;

  float mid = 0.0;
  for(int i = 8; i < 32; i++) {
    mid += getFreq(float(i) / 100.0);
  }
  mid /= 24.0;

  // Background neon ambient glow
  float dist = length(uv);
  vec3 bgColor = vec3(0.005, 0.008, 0.015) * (1.5 - dist);
  bgColor += uAccentColor * bass * 0.12 * (1.0 - dist);

  vec3 finalColor = vec3(0.0);
  
  // Chromatic aberration channel offsets
  vec2 offsetR = vec2(0.015, 0.0) * (0.3 + bass * 1.2) * uPlaying;
  vec2 offsetG = vec2(0.0, 0.015) * (0.3 + bass * 1.2) * uPlaying;
  vec2 offsetB = vec2(-0.015, -0.015) * (0.3 + bass * 1.2) * uPlaying;

  // Render 3 Concentric reactive rings
  for (int c = 0; c < 3; c++) {
    vec2 uvC = uv;
    if (c == 0) uvC += offsetR;
    if (c == 1) uvC += offsetG;
    if (c == 2) uvC += offsetB;
    
    float r = length(uvC);
    float theta = atan(uvC.y, uvC.x);
    float normTheta = (theta + 3.14159265) / (2.0 * 3.14159265);

    // Inner Ring: Bass Pulsing Core
    float rCore = 0.12 + bass * 0.18 * uPlaying;
    float glowCore = 0.0018 / abs(r - rCore);

    // Mid Ring: Frequency Spectrum Ring (Symmetric)
    float freqVal = getFreq(abs(normTheta - 0.5) * 2.0) * uPlaying;
    float rFreq = 0.26 + freqVal * 0.5;
    float glowFreq = 0.0025 / abs(r - rFreq);

    // Outer Ring: Oscilloscope Waveform Ring
    float waveVal = getWave(normTheta) * uPlaying;
    float rWave = 0.52 + waveVal * 0.3 * (0.1 + mid * 0.9);
    float glowWave = 0.0035 / abs(r - rWave);

    float intensity = glowCore * 0.5 + glowFreq * 0.9 + glowWave * 0.7;

    // Apply color accents
    vec3 channelColor = uAccentColor;
    if (c == 0) channelColor.r = min(1.0, channelColor.r + 0.35);
    if (c == 2) channelColor.b = min(1.0, channelColor.b + 0.35);
    
    finalColor[c] = intensity * channelColor[c];
  }

  // Perspective space grid at the bottom
  if (uv.y < -0.22) {
    float z = 1.0 / (abs(uv.y + 0.22) + 0.001);
    float x = uv.x * z;
    
    float speed = uTime * 2.5 * (uBPM / 174.0);
    float gridX = abs(sin(x * 5.0)) * z;
    float gridZ = abs(sin(z * 4.0 - speed)) * z;
    
    float gridLine = smoothstep(0.97, 0.995, 1.0 - min(gridX, 0.08) / z);
    gridLine += smoothstep(0.97, 0.995, 1.0 - min(gridZ, 0.08) / z);
    
    float gridInt = gridLine * (1.0 / z) * 0.35 * (0.2 + bass * 1.8) * uPlaying;
    finalColor += uAccentColor * gridInt;
  }

  // Horizontal waveform overlay (glowing neon oscilloscope strip)
  float rawWave = getWave((uv.x + 1.0) * 0.5) * 0.45 * uPlaying;
  // Make it float in a narrow band or center
  float waveGlow = 0.0015 / abs(uv.y - rawWave);
  finalColor += uAccentColor * waveGlow * 0.35;

  fragColor = vec4(bgColor + finalColor, 1.0);
}
`;

export class GLVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    if (!this.gl) {
      console.warn('WebGL2 not available for visualizer, falling back to 2D mock');
      return;
    }

    const gl = this.gl;
    this.prog = createProgram(gl, FRAG_SRC);

    // Setup 1D-like textures for frequency and waveform data
    // We use a 256x1 texture size
    this.freqTex = this._createDataTex(256);
    this.waveTex = this._createDataTex(256);

    // Uniform assignments
    gl.useProgram(this.prog);
    gl.uniform1i(this.prog.u('uFreqTex'), 0);
    gl.uniform1i(this.prog.u('uWaveTex'), 1);

    this.startTime = Date.now();
  }

  _createDataTex(size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  draw(freqData, waveData, bpm, playing, hexAccent) {
    if (!this.gl) return;

    const gl = this.gl;
    const canvas = this.canvas;

    // Handle resizing to match container size
    if (canvas.id === 'visualizer') {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.floor(r.width * dpr);
      const targetH = Math.floor(r.height * dpr);

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
    }

    if (canvas.width === 0 || canvas.height === 0) return;

    gl.viewport(0, 0, canvas.width, canvas.height);

    // Parse accent hex color
    const accent = [0.0, 0.94, 1.0]; // fallback cyan
    if (hexAccent && hexAccent.startsWith('#')) {
      const num = parseInt(hexAccent.slice(1), 16);
      accent[0] = ((num >> 16) & 255) / 255;
      accent[1] = ((num >> 8) & 255) / 255;
      accent[2] = (num & 255) / 255;
    }

    // Bind textures and upload data
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.freqTex);
    if (freqData) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, freqData);
    } else {
      const zeros = new Uint8Array(256);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, zeros);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
    if (waveData) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, waveData);
    } else {
      const middle = new Uint8Array(256).fill(128);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, middle);
    }

    // Set uniforms
    gl.useProgram(this.prog);
    gl.uniform2f(this.prog.u('uResolution'), canvas.width, canvas.height);
    gl.uniform1f(this.prog.u('uTime'), (Date.now() - this.startTime) / 1000);
    gl.uniform1f(this.prog.u('uBPM'), bpm || 120);
    gl.uniform1f(this.prog.u('uPlaying'), playing ? 1.0 : 0.0);
    gl.uniform3f(this.prog.u('uAccentColor'), accent[0], accent[1], accent[2]);

    // Draw full screen quad
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
