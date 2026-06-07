// Wavewright — short name "WVT". A wavetable synth: two oscillators sweep a
// continuous Position through one of 8 morph banks (Classic, Harmonic, PWM,
// Formant, Resonant, Metallic, Wavefolder, Digital — see wavetables.ts), mixed
// with a sine sub and an optional cross-FM. Closed-form, so it fits the universal
// p0..p3 banks; the wavetable texture is uploaded once by the renderer and shared
// by every instance. Position is the marquee param and an ideal LFO target.
//
// FIRST CUT (see synth-wvt.glsl): full-bandwidth table (aliases up high — band-
// limited mips are the next step). Pairs with the global LFOs, which can also use
// these banks as modulation shapes.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-wvt.glsl?raw';

export const iwvt: InstrumentDef = {
  type: 'wvt',
  name: 'Wavewright',
  short: 'WVT',
  label: 'Wavewright — Wavetable',
  blurb: 'Two-oscillator wavetable synth: each osc sweeps a continuous Position through one of 16 morph banks (Classic/Harmonic/PWM/Formant/Resonant/Metallic/Wavefolder/Digital/Organ/Sync/Saturate/Comb/Skew/Noise/Power/Glass), mixed with a sine sub and optional cross-FM. Band-limited + phase-accumulating. Attack, Decay, Sustain, Release, Pos1/Pos2 (great LFO targets), Detune2, FM, Bank1/Bank2, Sub, SubOct, Level1/Level2.',
  shader,
  // p0 ADSR · p1 (pos1, pos2, detune2 semis, FM) · p2 (bank1, bank2, subLvl, subOct) · p3 (lvl1, lvl2)
  defaults: { p0: [0.01, 0.3, 0.7, 0.3], p1: [0.0, 0.3, 0.07, 0.0], p2: [0, 0, 0.0, -1], p3: [0.8, 0.6, 0, 0] },
  paramDefs: [
    { label: 'Attack',  bank: 'p0', i: 0, min: 0,    max: 1,   step: 0.001 },
    { label: 'Decay',   bank: 'p0', i: 1, min: 0,    max: 2,   step: 0.005 },
    { label: 'Sustain', bank: 'p0', i: 2, min: 0,    max: 1,   step: 0.01 },
    { label: 'Release', bank: 'p0', i: 3, min: 0,    max: 2,   step: 0.005 },
    { label: 'Pos1',    bank: 'p1', i: 0, min: 0,    max: 1,   step: 0.01 },
    { label: 'Pos2',    bank: 'p1', i: 1, min: 0,    max: 1,   step: 0.01 },
    { label: 'Detune2', bank: 'p1', i: 2, min: -24,  max: 24,  step: 0.01 },
    { label: 'FM',      bank: 'p1', i: 3, min: 0,    max: 1,   step: 0.01 },
    { label: 'Bank1',   bank: 'p2', i: 0, min: 0,    max: 15,  step: 1 },
    { label: 'Bank2',   bank: 'p2', i: 1, min: 0,    max: 15,  step: 1 },
    { label: 'Sub',     bank: 'p2', i: 2, min: 0,    max: 1,   step: 0.01 },
    { label: 'SubOct',  bank: 'p2', i: 3, min: -2,   max: 0,   step: 1 },
    { label: 'Level1',  bank: 'p3', i: 0, min: 0,    max: 1,   step: 0.01 },
    { label: 'Level2',  bank: 'p3', i: 1, min: 0,    max: 1,   step: 0.01 },
    { label: 'EnvPos1', bank: 'p3', i: 2, min: -1,   max: 1,   step: 0.01 },
    { label: 'EnvPos2', bank: 'p3', i: 3, min: -1,   max: 1,   step: 0.01 },
  ],
  autoTargets: [
    { code: 'ATK', label: 'Attack',  bank: 'p0', index: 0, min: 0,   max: 1,  curve: 'lin', unit: 's' },
    { code: 'DEC', label: 'Decay',   bank: 'p0', index: 1, min: 0,   max: 2,  curve: 'lin', unit: 's' },
    { code: 'SUS', label: 'Sustain', bank: 'p0', index: 2, min: 0,   max: 1,  curve: 'lin' },
    { code: 'REL', label: 'Release', bank: 'p0', index: 3, min: 0,   max: 2,  curve: 'lin', unit: 's' },
    { code: 'PS1', label: 'Pos1',    bank: 'p1', index: 0, min: 0,   max: 1,  curve: 'lin' },
    { code: 'PS2', label: 'Pos2',    bank: 'p1', index: 1, min: 0,   max: 1,  curve: 'lin' },
    { code: 'DT2', label: 'Detune2', bank: 'p1', index: 2, min: -24, max: 24, curve: 'lin', unit: 'st' },
    { code: 'FM',  label: 'FM',      bank: 'p1', index: 3, min: 0,   max: 1,  curve: 'lin' },
  ],
  presets: [
    { name: 'Classic Sweep', p0: [0.01, 0.4, 0.8, 0.4], p1: [0.0, 0.5, 0.08, 0.0], p2: [0, 0, 0.0, -1], p3: [0.8, 0.6, 0, 0] },
    { name: 'PWM Strings',   p0: [0.05, 0.5, 0.85, 0.5], p1: [0.2, 0.7, 0.12, 0.0], p2: [2, 2, 0.0, -1], p3: [0.8, 0.7, 0, 0] },
    { name: 'Vowel Pad',     p0: [0.2, 0.6, 0.8, 0.6], p1: [0.1, 0.6, 0.1, 0.0], p2: [3, 3, 0.0, -1], p3: [0.8, 0.6, 0, 0] },
    { name: 'Metallic FM',   p0: [0.005, 0.3, 0.4, 0.3], p1: [0.3, 0.5, 0.0, 0.5], p2: [5, 5, 0.0, -1], p3: [0.8, 0.5, 0, 0] },
    { name: 'Sub Bass',      p0: [0.005, 0.2, 0.6, 0.15], p1: [0.0, 0.2, 0.0, 0.0], p2: [0, 0, 0.8, -1], p3: [0.7, 0.3, 0, 0] },
  ],
};
