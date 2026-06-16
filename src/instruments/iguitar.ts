// Guitar — plucked-string synth that morphs between acoustic and electric. Closed-form
// modal synthesis: decaying near-harmonic partials with a pluck-position comb, a Body
// control that crossfades soundboard resonance (acoustic) ↔ pickup comb + long sustain
// (electric), frequency-dependent decay, a pick transient, and a built-in Drive for
// electric overdrive. Fits the universal p0/p1 banks, so no engine-specific plumbing.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-guitar.glsl?raw';

export const iguitar: InstrumentDef = {
  type: 'guitar',
  name: 'Gigi',
  short: 'GTR',
  label: 'Gigi — Acoustic / Electric Guitar',
  blurb: 'Modal plucked-string guitar that morphs acoustic↔electric (Body): pluck-position comb, soundboard resonance vs magnetic-pickup comb + long sustain, frequency-dependent decay, a pick transient and a built-in Drive for electric overdrive. Decay, PluckPos, Tone, Body, Partials, Drive, Pick, Release.',
  shader,
  // p0 = (decay, pluckPos, tone, body[0 elec..1 acoustic]); p1 = (partials, drive, pick, release)
  defaults: { p0: [2.5, 0.2, 0.6, 0.7], p1: [28, 0.0, 0.4, 0.12] },
  paramDefs: [
    { label: 'Decay',    bank: 'p0', i: 0, min: 0.1,  max: 8,    step: 0.05 },
    { label: 'PluckPos', bank: 'p0', i: 1, min: 0.02, max: 0.5,  step: 0.01 },
    { label: 'Tone',     bank: 'p0', i: 2, min: 0,    max: 1,    step: 0.01 },
    { label: 'Body',     bank: 'p0', i: 3, min: 0,    max: 1,    step: 0.01 },
    { label: 'Partials', bank: 'p1', i: 0, min: 1,    max: 32,   step: 1 },
    { label: 'Drive',    bank: 'p1', i: 1, min: 0,    max: 1,    step: 0.01 },
    { label: 'Pick',     bank: 'p1', i: 2, min: 0,    max: 1,    step: 0.01 },
    { label: 'Release',  bank: 'p1', i: 3, min: 0.005, max: 2,   step: 0.005 },
  ],
  autoTargets: [
    { code: 'DEC', label: 'Decay',    bank: 'p0', index: 0, min: 0.1,  max: 8, curve: 'log', unit: 's' },
    { code: 'PLK', label: 'PluckPos', bank: 'p0', index: 1, min: 0.02, max: 0.5, curve: 'lin' },
    { code: 'TON', label: 'Tone',     bank: 'p0', index: 2, min: 0,    max: 1, curve: 'lin' },
    { code: 'BDY', label: 'Body',     bank: 'p0', index: 3, min: 0,    max: 1, curve: 'lin' },
    { code: 'DRV', label: 'Drive',    bank: 'p1', index: 1, min: 0,    max: 1, curve: 'lin' },
    { code: 'REL', label: 'Release',  bank: 'p1', index: 3, min: 0.005, max: 2, curve: 'log', unit: 's' },
  ],
  presets: [
    { name: 'Steel Acoustic',  p0: [2.5, 0.18, 0.65, 0.92], p1: [28, 0.0,  0.45, 0.12] },
    { name: 'Nylon Classical', p0: [2.2, 0.40, 0.40, 0.85], p1: [24, 0.0,  0.30, 0.12] },
    { name: 'Clean Electric',  p0: [4.0, 0.15, 0.6,  0.10], p1: [30, 0.0,  0.35, 0.20] },
    { name: 'Overdrive',       p0: [4.5, 0.13, 0.7,  0.05], p1: [30, 0.55, 0.40, 0.20] },
    { name: 'Crunch Rock',     p0: [3.5, 0.12, 0.75, 0.0],  p1: [28, 0.85, 0.50, 0.15] },
    { name: 'Muted Funk',      p0: [0.7, 0.10, 0.55, 0.2],  p1: [24, 0.2,  0.6,  0.05] },
  ],
};
