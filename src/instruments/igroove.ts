// Locked Groove — short name "GRV". A vinyl-noise texture: surface hiss, random
// crackle, dust pops, motor rumble, plus a rotation-locked defect layer that
// recurs every platter revolution (33⅓ RPM → 1.8 s), migrating and breathing so
// the ticks read as a real spinning record rather than a metronome. Closed-form,
// so it fits the universal p0..p3 banks with no engine-specific plumbing. Play it
// as a drone (one long note); pitch is ignored, velocity sets the level.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-groove.glsl?raw';

export const igroove: InstrumentDef = {
  type: 'groove',
  name: 'Locked Groove',
  short: 'GRV',
  label: 'Locked Groove — Vinyl Noise',
  blurb: 'Vinyl record-noise texture — surface hiss, random crackle, dust pops, motor rumble, and a rotation-locked defect layer recurring every revolution (33⅓ RPM = 1.8 s, also 45/78). Hiss, Crackle, Pop, Wear, Cycle (random↔rotation-locked), Tone, Rumble, Drift, RPM, Defects, Color, Fade. Play as a drone.',
  shader,
  // p0=(hiss,crackle,pop,wear) p1=(cycle,tone,rumble,drift) p2=(rpm,defects,color,fade s)
  // Defaults tuned by matching statistics of real CC0 vinyl recordings (see
  // test/vinyl-analyze.html): ~18 clicks/s, dark low-tilted spectrum, 1.8s tick.
  defaults: { p0: [0.25, 0.5, 0.5, 0.5], p1: [0.45, 0.4, 0.32, 0.4], p2: [33.333, 6, 0.5, 0.03], p3: [0.35, 2, 0, 0] },
  paramDefs: [
    { label: 'Hiss',    bank: 'p0', i: 0, min: 0,  max: 1, step: 0.01 },
    { label: 'Crackle', bank: 'p0', i: 1, min: 0,  max: 1, step: 0.01 },
    { label: 'Pop',     bank: 'p0', i: 2, min: 0,  max: 1, step: 0.01 },
    { label: 'Wear',    bank: 'p0', i: 3, min: 0,  max: 1, step: 0.01 },
    { label: 'Cycle',   bank: 'p1', i: 0, min: 0,  max: 1, step: 0.01 },
    { label: 'Tone',    bank: 'p1', i: 1, min: 0,  max: 1, step: 0.01 },
    { label: 'Rumble',  bank: 'p1', i: 2, min: 0,  max: 1, step: 0.01 },
    { label: 'Drift',   bank: 'p1', i: 3, min: 0,  max: 1, step: 0.01 },
    { label: 'RPM',     bank: 'p2', i: 0, min: 30, max: 80, step: 0.001 },
    { label: 'Defects', bank: 'p2', i: 1, min: 0,  max: 8, step: 1 },
    { label: 'Color',   bank: 'p2', i: 2, min: 0,  max: 1, step: 0.01 },
    { label: 'Fade',    bank: 'p2', i: 3, min: 0.003, max: 0.5, step: 0.005 },
    { label: 'HissMod', bank: 'p3', i: 0, min: 0,  max: 1, step: 0.01 },
    { label: 'ModRate', bank: 'p3', i: 1, min: 0.25, max: 8, step: 0.25 },
  ],
  autoTargets: [
    { code: 'HSS', label: 'Hiss',    bank: 'p0', index: 0, min: 0, max: 1, curve: 'lin' },
    { code: 'CRK', label: 'Crackle', bank: 'p0', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'POP', label: 'Pop',     bank: 'p0', index: 2, min: 0, max: 1, curve: 'lin' },
    { code: 'WER', label: 'Wear',    bank: 'p0', index: 3, min: 0, max: 1, curve: 'lin' },
    { code: 'CYC', label: 'Cycle',   bank: 'p1', index: 0, min: 0, max: 1, curve: 'lin' },
    { code: 'TON', label: 'Tone',    bank: 'p1', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'RBL', label: 'Rumble',  bank: 'p1', index: 2, min: 0, max: 1, curve: 'lin' },
  ],
  presets: [
    { name: 'Dusty 33',       p0: [0.25, 0.5,  0.5,  0.5],  p1: [0.45, 0.4,  0.32, 0.4], p2: [33.333, 6, 0.5,  0.03], p3: [0.4,  2,   0, 0] },
    { name: 'Sparse Crackle', p0: [0.2,  0.2,  0.3,  0.25], p1: [0.3,  0.45, 0.2,  0.3], p2: [33.333, 3, 0.45, 0.04], p3: [0.3,  1.5, 0, 0] },
    { name: 'Heavy Wear',     p0: [0.3,  0.8,  0.8,  0.85], p1: [0.55, 0.45, 0.4,  0.5], p2: [33.333, 8, 0.55, 0.03], p3: [0.5,  3,   0, 0] },
    { name: '78 Shellac',     p0: [0.4,  0.85, 0.7,  0.7],  p1: [0.5,  0.6,  0.3,  0.5], p2: [78, 7, 0.65, 0.03],     p3: [0.45, 4,   0, 0] },
    { name: 'Deep Rumble',    p0: [0.28, 0.35, 0.45, 0.4],  p1: [0.4,  0.35, 0.85, 0.4], p2: [33.333, 5, 0.4,  0.04], p3: [0.6,  1,   0, 0] },
    { name: 'Locked Tick',    p0: [0.12, 0.18, 0.85, 0.6],  p1: [0.85, 0.4,  0.15, 0.2], p2: [33.333, 3, 0.5,  0.03], p3: [0.3,  1,   0, 0] },
  ],
};
