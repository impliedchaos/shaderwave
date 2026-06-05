// Shared constants across audio + GL + tracker.
import type { InstrumentType } from './types.js';

export const BLOCK = 512;        // samples rendered per GPU pass (per channel)
export const VOICES = 8;         // simultaneous voices per instrument
export const CHANNELS = 2;       // stereo, interleaved per frame
export const DEFAULT_MASTER = 0.5;   // global output gain, baked into the render (→ affects recording); per-song, reset on New Song

// Audio is handed to the worklet as transferable stereo blocks via postMessage
// (no SharedArrayBuffer → no cross-origin-isolation headers → any static host).
// The main thread keeps this many blocks queued ahead of playback. This is the
// default; it's adjustable at runtime via the buffer control in the status bar.
export const PREBUFFER_BLOCKS = 16;

// Instrument identifiers — also used as the synth shader program keys.
export const INSTRUMENTS: InstrumentType[] = ['303', 'dx7', '808', 'moog'];

// Per-instance accent colours. The first four match the engine-type accents
// (303/dx7/808/moog order); later entries distinguish additional instances
// (e.g. a 2nd DX7) in the tracker grid and the sidebar list.
export const INSTRUMENT_COLORS = [
  '#39ff14', '#00f0ff', '#ff007f', '#ffb700',
  '#ff6a00', '#b14dff', '#00ffa3', '#ffe600',
  '#ff4d6d', '#4d8bff', '#7cfc00', '#ff9cf0',
];

// Hex colour → rgba() string for glow/shadow tints.
export function instGlow(hex: string, a = 0.2): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// MIDI note 69 = A4 = 440Hz.
export const A4 = 440;
export function noteToFreq(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}
