// Shared constants across audio + GL + tracker.

export const BLOCK = 512;        // samples rendered per GPU pass (per channel)
export const VOICES = 8;         // simultaneous voices per instrument
export const CHANNELS = 2;       // stereo, interleaved per frame

// Audio is handed to the worklet as transferable stereo blocks via postMessage
// (no SharedArrayBuffer → no cross-origin-isolation headers → any static host).
// The main thread keeps this many blocks queued ahead of playback.
export const PREBUFFER_BLOCKS = 10;

// Instrument identifiers — also used as the synth shader program keys.
export const INSTRUMENTS = ['303', 'dx7', '808', 'moog'];

// MIDI note 69 = A4 = 440Hz.
export const A4 = 440;
export function noteToFreq(midi) {
  return A4 * Math.pow(2, (midi - 69) / 12);
}
