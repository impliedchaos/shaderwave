// Live recording — shared by the computer keyboard (input.ts), MIDI (midi.ts),
// and the parameter knobs (controls.ts / fx-panel.ts).
//
// Everything lands at the PLAYHEAD: `view.pattern` already resolves the pattern
// the transport is on (song mode → order[displayOrder], else currentPatternIdx)
// and `displayRow` is the local row within it, so we write there while playing
// and at the edit cursor when stopped. Recording only happens when the record
// button is armed (`app._recordEnabled`).
import type { App } from '../main.js';
import type { ParamTarget } from '../types.js';
import type { Pattern } from '../tracker/pattern.js';
import { targetsForType, normByte } from '../tracker/automation.js';

// A MIDI CC arm (no explicit "release") lingers this long after the last message
// so its track stays suppressed between messages. A KNOB arm is "held" — it uses
// _armUntil = Infinity and only clears on pointer-up via disarmRecord(), so it
// never expires mid-gesture (which would let the old track fight the user).
const ARM_LINGER_MS = 300;

// The pattern + row a live event should land on, or null if out of range.
function playheadCell(app: App): { p: Pattern; row: number } | null {
  const p = app.view.pattern;
  if (!p) return null;
  const row = app.engine.playing ? app.engine.displayRow : app.view.cursor.row;
  return (row >= 0 && row < p.rows) ? { p, row } : null;
}

// The track's targetInstIdx for a target: global → null, chan → the cursor
// channel it pans, inst/fx → the selected instrument instance.
function trackInstFor(app: App, t: ParamTarget, instIdx: number): number | null {
  return t.scope === 'global' ? null : t.scope === 'chan' ? app.view.cursor.ch : instIdx;
}

// Write a note at the playhead on the cursor's channel. Returns true if it
// landed (false when the cursor sits on an automation column).
export function recordNoteAtPlayhead(app: App, note: number, instIdx: number, vol: number): boolean {
  const cell = playheadCell(app);
  if (!cell || app.view.cursor.ch >= cell.p.channels) return false;
  cell.p.set(cell.row, app.view.cursor.ch, note, instIdx, vol);
  app.markDirty('note');
  app.view.draw();
  return true;
}

// Write a normalized byte (0..255) to a target's automation track at the
// playhead, creating the track if absent. Shared by knobs + MIDI CC. Remembers
// the byte so tickRecord() can latch it forward across the rows the playhead
// crosses (so a continuous gesture fills the track without gaps).
export function recordParamByte(app: App, t: ParamTarget, instIdx: number, val255: number): void {
  const cell = playheadCell(app);
  if (!cell) return;
  const before = cell.p.autoTracks.length;
  const data = cell.p.getOrCreateAutoTrack(trackInstFor(app, t, instIdx), t.id);
  if (cell.row < data.length) data[cell.row] = val255;
  app._armLastByte = val255;
  app.markDirty('midicc', true);        // streamed → coalesce into one undo step
  if (cell.p.autoTracks.length !== before) app.view._resize();  // new track widens the grid
  app.view.draw();
}

// Arm a target for live recording: suppress its existing track (so it stops
// fighting). `held` (a knob being dragged) never time-expires; otherwise (MIDI
// CC) the arm lingers ARM_LINGER_MS past the last write. No-op when not recording.
export function armForRecord(app: App, t: ParamTarget, instIdx: number, held = false): void {
  if (!app._recordEnabled) return;
  app.engine._armedTrack = { paramId: t.id, targetInstIdx: trackInstFor(app, t, instIdx) };
  app._armUntil = held ? Infinity : Date.now() + ARM_LINGER_MS;
}

// Clear the arm immediately (knob pointer-up).
export function disarmRecord(app: App): void {
  app.engine._armedTrack = null;
  app._armUntil = 0;
  app._armPrevRow = -1;
  app._armLastByte = -1;
}

// Record a knob's real value to its target while dragging (arm + write). Pass a
// null target for knobs with no automation target (e.g. moog p2/p3) — a no-op.
export function recordKnob(app: App, t: ParamTarget | null, instIdx: number, value: number): void {
  if (!t || !app._recordEnabled) return;
  armForRecord(app, t, instIdx, true);   // held until pointer-up
  recordParamByte(app, t, instIdx, normByte(t, value));
}

// Per-frame: expire a lingering (MIDI-CC) arm, and LATCH the held value into
// every row the playhead has crossed since the last frame. Latching (rather than
// writing only on change) means a continuous gesture leaves a value on every
// swept row — no empty steps — and cleanly overwrites whatever was there before.
export function tickRecord(app: App): void {
  const arm = app.engine._armedTrack;
  if (!arm) { app._armPrevRow = -1; return; }
  if (app._armUntil !== Infinity && Date.now() > app._armUntil) { disarmRecord(app); return; }
  if (!app.engine.playing) { app._armPrevRow = -1; return; }

  const row = app.engine.displayRow;
  const p = app.view.pattern;
  if (p && app._armPrevRow >= 0 && row !== app._armPrevRow && app._armLastByte >= 0) {
    const track = p.autoTracks.find(
      (t) => t.targetParamId === arm.paramId && t.targetInstIdx === arm.targetInstIdx);
    if (track) {
      // Fill prev+1..row when stepping forward within a pattern; on a wrap or
      // pattern change (row < prev) just stamp the new row.
      if (row > app._armPrevRow) {
        for (let r = app._armPrevRow + 1; r <= row && r < track.data.length; r++) track.data[r] = app._armLastByte;
      } else if (row < track.data.length) {
        track.data[row] = app._armLastByte;
      }
      app.markDirty('midicc', true);
    }
  }
  app._armPrevRow = row;
}

// Resolve the inst-scope target for a p0/p1 knob (null for p2/p3 — no target).
export function instParamTarget(type: string, bank: string, index: number): ParamTarget | null {
  return targetsForType(type as any).find(
    (t) => t.scope === 'inst' && t.bank === bank && t.index === index) || null;
}
// Resolve the fx-scope target for an fx param key (null if the key has no target).
export function fxParamTarget(key: string): ParamTarget | null {
  return targetsForType('303' as any).find((t) => t.scope === 'fx' && t.key === key) || null;
}
