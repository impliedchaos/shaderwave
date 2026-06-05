// Pattern = a rows×channels grid of cells. Stored as parallel typed arrays for
// compactness. One channel maps 1:1 to one synth voice.
import { VOICES } from '../constants.js';

export const EMPTY = -2;   // no note in this cell
export const OFF = -1;     // note-off / release command
// 0..127 = MIDI note number

export const NO_FX = -1;   // fxCmd sentinel: cell carries no automation command

export class Pattern {
  rows: number;
  channels: number;
  notes: Int16Array;       // EMPTY / OFF / 0..127 MIDI note
  inst: Uint8Array;        // instrument index 0..3
  vol: Float32Array;       // 0..1
  fxCmd: Int16Array;       // ParamTarget id or NO_FX
  fxVal: Uint8Array;       // normalized value byte 0..255

  constructor(rows = 64, channels = VOICES) {
    this.rows = rows;
    this.channels = channels;
    const n = rows * channels;
    this.notes = new Int16Array(n).fill(EMPTY);
    this.inst = new Uint8Array(n);          // instrument index 0..3
    this.vol = new Float32Array(n).fill(1); // 0..1
    // Automation column: one effect command per cell. fxCmd = a ParamTarget id
    // (see automation.js) or NO_FX; fxVal = normalized value byte 0..255. Kept as
    // parallel arrays so it serialises/copies just like notes/inst/vol.
    this.fxCmd = new Int16Array(n).fill(NO_FX);
    this.fxVal = new Uint8Array(n);
  }
  idx(row: number, ch: number) { return row * this.channels + ch; }
  note(row: number, ch: number) { return this.notes[this.idx(row, ch)]; }
  set(row: number, ch: number, note: number, inst?: number, vol = 1) {
    const i = this.idx(row, ch);
    this.notes[i] = note;
    if (inst !== undefined) this.inst[i] = inst;
    this.vol[i] = vol;
  }
  clear(row: number, ch: number) { this.notes[this.idx(row, ch)] = EMPTY; }

  // Automation command on a cell (independent of the note). targetId = NO_FX
  // clears it. Used by the editor, the demo songs, and (later) MIDI-CC recording.
  setFx(row: number, ch: number, targetId: number, val = 0) {
    const i = this.idx(row, ch);
    this.fxCmd[i] = targetId;
    this.fxVal[i] = Math.max(0, Math.min(255, val)) & 0xff;
  }
  clearFx(row: number, ch: number) { const i = this.idx(row, ch); this.fxCmd[i] = NO_FX; this.fxVal[i] = 0; }
  hasFx(row: number, ch: number) { return this.fxCmd[this.idx(row, ch)] !== NO_FX; }

  // Grow or shrink the pattern to `newRows`, preserving existing cells (rows
  // beyond a shrink are dropped; new rows are empty).
  resize(newRows: number) {
    newRows = Math.max(1, Math.min(256, Math.round(newRows)));
    if (newRows === this.rows) return;
    const ch = this.channels, n = newRows * ch;
    const notes = new Int16Array(n).fill(EMPTY);
    const inst = new Uint8Array(n);
    const vol = new Float32Array(n).fill(1);
    const fxCmd = new Int16Array(n).fill(NO_FX);
    const fxVal = new Uint8Array(n);
    const keep = Math.min(this.rows, newRows) * ch;
    notes.set(this.notes.subarray(0, keep));
    inst.set(this.inst.subarray(0, keep));
    vol.set(this.vol.subarray(0, keep));
    fxCmd.set(this.fxCmd.subarray(0, keep));
    fxVal.set(this.fxVal.subarray(0, keep));
    this.notes = notes; this.inst = inst; this.vol = vol;
    this.fxCmd = fxCmd; this.fxVal = fxVal; this.rows = newRows;
  }
}
