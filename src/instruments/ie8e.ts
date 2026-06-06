// 888State — short name "E8E" (visually distinct from the 808). A 3-oscillator
// additive synth: sine/square/triangle/noise per oscillator, a standard ADSR, and
// the defining 8-bit quantization (256 steps) that crunches the summed output.
// Can act as a single, dual or triple oscillator via the Oscs knob. Closed-form,
// so it fits the universal p0..p3 banks with no engine-specific plumbing.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-e8e.glsl?raw';

export const ie8e: InstrumentDef = {
  type: 'e8e',
  name: '888State',
  short: 'E8E',
  label: '888State — 8-bit Additive',
  blurb: '3-oscillator additive synth (single/dual/triple) with sine/saw/square/triangle/noise waves and a standard ADSR, crunched through an 8-bit quantizer. Attack, Decay, Sustain, Release, three Waves, Detune, Levels, Oscs, PulseW, Bits, Drive.',
  shader,
  defaults: { p0: [0.005, 0.25, 0.6, 0.25], p1: [0.12, -12, 8, 0.0], p2: [2, 2, 3, 2], p3: [1.0, 0.8, 0.5, 0.5] },
  paramDefs: [
    { label: 'Attack',  bank: 'p0', i: 0, min: 0,    max: 1,    step: 0.001 },
    { label: 'Decay',   bank: 'p0', i: 1, min: 0,    max: 2,    step: 0.005 },
    { label: 'Sustain', bank: 'p0', i: 2, min: 0,    max: 1,    step: 0.01 },
    { label: 'Release', bank: 'p0', i: 3, min: 0,    max: 2,    step: 0.005 },
    { label: 'Detune2', bank: 'p1', i: 0, min: -24,  max: 24,   step: 0.01 },
    { label: 'Detune3', bank: 'p1', i: 1, min: -24,  max: 24,   step: 0.01 },
    { label: 'Bits',    bank: 'p1', i: 2, min: 1,    max: 16,   step: 1 },
    { label: 'Drive',   bank: 'p1', i: 3, min: 0,    max: 1,    step: 0.01 },
    { label: 'Wave1',   bank: 'p2', i: 0, min: 0,    max: 4,    step: 1 },
    { label: 'Wave2',   bank: 'p2', i: 1, min: 0,    max: 4,    step: 1 },
    { label: 'Wave3',   bank: 'p2', i: 2, min: 0,    max: 4,    step: 1 },
    { label: 'Oscs',    bank: 'p2', i: 3, min: 1,    max: 3,    step: 1 },
    { label: 'Level1',  bank: 'p3', i: 0, min: 0,    max: 1,    step: 0.01 },
    { label: 'Level2',  bank: 'p3', i: 1, min: 0,    max: 1,    step: 0.01 },
    { label: 'Level3',  bank: 'p3', i: 2, min: 0,    max: 1,    step: 0.01 },
    { label: 'PulseW',  bank: 'p3', i: 3, min: 0.02, max: 0.98, step: 0.01 },
  ],
  autoTargets: [
    { code: 'ATK', label: 'Attack',  bank: 'p0', index: 0, min: 0,   max: 1,  curve: 'lin', unit: 's' },
    { code: 'DEC', label: 'Decay',   bank: 'p0', index: 1, min: 0,   max: 2,  curve: 'lin', unit: 's' },
    { code: 'SUS', label: 'Sustain', bank: 'p0', index: 2, min: 0,   max: 1,  curve: 'lin' },
    { code: 'DT2', label: 'Detune2', bank: 'p1', index: 0, min: -24, max: 24, curve: 'lin', unit: 'st' },
    { code: 'DT3', label: 'Detune3', bank: 'p1', index: 1, min: -24, max: 24, curve: 'lin', unit: 'st' },
    { code: 'BIT', label: 'Bits',    bank: 'p1', index: 2, min: 1,   max: 16, curve: 'lin' },
    { code: 'DRV', label: 'Drive',   bank: 'p1', index: 3, min: 0,   max: 1,  curve: 'lin' },
  ],
  presets: [
    { name: 'Crunch Lead',   p0: [0.005, 0.25, 0.6, 0.25], p1: [0.12, -12, 8,  0.0], p2: [2, 2, 3, 2], p3: [1.0, 0.8, 0.5, 0.5] },
    { name: 'Chip Bass',     p0: [0.002, 0.12, 0.0, 0.06], p1: [0.0,  -12, 6,  0.2], p2: [2, 2, 0, 2], p3: [1.0, 0.7, 0.0, 0.5] },
    { name: 'Fat Saw Stack', p0: [0.01,  0.4,  0.8, 0.4],  p1: [0.18, 12,  8,  0.0], p2: [1, 1, 1, 3], p3: [1.0, 0.9, 0.7, 0.5] },
    { name: 'Glass Bell',    p0: [0.001, 0.6,  0.0, 0.5],  p1: [7.0,  19,  10, 0.0], p2: [0, 0, 0, 3], p3: [1.0, 0.6, 0.4, 0.5] },
    { name: 'Lo-Fi Pad',     p0: [0.2,   0.5,  0.7, 0.6],  p1: [0.08, -12, 5,  0.0], p2: [3, 3, 0, 3], p3: [1.0, 0.8, 0.6, 0.5] },
    { name: 'Hiss Stab',     p0: [0.001, 0.08, 0.0, 0.05], p1: [0.0,  -24, 4,  0.3], p2: [2, 4, 0, 2], p3: [1.0, 0.4, 0.5, 0.5] },
  ],
};
