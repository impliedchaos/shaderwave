// Spectra — a massive additive synth, the engine built to actually exercise the GPU.
// Up to 2048 partials per voice, summed in PARALLEL: the synth pass renders a tile of
// partials per fragment (synth-additive.glsl) and a log-reduce pass (additive-reduce.glsl)
// sums the tiles. Unlike every other engine it is multi-pass, so the renderer special-
// cases `additive: true` (see SynthRenderer._renderAdditive). The spectrum is formula-
// driven for now — a stretched harmonic series shaped by Tilt / Odd-Even / Comb with
// per-partial decay + detune — and structured so an uploaded spectral table can slot in
// later for true additive resynthesis.
import type { FxParams, InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-additive.glsl?raw';

export const iadditive: InstrumentDef = {
  type: 'additive',
  name: 'Spectra',
  short: 'SPC',
  label: 'Spectra — Massive Additive (GPU)',
  blurb: 'A GPU-parallel additive synth: up to 2048 partials per voice summed across the chip (one tile of partials per fragment, then a log-reduce). A stretched harmonic series shaped by Partials, Tilt (dark↔bright), Stretch (inharmonicity → bell/metallic), a pluck Comb, Odd/Even, per-partial Decay/DecayTilt and a Detune spread. RESYNTHESIS: give an instance a sample and the Morph knob crossfades the synthetic spectrum into the sample\'s analyzed harmonic profile (click-free, automatable/LFO-able — the marquee spectral movement). Organ, bell, choir, metallic and "what does a kalimba pad sound like" tones.',
  shader,
  additive: true,
  // p0 = (partials, tilt, stretch, MORPH 0=formula↔1=analyzed); p1 = (decay, decayTilt, detune, comb); p2 = (attack, release, odd/even)
  defaults: { p0: [512, 0.5, 0.0, 0.0], p1: [0, 0.5, 0.2, 0.0], p2: [0.02, 0.4, 0.0, 0] },
  paramDefs: [
    { label: 'Partials',  bank: 'p0', i: 0, min: 1, max: 2048, step: 1 },
    { label: 'Tilt',      bank: 'p0', i: 1, min: 0, max: 1,    step: 0.01 },
    { label: 'Stretch',   bank: 'p0', i: 2, min: 0, max: 1,    step: 0.01 },
    { label: 'Morph',     bank: 'p0', i: 3, min: 0, max: 1,    step: 0.01 },
    { label: 'Decay',     bank: 'p1', i: 0, min: 0, max: 10,   step: 0.05 },
    { label: 'DecayTilt', bank: 'p1', i: 1, min: 0, max: 1,    step: 0.01 },
    { label: 'Detune',    bank: 'p1', i: 2, min: 0, max: 1,    step: 0.01 },
    { label: 'Comb',      bank: 'p1', i: 3, min: 0, max: 1,    step: 0.01 },
    { label: 'Attack',    bank: 'p2', i: 0, min: 0.0005, max: 2, step: 0.005 },
    { label: 'Release',   bank: 'p2', i: 1, min: 0.005,  max: 4, step: 0.005 },
    { label: 'Odd/Even',  bank: 'p2', i: 2, min: 0, max: 1,    step: 0.01 },
  ],
  autoTargets: [
    { code: 'PRT', label: 'Partials',  bank: 'p0', index: 0, min: 1, max: 2048, curve: 'log' },
    { code: 'TLT', label: 'Tilt',      bank: 'p0', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'STR', label: 'Stretch',   bank: 'p0', index: 2, min: 0, max: 1, curve: 'lin' },
    { code: 'MOR', label: 'Morph',     bank: 'p0', index: 3, min: 0, max: 1, curve: 'lin' },
    { code: 'DCY', label: 'Decay',     bank: 'p1', index: 0, min: 0, max: 10, curve: 'log', unit: 's' },
    { code: 'DCT', label: 'DecayTilt', bank: 'p1', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'DET', label: 'Detune',    bank: 'p1', index: 2, min: 0, max: 1, curve: 'lin' },
    { code: 'CMB', label: 'Comb',      bank: 'p1', index: 3, min: 0, max: 1, curve: 'lin' },
  ],
  presets: [
    { name: 'Glass Organ',    p0: [1024, 0.7, 0.0,  0.0], p1: [0,   0.5, 0.15, 0.0], p2: [0.02, 0.5, 0.0, 0] },
    { name: 'Cathedral Bell', p0: [800,  0.55, 0.6, 0.0], p1: [6.0, 0.7, 0.25, 0.0], p2: [0.003, 1.2, 0.3, 0] },
    { name: 'Choir Pad',      p0: [1536, 0.45, 0.04, 0.0], p1: [0,  0.5, 0.5,  0.0], p2: [0.4, 1.0, 0.0, 0] },
    { name: 'Metallic',       p0: [1200, 0.6, 0.85, 0.0], p1: [4.0, 0.8, 0.4,  0.4], p2: [0.005, 0.8, 0.5, 0] },
    { name: 'Saw-ish 2048',   p0: [2048, 0.5, 0.0,  0.0], p1: [0,   0.5, 0.1,  0.0], p2: [0.01, 0.3, 0.0, 0] },
    { name: 'Hollow Comb',    p0: [1024, 0.6, 0.0,  0.0], p1: [0,   0.5, 0.2,  0.8], p2: [0.05, 0.6, 0.0, 0] },
  ],
  // Additive spectra love space + a touch of width; a freshly-added instance starts lush.
  fxDefaults: {
    reverbOn: true, reverbDecay: 0.85, reverbDamp: 0.4, reverbSend: 0.6, reverbMix: 0.28,
    widthOn: true, width: 1.3,
  } as Partial<FxParams>,
};
