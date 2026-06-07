// Global LFOs — two song-wide, free-running modulation sources. Each maps a
// waveform onto any automation ParamTarget (inst / fx / chan / global), as a
// TRANSIENT offset layered ABOVE the param's current center (base or automation),
// never written into the instrument base. Evaluated per render block on the CPU
// (no shader); phase derives from song time so exports stay deterministic.
//
// Shapes 0–5 are closed-form (no dependency on the wavetable module loading);
// shape 6 "Wavetable" borrows a Wavewright bank (wtBank) at a fixed Position
// (wtPos) — the same shared CPU arrays the engine + scopes use. See MEMORY.md.
import type { LfoConfig } from '../types.js';
import { wtShape } from '../instruments/wavetables.js';

const TAU = Math.PI * 2;

export const LFO_COUNT = 2;
export const LFO_SHAPES = ['Sine', 'Triangle', 'Square', 'Saw', 'S&H', 'Ramp', 'Wavetable'];
export const LFO_SHAPE_WAVETABLE = 6;

export function defaultLfo(): LfoConfig {
  return {
    shape: 0, sync: true, rateBeats: 4, rateHz: 1, depth: 0, bipolar: true,
    targetParamId: -1, targetInstIdx: null, wtBank: 0, wtPos: 0,
  };
}
export function defaultLfos(): LfoConfig[] {
  return Array.from({ length: LFO_COUNT }, defaultLfo);
}

// Coerce a possibly-partial/legacy LFO record into a complete config (used by
// song load / migration so older or hand-edited files can't throw).
export function normalizeLfo(raw: Partial<LfoConfig> | undefined): LfoConfig {
  const d = defaultLfo();
  if (!raw) return d;
  return {
    shape: raw.shape ?? d.shape,
    sync: raw.sync ?? d.sync,
    rateBeats: raw.rateBeats ?? d.rateBeats,
    rateHz: raw.rateHz ?? d.rateHz,
    depth: raw.depth ?? d.depth,
    bipolar: raw.bipolar ?? d.bipolar,
    targetParamId: raw.targetParamId ?? d.targetParamId,
    targetInstIdx: raw.targetInstIdx ?? d.targetInstIdx,
    wtBank: raw.wtBank ?? d.wtBank,
    wtPos: raw.wtPos ?? d.wtPos,
  };
}

// Deterministic [0,1) hash for sample-&-hold (per-cycle stable value).
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Raw waveform value in [-1,1] for phase∈[0,1) and the integer cycle index
// (only S&H needs the cycle, to hold one random value per cycle).
function lfoWaveRaw(cfg: LfoConfig, phase: number, cycle: number): number {
  const p = phase - Math.floor(phase);
  switch (cfg.shape) {
    case 0: return Math.sin(TAU * p);                                  // sine
    case 1: return (2 / Math.PI) * Math.asin(Math.sin(TAU * p));       // triangle
    case 2: return p < 0.5 ? 1 : -1;                                   // square
    case 3: return 2 * p - 1;                                          // saw (rising)
    case 4: return hash01(cycle) * 2 - 1;                              // sample & hold
    case 5: return 1 - 2 * p;                                          // ramp (falling)
    case LFO_SHAPE_WAVETABLE: return wtShape(cfg.wtBank, cfg.wtPos, p);// wavetable bank
    default: return Math.sin(TAU * p);
  }
}

// The normalized offset to add to a target's center, in [-depth,depth] (bipolar)
// or [0,depth] (unipolar). Center + this is then clamped to [0,1] and denormed.
export function lfoOffset(cfg: LfoConfig, phase: number, cycle: number): number {
  let v = lfoWaveRaw(cfg, phase, cycle);
  if (!cfg.bipolar) v = v * 0.5 + 0.5;
  return v * cfg.depth;
}

// Cycle length in seconds at a given BPM (tempo-synced) or fixed Hz (free-run).
export function lfoPeriodSec(cfg: LfoConfig, bpm: number): number {
  return cfg.sync ? Math.max(1e-3, cfg.rateBeats) * 60 / Math.max(1, bpm)
    : 1 / Math.max(1e-3, cfg.rateHz);
}
