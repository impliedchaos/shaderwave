// TR-808 — drum machine. Every voice is analytical (closed-form in t): swept-sine
// kick/toms, sine+noise snare, metallic hats, clap, cowbell. The keyboard selects
// a drum slot (drum: true; note → DRUM_MAP slot in p0.x), not a pitch.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-808.glsl?raw';

export const i808: InstrumentDef = {
  type: '808',
  label: '808 — Drum Machine',
  blurb: 'Analytical drums — swept-sine kick/toms, sine+noise snare, metallic hi-hats, clap, cowbell. Tone, Decay, Snappy.',
  shader,
  drum: true,
  defaults: { p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
  paramDefs: [
    { label: 'Tone', bank: 'p0', i: 1, min: 0, max: 1, step: 0.01 },
    { label: 'Decay', bank: 'p0', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'Snappy', bank: 'p0', i: 3, min: 0, max: 1, step: 0.01 },
  ],
  autoTargets: [
    { code: 'TON', label: 'Tone',   bank: 'p0', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'DEC', label: 'Decay',  bank: 'p0', index: 2, min: 0, max: 1, curve: 'lin' },
    { code: 'SNP', label: 'Snappy', bank: 'p0', index: 3, min: 0, max: 1, curve: 'lin' },
  ],
  presets: [
    { name: 'Classic 808 Kit', p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0], fx: { dist: 0.001, tone: 0.5, level: 1.0, width: 1.0, master: 0.32 } },
    { name: 'Industrial Saturation Kit', p0: [0, 0.4, 0.7, 0.8], p1: [0, 0, 0, 0], fx: { dist: 14.0, tone: 0.5, level: 1.0, width: 0.8, master: 1.0, delayTime: 0.25, delayFeedback: 0.3, delayMix: 0.15, reverbDecay: 0.6, reverbDamp: 0.5, reverbSend: 0.4, reverbMix: 0.15 } },
    { name: 'Cinematic Spatial Kit', p0: [0, 0.5, 0.8, 0.4], p1: [0, 0, 0, 0], fx: { dist: 2.0, tone: 0.55, level: 1.0, width: 0.9, master: 1.0, delayTime: 0.3, delayFeedback: 0.2, delayMix: 0.1, reverbDecay: 0.9, reverbDamp: 0.4, reverbSend: 0.7, reverbMix: 0.6 } },
    { name: 'GoonerBoom', p0: [0, 0.5, 0.8, 0.8], p1: [0, 0, 0, 0] },
    { name: 'PerkyTitsKit', p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
    { name: 'CuckGatedKit', p0: [0, 0.5, 0.8, 0.6], p1: [0, 0, 0, 0] },
    { name: 'AntisepticKit', p0: [0, 0.5, 0.45, 0.6], p1: [0, 0, 0, 0] },
    { name: 'LeftNutKit', p0: [0, 0.55, 0.4, 0.5], p1: [0, 0, 0, 0] },
    { name: 'MurderPartyKit', p0: [0, 0.6, 0.8, 0.4], p1: [0, 0, 0, 0] },
    { name: 'LatchkeyKit', p0: [0, 0.5, 0.45, 0.5], p1: [0, 0, 0, 0] },
    { name: 'VinylKit', p0: [0, 0.45, 0.5, 0.5], p1: [0, 0, 0, 0] },
    { name: 'Booty Metal Kit', p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
  ],
};
