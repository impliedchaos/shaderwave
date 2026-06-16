// Keyboard input, clipboard, cursor — extracted from main.ts.
import type { App } from '../main.js';
import { EMPTY, OFF } from '../tracker/pattern.js';
import { fxByKey } from '../tracker/fx.js';
import { byType } from '../instruments/index.js';
import { recordNoteAtPlayhead } from './record.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// One copied tracker cell.
// A copied cell is either a note cell (note/inst/vol) or an automation-track
// cell (`auto` = the row's Int16 value). `auto === undefined` discriminates.
export type ClipCell = { note: number; inst: number; vol: number; fxCmd?: number; fxVal?: number; auto?: number };

// Lower keyboard row → semitone offset within the current octave.
const KEY_SEMI: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
};
// For 808, keys select drum slots rather than pitches.
const DRUM_KEYS = [36, 38, 42, 46, 39, 41, 45, 48, 56];

export function bindKeys(app: App) {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    // Copy / cut / paste of a selected block (intercept before note entry,
    // since C/X/V are also piano keys).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      // Undo/redo (intercept before note entry — Z is also a piano key).
      if (e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) app._redo(); else app._undo(); return; }
      if (e.code === 'KeyY') { e.preventDefault(); app._redo(); return; }
      if (e.code === 'KeyC') { e.preventDefault(); copyBlock(app, false); return; }
      if (e.code === 'KeyX') { e.preventDefault(); copyBlock(app, true); return; }
      if (e.code === 'KeyV') { e.preventDefault(); pasteBlock(app); return; }
      if (e.code === 'KeyA') {
        e.preventDefault();
        const p = app.view.pattern;
        if (p) {
          app.view.selection = {
            r0: 0, r1: p.rows - 1,
            c0: 0, c1: p.channels - 1
          };
          app.view.draw();
        }
        return;
      }
    }
    if (e.code === 'Escape') { app.view.selection = null; return; }
    if (e.code === 'Space') { e.preventDefault(); return togglePlay(app); }
    if (e.code === 'BracketLeft') {
      e.preventDefault();
      const input = $<HTMLInputElement>('octave');
      input.value = String(Math.max(+input.min || 0, Math.min(+input.max || 8, (+input.value || 4) - 1)));
      return;
    }
    if (e.code === 'BracketRight') {
      e.preventDefault();
      const input = $<HTMLInputElement>('octave');
      input.value = String(Math.max(+input.min || 0, Math.min(+input.max || 8, (+input.value || 4) + 1)));
      return;
    }
    if (handleCursor(app, e)) { e.preventDefault(); return; }
    if (handleAutoTrackEdit(app, e)) return;
    if (handleEdit(app, e)) return;
    if (handleFxEdit(app, e)) return;

    if (e.repeat) return;
    if (app.view.cursor.ch >= app.view.pattern.channels) return; // No note entry in AutoTracks
    if (app.view.cursor.col === 3) return;                        // effect column: no note entry

    const note = keyToNote(app, e.code);
    if (note == null) return;
    e.preventDefault();

    const inst = app.controls.selected;
    // While recording-and-playing, notes land at the playhead (and we DON'T move
    // the edit cursor — the playhead is the write head). Otherwise write at the
    // cursor and step it, the normal step-entry behaviour.
    if (app._recordEnabled && app.engine.playing) {
      recordNoteAtPlayhead(app, note, inst, 0.9);
    } else {
      const p = app.view.pattern;
      const { row, ch } = app.view.cursor;
      p.set(row, ch, note, inst, 0.9);
      app.markDirty('note');
      advanceCursorRow(app);
    }

    app.ensureAudio().then(() => {
      const v = app.engine.previewNote(inst, note, 0.9);
      app.held.set(e.code, v);
    });
  });

  document.addEventListener('keyup', (e) => {
    if (app.held.has(e.code)) { app.engine.previewOff(app.held.get(e.code)!); app.held.delete(e.code); }
  });
}

