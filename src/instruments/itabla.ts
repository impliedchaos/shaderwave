// Tabla — Indian hand drums (dayan/bayan). Closed-form modal synthesis: a sum of
// decaying near-harmonic modes (the syahi-loaded membrane is what makes a tabla
// PITCHED — set the pitch with the played note). A strike transient is the finger/
// palm contact; Damp shortens the ring for closed strokes (te/ka); Bend is the bayan
// palm-heel pitch glide (ge/ghe). Pairs with the Tanpura for the raga demos. Fits the
// universal p0/p1 banks, so no engine-specific plumbing.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-tabla.glsl?raw';

export const itabla: InstrumentDef = {
  type: 'tabla',
  name: 'Tabla',
  short: 'TBL',
  label: 'Tabla — Indian Hand Drums',
  blurb: 'Modal-synthesis tabla (dayan/bayan): near-harmonic decaying modes give a pitched drum tone (set by the note), with a finger strike, Damp for closed strokes (te/ka) and Bend for the bayan palm-glide (ge/ghe — play low + bend). Decay, Damp, Strike, Bend, Modes, Inharm, BendTime, Tone.',
  shader,
  // p0 = (decay, damp, strike, bend semis); p1 = (modes, inharm, bendTime, tone)
  defaults: { p0: [0.5, 0.0, 0.4, 0.0], p1: [7, 0.0006, 0.06, 0.5] },
  paramDefs: [
    { label: 'Decay',    bank: 'p0', i: 0, min: 0.05, max: 3,     step: 0.01 },
    { label: 'Damp',     bank: 'p0', i: 1, min: 0,    max: 1,     step: 0.01 },
    { label: 'Strike',   bank: 'p0', i: 2, min: 0,    max: 1,     step: 0.01 },
    { label: 'Bend',     bank: 'p0', i: 3, min: -12,  max: 12,    step: 0.1 },
    { label: 'Modes',    bank: 'p1', i: 0, min: 1,    max: 12,    step: 1 },
    { label: 'Inharm',   bank: 'p1', i: 1, min: 0,    max: 0.005, step: 0.0001 },
    { label: 'BendTime', bank: 'p1', i: 2, min: 0.005, max: 0.4,  step: 0.005 },
    { label: 'Tone',     bank: 'p1', i: 3, min: 0,    max: 1,     step: 0.01 },
  ],
  autoTargets: [
    { code: 'DEC', label: 'Decay',    bank: 'p0', index: 0, min: 0.05, max: 3,  curve: 'log', unit: 's' },
    { code: 'DMP', label: 'Damp',     bank: 'p0', index: 1, min: 0,    max: 1,  curve: 'lin' },
    { code: 'BND', label: 'Bend',     bank: 'p0', index: 3, min: -12,  max: 12, curve: 'lin', unit: 'st' },
    { code: 'BTM', label: 'BendTime', bank: 'p1', index: 2, min: 0.005, max: 0.4, curve: 'lin', unit: 's' },
    { code: 'TON', label: 'Tone',     bank: 'p1', index: 3, min: 0,    max: 1,  curve: 'lin' },
  ],
  presets: [
    { name: 'Dayan Na',        p0: [0.6, 0.0,  0.4, 0.0], p1: [7, 0.0006, 0.06, 0.55] },
    { name: 'Dayan Tin',       p0: [0.35, 0.1, 0.5, 0.0], p1: [8, 0.0010, 0.05, 0.70] },
    { name: 'Dayan Te (slap)', p0: [0.5, 0.85, 0.7, 0.0], p1: [6, 0.0008, 0.04, 0.50] },
    { name: 'Bayan Ge (bend)', p0: [0.7, 0.0,  0.45, 5.0], p1: [5, 0.0012, 0.09, 0.40] },
    { name: 'Bayan Ka (slap)', p0: [0.4, 0.9,  0.7, 0.0], p1: [4, 0.0015, 0.04, 0.35] },
    { name: 'Tabla Dha',       p0: [0.7, 0.0,  0.5, 0.0], p1: [8, 0.0006, 0.06, 0.60] },
  ],
};
