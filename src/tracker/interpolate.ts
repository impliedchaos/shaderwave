// Linear interpolation across a box selection in the tracker grid. Pure (no UI/GL):
// operates on a Pattern + selection bounds + the cursor's sub-column, so it's unit-
// testable. The UI wrapper (src/ui/input.ts) handles selection/markDirty/redraw.
//
// Per selected column, find the first and last "defined" rows within the selection and
// linearly fill between them. What's "defined" and what's filled depends on the column:
//   - automation track : data[r] >= 0          → fill every row in the span (0..255 byte)
//   - note · fx  (col 3): fxCmd[idx] != -1      → fill every row (fxVal byte + the first
//                                                  endpoint's command)
//   - note · vol (col 2): row has a note        → fill only note rows (0..1 float)
// A column with fewer than 2 defined rows is skipped (nothing to ramp between).
import { Pattern, EMPTY, OFF } from './pattern.js';

export interface Sel { r0: number; c0: number; r1: number; c1: number }

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hasNote = (n: number) => n !== EMPTY && n !== OFF;

// A per-column field view the engine of this module drives uniformly.
interface Field {
  // value at row r, or null if that row isn't "defined" for this field
  read(r: number): number | null;
  // write the interpolated value v at row r
  write(r: number, v: number): void;
  // only fill rows that satisfy this (auto/fx: always; vol: note rows only)
  fillable(r: number): boolean;
}

// Resolve the Field for a selected column, or null if it isn't interpolatable
// (e.g. a note channel with the cursor on the note/inst sub-column).
function fieldFor(p: Pattern, ch: number, col: number): Field | null {
  if (ch >= p.channels) {
    const t = ch - p.channels;
    if (t >= p.autoTracks.length) return null;
    const data = p.autoTracks[t].data;
    return {
      read: (r) => (data[r] >= 0 ? data[r] : null),
      write: (r, v) => { data[r] = clampByte(v); },
      fillable: () => true,
    };
  }
  if (col === 3) {   // effect value (+ command)
    let cmd = -1;    // first endpoint's command, captured on the first read hit
    return {
      read: (r) => {
        const i = p.idx(r, ch);
        if (p.fxCmd[i] === -1) return null;
        if (cmd === -1) cmd = p.fxCmd[i];
        return p.fxVal[i];
      },
      write: (r, v) => { const i = p.idx(r, ch); p.fxCmd[i] = cmd; p.fxVal[i] = clampByte(v); },
      fillable: () => true,
    };
  }
  if (col === 2) {   // volume (only where a note exists)
    return {
      read: (r) => (hasNote(p.notes[p.idx(r, ch)]) ? p.vol[p.idx(r, ch)] : null),
      write: (r, v) => { p.vol[p.idx(r, ch)] = Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4; },
      fillable: (r) => hasNote(p.notes[p.idx(r, ch)]),
    };
  }
  return null;   // note / instrument columns aren't interpolatable
}

// First & last defined rows for a field within [r0,r1] (calls read on each).
function endpoints(f: Field, r0: number, r1: number): { rFirst: number; rLast: number; vFirst: number; vLast: number } | null {
  let rFirst = -1, rLast = -1, vFirst = 0, vLast = 0;
  for (let r = r0; r <= r1; r++) {
    const v = f.read(r);
    if (v === null) continue;
    if (rFirst === -1) { rFirst = r; vFirst = v; }
    rLast = r; vLast = v;
  }
  return rFirst !== -1 && rLast > rFirst ? { rFirst, rLast, vFirst, vLast } : null;
}

// True iff the selection spans ≥2 rows AND some selected column has ≥2 defined rows.
export function canInterpolate(p: Pattern, sel: Sel | null, col: number): boolean {
  if (!sel || sel.r1 - sel.r0 < 1) return false;
  for (let ch = sel.c0; ch <= sel.c1; ch++) {
    const f = fieldFor(p, ch, col);
    if (f && endpoints(f, sel.r0, sel.r1)) return true;
  }
  return false;
}

// Fill each interpolatable column. Returns whether anything changed.
export function interpolate(p: Pattern, sel: Sel | null, col: number): boolean {
  if (!sel || sel.r1 - sel.r0 < 1) return false;
  let changed = false;
  for (let ch = sel.c0; ch <= sel.c1; ch++) {
    const f = fieldFor(p, ch, col);
    if (!f) continue;
    const e = endpoints(f, sel.r0, sel.r1);
    if (!e) continue;
    for (let r = e.rFirst; r <= e.rLast; r++) {
      if (!f.fillable(r)) continue;
      const t = (r - e.rFirst) / (e.rLast - e.rFirst);
      f.write(r, e.vFirst + (e.vLast - e.vFirst) * t);
    }
    changed = true;
  }
  return changed;
}