export function keyToNote(app: App, code: string): number | null {
  // No instrument selected (e.g. a freshly created blank song) → nothing to play.
  const sel = app.engine.instruments[app.controls.selected];
  if (!sel) return null;
  if (byType(sel.type)?.drum) {
    const semi = KEY_SEMI[code];
    return semi == null ? null : (DRUM_KEYS[semi] ?? null);
  }
  const semi = KEY_SEMI[code];
  if (semi == null) return null;
  const oct = Math.max(0, Math.min(8, +$<HTMLInputElement>('octave').value || 4));
  return (oct + 1) * 12 + semi;
}

export function handleCursor(app: App, e: KeyboardEvent) {
  const c = app.view.cursor, p = app.view.pattern;
  // Shift+Up/Down: fine nudge of the note's volume (±5%).
  if (e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    const idx = p.idx(c.row, c.ch);
    if (p.notes[idx] >= 0) {
      const d = e.code === 'ArrowUp' ? 0.05 : -0.05;
      p.vol[idx] = Math.min(1.0, Math.max(0.0, p.vol[idx] + d));
      app.markDirty('volnudge', true);
    }
    return true;
  }
  switch (e.code) {
    case 'ArrowUp': c.row = (c.row - 1 + p.rows) % p.rows; app.view.revealCursor(); app._digitEntry = null; app._hexEntry = null; return true;
    case 'ArrowDown': c.row = (c.row + 1) % p.rows; app.view.revealCursor(); app._digitEntry = null; app._hexEntry = null; return true;
    case 'PageUp': c.row = Math.max(0, c.row - app.view._viewRows()); app.view.revealCursor(); app._digitEntry = null; app._hexEntry = null; return true;
    case 'PageDown': c.row = Math.min(p.rows - 1, c.row + app.view._viewRows()); app.view.revealCursor(); app._digitEntry = null; app._hexEntry = null; return true;
    case 'Home': c.row = 0; app.view.revealCursor(); app._digitEntry = null; app._hexEntry = null; return true;
    case 'End': c.row = p.rows - 1; app.view.revealCursor(); app._digitEntry = null; app._hexEntry = null; return true;
    // Left/Right step through the note → instrument → volume sub-columns,
    // wrapping to the adjacent channel at the ends.
    case 'ArrowLeft':
      if (c.ch >= p.channels) {
        if (c.ch > p.channels) c.ch--;
        else { c.ch = p.channels - 1; c.col = app.view.maxCol; }
      } else {
        if (c.col > 0) c.col--; else {
          if (c.ch > 0) { c.ch--; c.col = app.view.maxCol; }
          else { c.ch = p.channels + p.autoTracks.length - 1; c.col = c.ch >= p.channels ? 0 : app.view.maxCol; }
        }
      }
      app._digitEntry = null; app._hexEntry = null; return true;
    case 'ArrowRight':
      if (c.ch >= p.channels) {
        if (c.ch < p.channels + p.autoTracks.length - 1) c.ch++;
        else { c.ch = 0; c.col = 0; }
      } else {
        if (c.col < app.view.maxCol) c.col++; else {
          c.ch++; c.col = 0;
        }
      }
      app._digitEntry = null; app._hexEntry = null; return true;
    case 'Insert':
      p.insertStep(c.row, c.ch);
      app.markDirty('insert');
      return true;
    case 'Delete':
    case 'Backspace':
      if (app.view.selection) {
        const s = app.view.selection;
        for (let r = s.r0; r <= s.r1; r++) {
          for (let ch = s.c0; ch <= s.c1; ch++) {
            if (ch >= p.channels) {
              const tIdx = ch - p.channels;
              if (tIdx < p.autoTracks.length) p.autoTracks[tIdx].data[r] = -1;
            } else {
              p.clear(r, ch);
            }
          }
        }
        app.view.draw();
      } else if (c.ch >= p.channels) {
        const tIdx = c.ch - p.channels;
        if (tIdx < p.autoTracks.length) {
          if (p.autoTracks[tIdx].data[c.row] === -1) {
            p.deleteStep(c.row, c.ch);
          } else {
            p.autoTracks[tIdx].data[c.row] = -1;
            advanceCursorRow(app);
          }
        }
      } else if (c.col === 3) {
        const idx = p.idx(c.row, c.ch);
        if (p.fxCmd[idx] === -1) {
          p.deleteStep(c.row, c.ch);
        } else {
          p.setFx(c.row, c.ch, -1, 0);   // effect column: clear just the effect
          advanceCursorRow(app);
        }
      } else {
        if (p.note(c.row, c.ch) === EMPTY) {
          p.deleteStep(c.row, c.ch);
        } else {
          p.clear(c.row, c.ch);
          advanceCursorRow(app);
        }
      }
      app.markDirty('clear');
      return true;
    case 'Equal': p.set(c.row, c.ch, OFF, app.controls.selected); app.markDirty('note'); advanceCursorRow(app); return true;
    default: return false;
  }
}

