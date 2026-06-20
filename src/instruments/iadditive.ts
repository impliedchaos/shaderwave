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
  blurb: 'A GPU-parallel additive synth: up to 2048 partials per voice summed across the chip (one tile of partials per fragment, then a log-reduce). A stretched harmonic series shaped by Partials, Tilt (dark↔bright), Stretch (inharmonicity → bell/metallic), a pluck Comb, Odd/Even, per-partial Decay/DecayTilt and a Detune spread. RESYNTHESIS: give an instance a sample and the Morph knob crossfades the synthetic spectrum into the sample\'s analyzed profile — a bright attack spectrum that settles into the sustain body, with each harmonic decaying at its own sampled rate (click-free, automatable/LFO-able — the marquee spectral movement). Organ, bell, choir, metallic and "what does a kalimba pad sound like" tones.',
  shader,
  additive: true,
  stereo: true,   // emits independent L/R (partials fanned by p4.x); spread=0 → mono, bit-identical
  // p0 = (partials, tilt, stretch, MORPH 0=formula↔1=analyzed); p1 = (decay, decayTilt, detune, comb);
  // p2 = (attack, release, odd/even, COHERENCE 0=random-phase wash↔1=coherent strike);
  // p3 = (shimmer, formant pos, formant amt [0=off], formant BW); p4 = (STEREO spread, -, -, -).
  // Default p3/p4 are NEUTRAL (shimmer/formant/stereo off) so songs that omit them (the banks are
  // back-filled from here) stay bit-identical; a fresh +Add gets a touch of coherence for a defined
  // attack. The lively shimmer/formant/stereo character lives in the presets.
  defaults: { p0: [512, 0.5, 0.0, 0.0], p1: [0, 0.5, 0.2, 0.0], p2: [0.02, 0.4, 0.0, 0.5], p3: [0.0, 0.0, 0.0, 0.5], p4: [0.0, 0.0, 0.0, 0.0] },
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
    { label: 'Coherence', bank: 'p2', i: 3, min: 0, max: 1,    step: 0.01 },
    { label: 'Shimmer',   bank: 'p3', i: 0, min: 0, max: 1,    step: 0.01 },
    { label: 'Formant',   bank: 'p3', i: 1, min: 0, max: 1,    step: 0.01 },
    { label: 'Fmt Amt',   bank: 'p3', i: 2, min: 0, max: 3,    step: 0.01 },
    { label: 'Fmt BW',    bank: 'p3', i: 3, min: 0.1, max: 3,  step: 0.05 },
    { label: 'Stereo',    bank: 'p4', i: 0, min: 0, max: 1,    step: 0.01 },
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
    { code: 'COH', label: 'Coherence', bank: 'p2', index: 3, min: 0, max: 1, curve: 'lin' },
    { code: 'SHM', label: 'Shimmer',   bank: 'p3', index: 0, min: 0, max: 1, curve: 'lin' },
    { code: 'FMP', label: 'Formant',   bank: 'p3', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'FMA', label: 'Fmt Amt',   bank: 'p3', index: 2, min: 0, max: 3, curve: 'lin' },
    { code: 'FMW', label: 'Fmt BW',    bank: 'p3', index: 3, min: 0.1, max: 3, curve: 'lin' },
    { code: 'SPR', label: 'Stereo',    bank: 'p4', index: 0, min: 0, max: 1, curve: 'lin' },
  ],
  // p2[3] = Coherence (struck/plucked voices want it high for a defined attack; pads stay low/washy);
  // p3 = [Shimmer, Formant pos, Formant amt (0 = off), Formant BW].
  presets: [
    { name: 'Glass Organ',    p0: [1024, 0.7, 0.0,  0.0], p1: [0,   0.5, 0.15, 0.0], p2: [0.02, 0.5, 0.0, 0.5],  p3: [0.15, 0.0,  0.0, 0.5] },
    { name: 'Cathedral Bell', p0: [800,  0.55, 0.6, 0.0], p1: [6.0, 0.7, 0.25, 0.0], p2: [0.003, 1.2, 0.3, 0.9], p3: [0.0,  0.0,  0.0, 0.5] },
    { name: 'Choir Pad',      p0: [1536, 0.45, 0.04, 0.0], p1: [0,  0.5, 0.5,  0.0], p2: [0.4, 1.0, 0.0, 0.2],   p3: [0.5,  0.35, 0.8, 0.8], p4: [0.7, 0, 0, 0] },
    { name: 'Metallic',       p0: [1200, 0.6, 0.85, 0.0], p1: [4.0, 0.8, 0.4,  0.4], p2: [0.005, 0.8, 0.5, 0.85], p3: [0.0, 0.0,  0.0, 0.5] },
    { name: 'Saw-ish 2048',   p0: [2048, 0.5, 0.0,  0.0], p1: [0,   0.5, 0.1,  0.0], p2: [0.01, 0.3, 0.0, 0.7],  p3: [0.1,  0.0,  0.0, 0.5] },
    { name: 'Hollow Comb',    p0: [1024, 0.6, 0.0,  0.0], p1: [0,   0.5, 0.2,  0.8], p2: [0.05, 0.6, 0.0, 0.5],  p3: [0.2,  0.0,  0.0, 0.5] },
    // — more formula voicings —
    { name: 'Pure Sine',      p0: [1,    0.5, 0.0,  0.0], p1: [0,   0.5, 0.0,  0.0], p2: [0.01,  0.4, 0.0, 1.0], p3: [0.0,  0.0,  0.0, 0.5] },  // single partial → clean fundamental
    { name: 'Drawbar Organ',  p0: [16,   0.5, 0.0,  0.0], p1: [0,   0.5, 0.05, 0.0], p2: [0.004, 0.12, 0.0, 0.85], p3: [0.1, 0.0, 0.0, 0.5] }, // few harmonics, snappy
    { name: 'Soft Pad',       p0: [1536, 0.32, 0.02, 0.0], p1: [0,  0.5, 0.6,  0.0], p2: [0.8,   1.6, 0.0, 0.15], p3: [0.5, 0.0,  0.0, 0.5], p4: [0.8, 0, 0, 0] },  // dark, slow, wide detune, breathing, wide
    { name: 'Bowed Glass',    p0: [1024, 0.62, 0.15, 0.0], p1: [0,  0.5, 0.4,  0.0], p2: [1.0,   1.2, 0.0, 0.3],  p3: [0.4, 0.0,  0.0, 0.5], p4: [0.6, 0, 0, 0] },  // slow swell, faint inharmonicity
    { name: 'Tubular Bells',  p0: [600,  0.5, 0.75, 0.0], p1: [7.0, 0.6, 0.15, 0.0], p2: [0.002, 2.2, 0.4, 0.9], p3: [0.0,  0.0,  0.0, 0.5] },  // long inharmonic ring
    { name: 'Music Box',      p0: [400,  0.72, 0.4, 0.0], p1: [2.5, 0.85, 0.1, 0.0], p2: [0.001, 1.0, 0.3, 0.95], p3: [0.0, 0.0,  0.0, 0.5] },  // bright, short, sparse
    { name: 'Glass Pluck',    p0: [1024, 0.7, 0.1,  0.0], p1: [1.2, 0.7, 0.2,  0.3], p2: [0.002, 0.5, 0.0, 0.9], p3: [0.05, 0.0,  0.0, 0.5] },  // bright comb pluck
    { name: 'Clarinet (odd)', p0: [768,  0.55, 0.0, 0.0], p1: [0,   0.5, 0.15, 0.25], p2: [0.03, 0.4, 1.0, 0.6], p3: [0.1,  0.25, 0.6, 0.7] },  // odd-harmonic hollow reed + woody formant
    { name: 'Saw Swarm',      p0: [2048, 0.45, 0.0, 0.0], p1: [0,   0.5, 0.85, 0.0], p2: [0.02,  0.5, 0.0, 0.4], p3: [0.3,  0.0,  0.0, 0.5], p4: [0.85, 0, 0, 0] },  // heavy-detune supersaw wall, wide
    // — formant-driven voices (sweep/automate Formant for vowel morphs) —
    { name: 'Vowel Choir',    p0: [1024, 0.5, 0.0,  0.0], p1: [0,   0.5, 0.35, 0.0], p2: [0.2, 1.0, 0.0, 0.25], p3: [0.45, 0.35, 1.2, 0.6], p4: [0.7, 0, 0, 0] },  // resonant "aah" choir, wide
    { name: 'Talking Pad',    p0: [1280, 0.45, 0.02, 0.0], p1: [0,  0.5, 0.4,  0.0], p2: [0.3, 1.2, 0.0, 0.2],  p3: [0.5,  0.5,  1.0, 0.5], p4: [0.6, 0, 0, 0] },  // shimmer + sweepable formant, wide
    // — bowed strings (sawtooth-like partials + body formants + bow shimmer) —
    { name: 'Violin',         p0: [1024, 0.48, 0.0,  0.0], p1: [0,  0.5, 0.15, 0.0], p2: [0.1,  0.4, 0.0, 0.05], p3: [0.25, 0.45, 1.2, 0.8], p4: [0.3, 0, 0, 0] },
    { name: 'Cello',          p0: [1536, 0.55, 0.0,  0.0], p1: [0,  0.5, 0.15, 0.0], p2: [0.18, 0.6, 0.0, 0.05], p3: [0.2,  0.25, 1.4, 1.2], p4: [0.4, 0, 0, 0] },
    { name: 'Double Bass',    p0: [2048, 0.6,  0.0,  0.0], p1: [0,  0.5, 0.2,  0.0], p2: [0.25, 0.8, 0.0, 0.02], p3: [0.15, 0.1,  1.8, 1.5], p4: [0.5, 0, 0, 0] },
    // — resynthesis: load a sample, Morph crossfades the synth spectrum into its analyzed profile —
    { name: 'Kalimba (resynth)', p0: [768, 0.55, 0.0, 1.0], p1: [0, 0.6, 0.12, 0.0], p2: [0.004, 0.9, 0.0, 0.85], p3: [0.0, 0.0, 0.0, 0.5],
      sample: { name: 'Kalimba', url: '/samples/kalimba.ogg', rootNote: 60, loopStart: 0, loopEnd: 0, loopMode: 0 } },
    { name: 'Vox Pad (resynth)', p0: [1024, 0.5, 0.0, 0.9], p1: [0, 0.5, 0.35, 0.0], p2: [0.3, 1.1, 0.0, 0.2], p3: [0.4, 0.4, 0.5, 0.8], p4: [0.65, 0, 0, 0],
      sample: { name: 'Vox', url: '/samples/dvs-oh-1.ogg', rootNote: 60, loopStart: 0, loopEnd: 0, loopMode: 0 } },
  ],
  // Additive spectra love space + a touch of width; a freshly-added instance starts lush.
  fxDefaults: {
    reverbOn: true, reverbDecay: 0.85, reverbDamp: 0.4, reverbSend: 0.6, reverbMix: 0.28,
    widthOn: true, width: 1.3,
  } as Partial<FxParams>,
};
