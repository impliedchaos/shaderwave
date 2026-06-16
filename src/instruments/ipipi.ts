// Pipi — a physically-informed piano. Closed-form modal synthesis: a sum of decaying,
// inharmonic (stretched) string partials with a hammer-strike comb spectrum, two-rate
// frequency-dependent decay, a detuned 1–3 string choir, phase-coherent strike, register
// voicing (bass richer/longer, treble sparser/shorter), a soundboard body resonance, and a
// hammer thunk — the piano physics that matter, in the closed-form style (no recursion).
// Fits the universal p0/p1 banks, so no engine-specific plumbing.
import type { FxParams, InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-pipi.glsl?raw';

export const ipipi: InstrumentDef = {
  type: 'pipi',
  name: 'Pipi',
  short: 'PNO',
  label: 'Pipi — Piano',
  blurb: 'Physically-informed modal piano: inharmonic (stretched) partials, a hammer-strike comb spectrum that brightens with velocity, a two-rate "double" decay, detuned string-pair beating and a hammer thunk. Decay, Inharm, Hardness, Hammer, Partials, Detune, Damping, Release (long Release ≈ sustain pedal).',
  shader,
  // p0 = (decay, inharmonicity B, hardness, hammer); p1 = (partials, detune, damping, release)
  defaults: { p0: [4.0, 0.0004, 0.5, 0.3], p1: [24, 0.0015, 0.8, 0.15] },
  paramDefs: [
    { label: 'Decay',    bank: 'p0', i: 0, min: 0.1,  max: 10,    step: 0.1 },
    { label: 'Inharm',   bank: 'p0', i: 1, min: 0,    max: 0.005, step: 0.0001 },
    { label: 'Hardness', bank: 'p0', i: 2, min: 0,    max: 1,     step: 0.01 },
    { label: 'Hammer',   bank: 'p0', i: 3, min: 0,    max: 1,     step: 0.01 },
    { label: 'Partials', bank: 'p1', i: 0, min: 1,    max: 32,    step: 1 },
    { label: 'Detune',   bank: 'p1', i: 1, min: 0,    max: 0.01,  step: 0.0001 },
    { label: 'Damping',  bank: 'p1', i: 2, min: 0,    max: 3,     step: 0.05 },
    { label: 'Release',  bank: 'p1', i: 3, min: 0.005, max: 2,    step: 0.005 },
  ],
  autoTargets: [
    { code: 'DEC', label: 'Decay',    bank: 'p0', index: 0, min: 0.1, max: 10,    curve: 'log', unit: 's' },
    { code: 'INH', label: 'Inharm',   bank: 'p0', index: 1, min: 0,   max: 0.005, curve: 'lin' },
    { code: 'HRD', label: 'Hardness', bank: 'p0', index: 2, min: 0,   max: 1,     curve: 'lin' },
    { code: 'HAM', label: 'Hammer',   bank: 'p0', index: 3, min: 0,   max: 1,     curve: 'lin' },
    { code: 'DMP', label: 'Damping',  bank: 'p1', index: 2, min: 0,   max: 3,     curve: 'lin' },
    { code: 'REL', label: 'Release',  bank: 'p1', index: 3, min: 0.005, max: 2,   curve: 'log', unit: 's' },
  ],
  presets: [
    { name: 'Grand',       p0: [4.5, 0.0004, 0.55, 0.3],  p1: [26, 0.0015, 0.8, 0.15] },
    { name: 'Concert',     p0: [5.5, 0.0004, 0.7,  0.35], p1: [30, 0.0013, 0.6, 0.18] },
    { name: 'Mellow',      p0: [5.0, 0.0003, 0.25, 0.2],  p1: [20, 0.0010, 1.0, 0.20] },
    { name: 'Felt',        p0: [5.5, 0.0003, 0.12, 0.15], p1: [18, 0.0009, 1.2, 0.22] },
    { name: 'Bright',      p0: [3.5, 0.0005, 0.85, 0.4],  p1: [28, 0.0018, 0.7, 0.12] },
    { name: 'Honky-Tonk',  p0: [3.5, 0.0006, 0.6,  0.4],  p1: [24, 0.0060, 0.8, 0.15] },
    { name: 'Upright',     p0: [2.8, 0.0008, 0.5,  0.45], p1: [22, 0.0020, 1.0, 0.12] },
    { name: 'Bell Piano',  p0: [5.0, 0.0025, 0.7,  0.25], p1: [24, 0.0015, 0.6, 0.40] },
  ],
  // A piano is dry/clicky bare; a freshly-added instance starts in a small room with
  // gentle glue comp and a touch of air + width (merged over the all-off neutral set).
  fxDefaults: {
    eqOn: true, eqLow: -2, eqMid: 0, eqHigh: 2.5, eqLowFreq: 120, eqHighFreq: 4000,
    compOn: true, compThresh: -20, compRatio: 2.5, compAttack: 8, compRelease: 160, compMakeup: 3,
    reverbOn: true, reverbDecay: 0.82, reverbDamp: 0.45, reverbSend: 0.6, reverbMix: 0.2,
    widthOn: true, width: 1.18,
  } as Partial<FxParams>,
};
