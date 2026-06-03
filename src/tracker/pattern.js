// Pattern = a rows×channels grid of cells. Stored as parallel typed arrays for
// compactness. One channel maps 1:1 to one synth voice.
import { VOICES } from '../constants.js';

export const EMPTY = -2;   // no note in this cell
export const OFF = -1;     // note-off / release command
// 0..127 = MIDI note number

export class Pattern {
  constructor(rows = 64, channels = VOICES) {
    this.rows = rows;
    this.channels = channels;
    const n = rows * channels;
    this.notes = new Int16Array(n).fill(EMPTY);
    this.inst = new Uint8Array(n);          // instrument index 0..3
    this.vol = new Float32Array(n).fill(1); // 0..1
  }
  idx(row, ch) { return row * this.channels + ch; }
  note(row, ch) { return this.notes[this.idx(row, ch)]; }
  set(row, ch, note, inst, vol = 1) {
    const i = this.idx(row, ch);
    this.notes[i] = note;
    if (inst !== undefined) this.inst[i] = inst;
    this.vol[i] = vol;
  }
  clear(row, ch) { this.notes[this.idx(row, ch)] = EMPTY; }

  // Grow or shrink the pattern to `newRows`, preserving existing cells (rows
  // beyond a shrink are dropped; new rows are empty).
  resize(newRows) {
    newRows = Math.max(1, Math.min(256, Math.round(newRows)));
    if (newRows === this.rows) return;
    const ch = this.channels, n = newRows * ch;
    const notes = new Int16Array(n).fill(EMPTY);
    const inst = new Uint8Array(n);
    const vol = new Float32Array(n).fill(1);
    const keep = Math.min(this.rows, newRows) * ch;
    notes.set(this.notes.subarray(0, keep));
    inst.set(this.inst.subarray(0, keep));
    vol.set(this.vol.subarray(0, keep));
    this.notes = notes; this.inst = inst; this.vol = vol; this.rows = newRows;
  }
}
