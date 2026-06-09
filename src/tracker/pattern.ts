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
  fxCmd: Int16Array;       // effect command per cell (-1 = none; see fx.ts FX_CMDS)
  fxVal: Int16Array;       // effect value byte 0..255 (classic XY)
  autoTracks: import('../types.js').AutoTrack[];

  constructor(rows = 64, channels = VOICES) {
    this.rows = rows;
    this.channels = channels;
    const n = rows * channels;
    this.notes = new Int16Array(n).fill(EMPTY);
    this.inst = new Int16Array(n).fill(0);
    this.vol = new Float32Array(n).fill(0.8);
    this.fxCmd = new Int16Array(n).fill(-1);
    this.fxVal = new Int16Array(n).fill(0);
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
  // Set the per-cell effect command + value (cmd -1 clears it).
  setFx(row: number, ch: number, cmd: number, val = 0) {
    const i = this.idx(row, ch);
    this.fxCmd[i] = cmd;
    this.fxVal[i] = cmd < 0 ? 0 : (val & 0xff);
  }
  clear(row: number, ch: number) {
    const i = this.idx(row, ch);
    this.notes[i] = EMPTY;
    this.fxCmd[i] = -1; this.fxVal[i] = 0;
  }

  // Push all cells in `ch` from `row` downwards down by one step.
  insertStep(row: number, ch: number) {
    if (ch >= this.channels) {
      const tIdx = ch - this.channels;
      if (tIdx < this.autoTracks.length) {
        const track = this.autoTracks[tIdx].data;
        for (let r = this.rows - 1; r > row; r--) track[r] = track[r - 1];
        track[row] = -1;
      }
      return;
    }
    for (let r = this.rows - 1; r > row; r--) {
      const dst = this.idx(r, ch), src = this.idx(r - 1, ch);
      this.notes[dst] = this.notes[src];
      this.inst[dst] = this.inst[src];
      this.vol[dst] = this.vol[src];
      this.fxCmd[dst] = this.fxCmd[src];
      this.fxVal[dst] = this.fxVal[src];
    }
    this.clear(row, ch);
  }

  // Pull all cells in `ch` from `row+1` downwards up by one step.
  deleteStep(row: number, ch: number) {
    if (ch >= this.channels) {
      const tIdx = ch - this.channels;
      if (tIdx < this.autoTracks.length) {
        const track = this.autoTracks[tIdx].data;
        for (let r = row; r < this.rows - 1; r++) track[r] = track[r + 1];
        track[this.rows - 1] = -1;
      }
      return;
    }
    for (let r = row; r < this.rows - 1; r++) {
      const dst = this.idx(r, ch), src = this.idx(r + 1, ch);
      this.notes[dst] = this.notes[src];
      this.inst[dst] = this.inst[src];
      this.vol[dst] = this.vol[src];
      this.fxCmd[dst] = this.fxCmd[src];
      this.fxVal[dst] = this.fxVal[src];
    }
    this.clear(this.rows - 1, ch);
  }

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
    const fxCmd = new Int16Array(n).fill(-1);
    const fxVal = new Int16Array(n).fill(0);

    const keep = Math.min(this.rows, newRows) * this.channels;
    notes.set(this.notes.subarray(0, keep));
    inst.set(this.inst.subarray(0, keep));
    vol.set(this.vol.subarray(0, keep));
    fxCmd.set(this.fxCmd.subarray(0, keep));
    fxVal.set(this.fxVal.subarray(0, keep));

    this.notes = notes; this.inst = inst; this.vol = vol;
    this.fxCmd = fxCmd; this.fxVal = fxVal; this.rows = newRows;
    for (const track of this.autoTracks) {
      const data = new Int16Array(newRows).fill(-1);
      data.set(track.data.subarray(0, Math.min(track.data.length, newRows)));
      track.data = data;
    }
  }
}