export function handleAutoTrackEdit(app: App, e: KeyboardEvent) {
  const c = app.view.cursor, p = app.view.pattern;
  if (c.ch < p.channels) return false;
  
  const isDigit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  const isLetter = /^Key([A-Z])$/.exec(e.code);
  if (!isDigit && !isLetter) return false;
  
  e.preventDefault();
  const tIdx = c.ch - p.channels;
  if (tIdx >= p.autoTracks.length) return true;
  
  let nyb = null;
  if (isDigit) nyb = parseInt(isDigit[1], 10);
  else if (isLetter && isLetter[1] <= 'F') nyb = parseInt(isLetter[1], 16);
  if (nyb === null) return true;
  
  const track = p.autoTracks[tIdx];
  const same = app._hexEntry && app._hexEntry.ch === c.ch && app._hexEntry.row === c.row;
  
  track.data[c.row] = (same ? ((app._hexEntry!.first << 4) | nyb) : nyb) & 0xff;
  app._hexEntry = same ? null : { ch: c.ch, row: c.row, first: nyb };
  app.markDirty('autocell', true);

  // Automatically advance cursor on second digit
  if (same) advanceCursorRow(app);
  return true;
}

// Digit keys edit the instrument (col 1) or volume (col 2) of the note under
// the cursor, two-digit accumulation per field (e.g. "2" then "5" → 25).
export function handleEdit(app: App, e: KeyboardEvent) {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (!m) return false;
  const c = app.view.cursor;
  if (c.col !== 1 && c.col !== 2) return false;  // only instrument / volume here
  e.preventDefault();
  const p = app.view.pattern;
  const idx = p.idx(c.row, c.ch);
  if (p.notes[idx] < 0) return true;             // no real note here — nothing to edit
  const d = +m[1];
  const same = app._digitEntry && app._digitEntry.idx === idx && app._digitEntry.col === c.col;
  const val = same ? app._digitEntry!.first * 10 + d : d;
  app._digitEntry = same ? null : { idx, col: c.col, first: d };
  if (c.col === 1) p.inst[idx] = Math.min(val, app.engine.instruments.length - 1);
  else p.vol[idx] = Math.min(99, val) / 99;
  app.markDirty('editval', true);
  return true;
}

// Effect column (cursor col 3): a command key (0-4, A — see fx.ts) sets the
// command and arms a 2-nibble hex value; the next two hex digits fill the value
// byte and auto-advance the row, mirroring inst/vol and the auto-track entry.
export function handleFxEdit(app: App, e: KeyboardEvent): boolean {
  const c = app.view.cursor, p = app.view.pattern;
  if (c.col !== 3 || c.ch >= p.channels) return false;
  const idx = p.idx(c.row, c.ch);
  const armed = !!app._hexEntry && app._hexEntry.col === 3
    && app._hexEntry.ch === c.ch && app._hexEntry.row === c.row;

  if (!armed) {
    // Expect a command key; swallow anything else so col 3 never types a note.
    const ch = keyChar(e.code);
    if (ch === null) return false;
    const def = fxByKey(ch);
    e.preventDefault();
    if (def) {
      p.setFx(c.row, c.ch, def.code, 0);
      app.markDirty('fx', true);
      app._hexEntry = { col: 3, ch: c.ch, row: c.row, first: -1 };  // awaiting value
    }
    return true;
  }

  // Armed: consume two hex nibbles into the value byte.
  const nyb = keyHex(e.code);
  if (nyb === null) { e.preventDefault(); return true; }   // ignore non-hex while armed
  e.preventDefault();
  if (app._hexEntry!.first < 0) {
    p.fxVal[idx] = nyb;                                     // first (high) nibble
    app._hexEntry!.first = nyb;
  } else {
    p.fxVal[idx] = ((app._hexEntry!.first << 4) | nyb) & 0xff;
    app._hexEntry = null;
    advanceCursorRow(app);
  }
  app.markDirty('fx', true);
  return true;
}

