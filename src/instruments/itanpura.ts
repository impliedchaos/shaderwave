// Tanpura — Indian drone. Closed-form additive/modal synthesis (no recursion):
// a sum of decaying partials whose character is the jivari, a gaussian spectral
// formant that sweeps upward and sustains bright. Programmed as a plucked-string
// voice — author the classic Pa–sa–sa–Sa' cycle in the tracker; overlapping long
// decays across channels (detune the courses a few cents) make the drone wash.
// Fits the universal p0/p1 banks, so it needs no engine-specific plumbing.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-tanpura.glsl?raw';

export const itanpura: InstrumentDef = {
  type: 'tanpura',
  name: 'Tanpura',
  short: 'TAN',
  label: 'Tanpura — Drone',
  blurb: 'Additive/modal Indian drone — a string over a curved jivari bridge whose buzzing overtone bloom sweeps upward and sustains bright. Decay, Jivari, Bright, Pluck, Partials, Inharm, Bloom, Attack, Infinite (drone forever).',
  shader,
  // p2.x = Infinite: when on, partials never decay → the drone rings until note-off.
  defaults: { p0: [3.0, 0.6, 0.06, 0.13], p1: [48, 0.00008, 0.25, 0.005], p2: [0, 0, 0, 0] },
  paramDefs: [
    { label: 'Decay', bank: 'p0', i: 0, min: 0.2, max: 8, step: 0.05 },
    { label: 'Jivari', bank: 'p0', i: 1, min: 0, max: 1, step: 0.01 },
    { label: 'Bright', bank: 'p0', i: 2, min: 0, max: 0.4, step: 0.005 },
    { label: 'Pluck', bank: 'p0', i: 3, min: 0, max: 0.5, step: 0.01 },
    { label: 'Partials', bank: 'p1', i: 0, min: 1, max: 64, step: 1 },
    { label: 'Inharm', bank: 'p1', i: 1, min: 0, max: 0.001, step: 0.00001 },
    { label: 'Bloom', bank: 'p1', i: 2, min: 0.02, max: 2, step: 0.01 },
    { label: 'Attack', bank: 'p1', i: 3, min: 0.001, max: 0.2, step: 0.001 },
    { label: 'Infinite', bank: 'p2', i: 0, min: 0, max: 1, step: 1 },
  ],
  autoTargets: [
    { code: 'DEC', label: 'Decay',  bank: 'p0', index: 0, min: 0.2, max: 8,   curve: 'log', unit: 's' },
    { code: 'JVR', label: 'Jivari', bank: 'p0', index: 1, min: 0,   max: 1,   curve: 'lin' },
    { code: 'BRT', label: 'Bright', bank: 'p0', index: 2, min: 0,   max: 0.4, curve: 'lin' },
    { code: 'PLK', label: 'Pluck',  bank: 'p0', index: 3, min: 0,   max: 0.5, curve: 'lin' },
  ],
  presets: [
    { name: 'Drone Sa',       p0: [3.0, 0.6,  0.06, 0.13], p1: [48, 0.00008, 0.25, 0.005], fx: { reverbOn: true, reverbDecay: 0.9, reverbSend: 0.6, reverbMix: 0.35, master: 0.5 } },
    { name: 'Bright Jivari',  p0: [3.5, 0.85, 0.04, 0.10], p1: [56, 0.00012, 0.15, 0.004], fx: { reverbOn: true, reverbDecay: 0.92, reverbSend: 0.7, reverbMix: 0.4, master: 0.45 } },
    { name: 'Mellow Tanpura', p0: [4.5, 0.4,  0.10, 0.18], p1: [40, 0.00005, 0.4,  0.008], fx: { reverbOn: true, reverbDecay: 0.88, reverbSend: 0.5, reverbMix: 0.3, master: 0.55 } },
  ],
};
