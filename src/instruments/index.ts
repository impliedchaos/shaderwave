// The instrument registry — the single source of truth for which GPU synth
// engines exist. Every per-engine table in the app (param banks, presets,
// automation targets, defaults, sidebar knobs, help) derives from this array.
//
// To craft a new instrument: add a descriptor file + its .glsl shader, then add
// one entry here. To remove one: delete its entry (songs referencing it fall
// back gracefully — see loadSongInstruments). Order is the engine-id order
// (INSTRUMENTS index == the shader-dispatch id uInst); append new engines at the
// END so existing songs' stored instrument-type ids keep resolving.
//
// Descriptors deliberately import nothing from constants/engine/ui to keep this
// module free of import cycles (constants.ts re-exports INSTRUMENTS from here).
import type { InstrumentDef } from '../types.js';
import { i303 } from './i303.js';
import { idx7 } from './idx7.js';
import { i808 } from './i808.js';
import { imoog } from './imoog.js';
import { itanpura } from './itanpura.js';
import { ie8e } from './ie8e.js';

export const REGISTRY: InstrumentDef[] = [i303, idx7, i808, imoog, itanpura, ie8e];

// Engine-type ids, in registry order. The index is the shader-dispatch id.
export const INSTRUMENTS: string[] = REGISTRY.map((d) => d.type);

export function byType(type: string): InstrumentDef | undefined {
  return REGISTRY.find((d) => d.type === type);
}
