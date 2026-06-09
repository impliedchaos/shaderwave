import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-sampler.glsl?raw';
export const isampler: InstrumentDef = {
  type: 'sampler',
  name: 'Sampler',
  short: 'SMP',
  label: 'Sampler — PCM Playback',
  blurb: 'Plays a loaded audio file, pitched by note. Start, loop, amp envelope.',
  shader,
  defaults: { p0: [0, 0, 1, 0], p1: [0.001, 0.2, 1, 0.05] },   // tune, start, gain ; A D S R
  paramDefs: [
    { label: 'Tune',   type: 'global', bank: 'p0', i: 0, min: -24, max: 24, step: 1 },
    { label: 'Start',  type: 'global', bank: 'p0', i: 1, min: 0, max: 1, step: 0.001 },
    { label: 'Gain',   type: 'global', bank: 'p0', i: 2, min: 0, max: 2, step: 0.01 },
    { label: 'Attack', type: 'global', bank: 'p1', i: 0, min: 0.001, max: 1, step: 0.001 },
    { label: 'Decay',  type: 'global', bank: 'p1', i: 1, min: 0.001, max: 2, step: 0.001 },
    { label: 'Sustain',type: 'global', bank: 'p1', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'Release',type: 'global', bank: 'p1', i: 3, min: 0.001, max: 2, step: 0.001 },
  ],
  autoTargets: [
    { code: 'TUN', label: 'Tune',   bank: 'p0', index: 0, min: -24, max: 24, curve: 'lin' },
    { code: 'STR', label: 'Start',  bank: 'p0', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'GAN', label: 'Gain',   bank: 'p0', index: 2, min: 0, max: 2, curve: 'lin' },
    { code: 'ATK', label: 'Attack', bank: 'p1', index: 0, min: 0.001, max: 1, curve: 'lin', unit: 's' },
    { code: 'DEC', label: 'Decay',  bank: 'p1', index: 1, min: 0.001, max: 2, curve: 'lin', unit: 's' },
    { code: 'SUS', label: 'Sustain',bank: 'p1', index: 2, min: 0, max: 1, curve: 'lin' },
    { code: 'REL', label: 'Release',bank: 'p1', index: 3, min: 0.001, max: 2, curve: 'lin', unit: 's' },
  ],
  presets: [
    {
      name: 'VCSL Crash Cymbal',
      p0: [0, 0, 1, 0],
      p1: [0.001, 3, 0, 0.4],
      sample: {
        name: 'crash.wav',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/crash.wav'
      }
    },
    {
      name: 'VCSL Cowbell',
      p0: [0, 0, 1.2, 0],
      p1: [0.001, 1, 0, 0.1],
      sample: {
        name: 'cowbell.wav',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/cowbell.wav'
      }
    },
    {
      name: 'VCSL Tambourine',
      p0: [0, 0, 1.5, 0],
      p1: [0.001, 1, 0, 0.05],
      sample: {
        name: 'tamb.wav',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/tamb.wav'
      }
    },
    {
      name: 'Vocal - Shader Wave',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 2, 0.5, 0.1],
      sample: {
        name: 'vocal.mp3',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/vocal.mp3'
      }
    }
  ],
  uploadVoiceUniforms: (gl, prog, vd) => {
    if (!vd.sampler) return;
    gl.uniform1fv(prog.u('uSmpSlot[0]'),      vd.sampler.slot);
    gl.uniform1fv(prog.u('uSmpBaseRow[0]'),   vd.sampler.baseRow);
    gl.uniform1fv(prog.u('uSmpLen[0]'),       vd.sampler.len);
    gl.uniform1fv(prog.u('uSmpRootFreq[0]'),  vd.sampler.rootFreq);
    gl.uniform1fv(prog.u('uSmpLoopStart[0]'), vd.sampler.loopStart);
    gl.uniform1fv(prog.u('uSmpLoopEnd[0]'),   vd.sampler.loopEnd);
    gl.uniform1fv(prog.u('uSmpLoopMode[0]'),  vd.sampler.loopMode);
  },
};