// A single upper-case char for a Digit/Key code (else null).
function keyChar(code: string): string | null {
  const d = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (d) return d[1];
  const k = /^Key([A-Z])$/.exec(code);
  return k ? k[1] : null;
}
// A 0..15 hex nibble from a digit/A–F key (else null).
function keyHex(code: string): number | null {
  const ch = keyChar(code);
  if (ch === null) return null;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'F') return ch.charCodeAt(0) - 55;
  return null;
}

export function closeFxPicker(app: App) {
  if (app._fxPicker) { app._fxPicker.remove(); app._fxPicker = null; }
}

export function advanceCursorRow(app: App) {
  const p = app.view.pattern;
  app.view.cursor.row = (app.view.cursor.row + 1) % p.rows;
  app.view.revealCursor();
  app._digitEntry = null;
}

// Copy the selected block (or the single cursor cell) into the clipboard.
// `cut` also clears the source cells.
export function copyBlock(app: App, cut: boolean) {
  const p = app.view.pattern, s = app.view.selection, c = app.view.cursor;
  const r0 = s ? s.r0 : c.row, r1 = s ? s.r1 : c.row;
  const c0 = s ? s.c0 : c.ch,  c1 = s ? s.c1 : c.ch;
  const cells: ClipCell[][] = [];
  for (let r = r0; r <= r1; r++) {
    const rowCells: ClipCell[] = [];
    for (let ch = c0; ch <= c1; ch++) {
      if (ch >= p.channels) {                          // automation-track column
        const tIdx = ch - p.channels;
        const has = tIdx < p.autoTracks.length;
        rowCells.push({ note: EMPTY, inst: 0, vol: 0, auto: has ? p.autoTracks[tIdx].data[r] : -1 });
        if (cut && has) p.autoTracks[tIdx].data[r] = -1;
      } else {
        const i = p.idx(r, ch);
        rowCells.push({ note: p.notes[i], inst: p.inst[i], vol: p.vol[i], fxCmd: p.fxCmd[i], fxVal: p.fxVal[i] });
        if (cut) p.clear(r, ch);
      }
    }
    cells.push(rowCells);
  }
  app._clipboard = { rows: r1 - r0 + 1, chans: c1 - c0 + 1, cells };
  if (cut) { app.markDirty('cut'); app.view.draw(); }
}

// Paste the clipboard block with its top-left at the cursor, clipped to bounds.
export function pasteBlock(app: App) {
  const cb = app._clipboard;
  if (!cb) return;
  const p = app.view.pattern, c = app.view.cursor;
  for (let dr = 0; dr < cb.rows; dr++) {
    const r = c.row + dr;
    if (r >= p.rows) break;
    for (let dc = 0; dc < cb.chans; dc++) {
      const ch = c.ch + dc;
      if (ch >= p.channels + p.autoTracks.length) break;
      const cell = cb.cells[dr][dc];
      if (ch >= p.channels) {                          // pasting into a track column
        const tIdx = ch - p.channels;
        if (cell.auto !== undefined && tIdx < p.autoTracks.length) p.autoTracks[tIdx].data[r] = cell.auto;
      } else if (cell.auto === undefined) {            // note cell into a note column
        const i = p.idx(r, ch);
        p.notes[i] = cell.note; p.inst[i] = cell.inst; p.vol[i] = cell.vol;
        p.fxCmd[i] = cell.fxCmd ?? -1; p.fxVal[i] = cell.fxVal ?? 0;
      }
    }
  }
  app.markDirty('paste');
  app.view.draw();
}

export async function togglePlay(app: App) {
  await app.ensureAudio();
  if (app.engine.playing) app.engine.stop(); else app.engine.play();
}
