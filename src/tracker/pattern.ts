// Pattern = a rows×channels grid of cells. Stored as parallel typed arrays for
// compactness. One channel maps 1:1 to one synth voice.
import { VOICES } from '../constants.js';
import { targetById } from './automation.js';

export const EMPTY = -2;   // no note in this cell
export const OFF = -1;     // note-off / release command
// 0..127 = MIDI note number

export class Pattern {
  rows: number;
  channels: number;
  notes: Int16Array;       // EMPTY / OFF / 0..127 MIDI note
  inst: Int16Array;        // instrument-instance index
  vol: Float32Array;       // 0.0..1.0
  autoTracks: import('../types.js').AutoTrack[];

  constructor(rows = 64, channels = VOICES) {
    this.rows = rows;
    this.channels = channels;
    const n = rows * channels;
    this.notes = new Int16Array(n).fill(EMPTY);
    this.inst = new Int16Array(n).fill(0);
    this.vol = new Float32Array(n).fill(0.8);
    this.autoTracks = [];
  }
  idx(row: number, ch: number) { return row * this.channels + ch; }
  note(row: number, ch: number) { return this.notes[this.idx(row, ch)]; }
  set(row: number, ch: number, note: number, inst?: number, vol = 1) {
    const i = this.idx(row, ch);
    this.notes[i] = note;
    if (inst !== undefined) this.inst[i] = inst;
    this.vol[i] = vol;
  }
  clear(row: number, ch: number) { const i = this.idx(row, ch); this.notes[i] = EMPTY; }

  // Find or create an automation track for a parameter. The scope is derived from
  // the paramId (the param table is the single source of truth), so callers can't
  // desync scope from the parameter. `instIdx` meaning depends on that scope:
  //   inst/fx → instrument-instance index · chan → channel index · global → null.
  getOrCreateAutoTrack(instIdx: number | null, paramId: number) {
    const scope = targetById(paramId)?.scope ?? 'inst';
    let track = this.autoTracks.find(t => t.targetInstIdx === instIdx && t.targetParamId === paramId);
    if (!track) {
      track = { targetScope: scope, targetInstIdx: instIdx, targetParamId: paramId, data: new Int16Array(this.rows).fill(-1) };
      this.autoTracks.push(track);
    }
    return track.data;
  }

  // Grow or shrink the pattern to `newRows`, preserving existing cells (rows
  // beyond a shrink are dropped; new rows are empty).
  resize(newRows: number) {
    newRows = Math.max(1, Math.min(256, Math.round(newRows)));
    if (newRows === this.rows) return;
    const ch = this.channels, n = newRows * ch;
    const notes = new Int16Array(n).fill(EMPTY);
    const inst = new Int16Array(n).fill(0);
    const vol = new Float32Array(n).fill(0.8);
    
    const keep = Math.min(this.rows, newRows) * this.channels;
    notes.set(this.notes.subarray(0, keep));
    inst.set(this.inst.subarray(0, keep));
    vol.set(this.vol.subarray(0, keep));
    
    this.notes = notes; this.inst = inst; this.vol = vol; this.rows = newRows;
    for (const track of this.autoTracks) {
      const data = new Int16Array(newRows).fill(-1);
      data.set(track.data.subarray(0, Math.min(track.data.length, newRows)));
      track.data = data;
    }
  }
}
