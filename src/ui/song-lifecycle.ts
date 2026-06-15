// Song lifecycle: snapshot, undo/redo, autosave, fork, save/load — extracted from main.ts.
import type { App } from '../main.js';
import { serializeSong, deserializeSong, patternFromSerialized, instrumentSpecs } from '../tracker/song-io.js';
import type { SerializedSong } from '../tracker/song-io.js';
import { DEMO_SONGS, instrumentsFromParams } from '../tracker/song.js';
import { Pattern } from '../tracker/pattern.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// markDirty tags that count as a "content" edit (touch patterns / the instrument set
// / order / metadata) — the trigger for forking a demo into an editable user copy.
// Everything else is a "tweak" (knobs, fx params, bpm, master, pan, LFO) which is
// undoable but doesn't, on its own, fork a demo or persist.
export const CONTENT_TAGS = new Set([
  'note', 'clear', 'volnudge', 'autocell', 'editval', 'fx', 'cut', 'paste',
  'pattern', 'order', 'resize', 'autotrack', 'instrument', 'midicc', 'meta',
]);

// The current song's display name: an explicit user title, else the demo's name.
export function songDisplayName(app: App): string {
  if (app.customSongName) return app.customSongName;
  if (app.currentSong.kind === 'demo') return DEMO_SONGS[app.currentSong.demoIdx]?.name ?? 'Untitled';
  return 'Untitled';
}

// Capture the WHOLE editable document as a portable, self-contained object — the
// single source of truth for Save (→ file), undo/redo (→ history) and autosave
// (→ IndexedDB). Returns null when there's no song loaded.
export function snapshot(app: App): SerializedSong | null {
  const eng = app.engine;
  if (!eng.song) return null;
  const name = songDisplayName(app);
  return serializeSong({
    name,
    author: app.songAuthor,
    note: app.songNote,
    bpm: eng.bpm,
    rowsPerBeat: eng.rowsPerBeat,
    master: eng.songMaster,
    pan: Array.from(eng.channelPan),
    instruments: eng.instruments,   // each carries its own .fx (serialized per-instance)
    order: eng.song.order,
    patterns: eng.song.patterns,
    lfos: eng.lfos,
    modRoutings: eng.modRoutings,
  });
}

// Reset undo history to the current document as the baseline (no undo step).
// Called on every full document load (initial, song switch, New, file load).
export function seedHistory(app: App) {
  const snap = snapshot(app);
  if (snap) app.history.reset(snap);
  app._histTag = '';
  app._histTime = 0;
  refreshUndoUI(app);
}

// Record that the document changed. `tag` names the gesture; pass `coalesce` for
// streaming gestures (knob drag, two-digit entry) so a burst folds into one undo
// step rather than dozens. No-ops while a restore is applying (its mutations are
// the undo itself, not new edits).
export function markDirty(app: App, tag = 'edit', coalesce = false) {
  if (app._restoring) return;
  const snap = snapshot(app);
  if (!snap) return;
  const now = performance.now();
  if (coalesce && app._histTag === tag && now - app._histTime < 450) {
    app.history.replacePresent(snap);
  } else {
    app.history.push(snap);
  }
  app._histTag = tag;
  app._histTime = now;
  refreshUndoUI(app);

  // Persistence lifecycle. A user song autosaves; a demo forks into an editable
  // user copy on the FIRST content edit (tweaks alone don't fork or persist).
  if (app.currentSong.kind === 'user') {
    scheduleAutosave(app);
  } else if (CONTENT_TAGS.has(tag)) {
    forkDemo(app);
  }
}

// Demo → "<name> (edit)" user song on first content edit. Mints a record, switches
// identity to it, persists immediately, and refreshes the picker. The original demo
// stays in the list; undo history (already recorded) is unaffected.
export function forkDemo(app: App) {
  if (app.currentSong.kind === 'demo') {
    const demoName = DEMO_SONGS[app.currentSong.demoIdx]?.name ?? 'Untitled';
    // Honour a title the user typed; otherwise tag the copy "(edit)".
    if (!app.customSongName || app.customSongName === demoName) {
      app.customSongName = `${demoName} (edit)`;
    }
    app.currentSong = { kind: 'user', id: app.store.createId() };
  }
  autosaveNow(app);
  app._buildSongPicker();
}

// Debounced autosave for the active user song (coalesces a burst of edits).
export function scheduleAutosave(app: App) {
  if (app._autosaveTimer) clearTimeout(app._autosaveTimer);
  app._autosaveTimer = setTimeout(() => { app._autosaveTimer = undefined; autosaveNow(app); }, 1500);
}

// Write the active user song to storage now (also called on fork + page hide).
// The id + snapshot are captured synchronously, so the async write is correct even
// if `currentSong` changes (e.g. switching songs) before it commits.
export function autosaveNow(app: App) {
  if (app._autosaveTimer) { clearTimeout(app._autosaveTimer); app._autosaveTimer = undefined; }
  if (app.currentSong.kind !== 'user') return;
  const snap = snapshot(app);
  if (!snap) return;
  app.store.save(app.currentSong.id, snap).then((res) => {
    if (!res.ok && !app._storageWarned) {
      app._storageWarned = true;
      console.warn('Autosave failed:', res.error);
      const status = $('audio-status');
      if (status && res.error) status.title = `Autosave: ${res.error}`;
    }
  });
}

// A non-colliding "Untitled" / "Untitled N" name for a freshly created song.
export function uniqueUntitled(app: App): string {
  const taken = new Set(app.store.list().map((m) => m.name));
  if (!taken.has('Untitled')) return 'Untitled';
  for (let n = 2; ; n++) { const c = `Untitled ${n}`; if (!taken.has(c)) return c; }
}

export function undo(app: App) {
  const doc = app.history.undo();
  if (doc) restoreSnapshot(app, doc);
  refreshUndoUI(app);
}

export function redo(app: App) {
  const doc = app.history.redo();
  if (doc) restoreSnapshot(app, doc);
  refreshUndoUI(app);
}

// Enable/disable the Undo/Redo buttons to match availability.
export function refreshUndoUI(app: App) {
  const u = $<HTMLButtonElement>('undo-btn');
  const r = $<HTMLButtonElement>('redo-btn');
  if (u) u.disabled = !app.history.canUndo();
  if (r) r.disabled = !app.history.canRedo();
}

// Restore a snapshot into the engine + UI WITHOUT pruning the instrument table
// (so a just-added, note-less instrument survives undo) and WITHOUT moving the
// editing position (cursor / pattern / selected instrument are preserved, clamped).
// Routes through the same load path as a file open, so all transient engine state
// (autoLive / panAuto / vd.master / LFO bases) is reset deterministically.
export function restoreSnapshot(app: App, doc: SerializedSong) {
  const eng = app.engine;
  app._restoring = true;
  try {
    const prevPat = eng.currentPatternIdx;
    const prevSel = app.controls.selected;
    const prevCur = { ...app.view.cursor };
    const prevScroll = app.view.scroll;

    app.customSongName = doc.name;
    app.songAuthor = doc.author ?? '';
    app.songNote = doc.note ?? '';

    eng.stop();
    eng.bpm = doc.bpm;
    const bpmInput = $<HTMLInputElement>('bpm');
    if (bpmInput) bpmInput.value = String(doc.bpm);

    eng.instruments = instrumentsFromParams(instrumentSpecs(doc));
    app._syncRendererFx();

    let patterns = doc.patterns.map(patternFromSerialized);
    if (!patterns.length) patterns = [new Pattern(32, 8)];
    eng.loadSong({
      patterns,
      order: doc.order.length ? [...doc.order] : [0],
      rowsPerBeat: doc.rowsPerBeat,
      bpm: doc.bpm,
      pan: doc.pan,
      master: doc.master,
      lfos: doc.lfos,
      modRoutings: doc.modRoutings,
    });

    eng.currentPatternIdx = Math.min(prevPat, patterns.length - 1);
    app.controls.selected = eng.instruments.length
      ? Math.min(prevSel < 0 ? 0 : prevSel, eng.instruments.length - 1) : -1;
    app.controls.select(app.controls.selected);

    const p = app.view.pattern;
    app.view.cursor.row = p ? Math.min(prevCur.row, p.rows - 1) : 0;
    app.view.cursor.ch = prevCur.ch;
    app.view.cursor.col = prevCur.col;
    app.view.selection = null;
    app.view.scroll = prevScroll;
    app.view.clampCursor();
    const lenInput = $<HTMLInputElement>('pattern-len');
    if (lenInput && app.view.pattern) lenInput.value = String(app.view.pattern.rows);

    app.view._resize();
    app.view.draw();
    app._renderSongEditor();
    app._updatePatternSelector();
    // Playback is left stopped (like a file load): the rebuilt patterns reset the
    // row clock, so resuming would jump to the top anyway.
  } finally {
    app._restoring = false;
  }
}

// Serialize the current song to a versioned JSON file and download it.
export function saveSong(app: App) {
  const doc = snapshot(app);
  if (!doc) return;
  const name = doc.name;
  const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 64) || 'song';
  a.href = url;
  a.download = `${safe}.shaderwave.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Read a .json song file, validate/parse it, and load it as a new user song
// (so an imported file joins the library and autosaves from then on).
export function loadSongFile(app: App, file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = deserializeSong(JSON.parse(String(reader.result)));
      autosaveNow(app);                 // flush the outgoing song first
      app.currentSong = { kind: 'user', id: app.store.createId() };
      applySerializedSong(app, doc);
      autosaveNow(app);                 // persist the import + add it to the picker
      app._buildSongPicker();
    } catch (err) {
      alert(`Couldn't load song: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  reader.onerror = () => alert("Couldn't read the file.");
  reader.readAsText(file);
}

// Apply a deserialized song to the engine + UI. Identity-agnostic: the CALLER sets
// `currentSong` (a saved-song open, a file import) before invoking.
export function applySerializedSong(app: App, doc: SerializedSong) {
  app.customSongName = doc.name || 'Untitled';
  app.songAuthor = doc.author ?? '';
  app.songNote = doc.note ?? '';

  app.engine.stop();
  app.engine.bpm = doc.bpm;
  const bpmInput = $<HTMLInputElement>('bpm');
  if (bpmInput) bpmInput.value = String(doc.bpm);

  // Serialized instruments carry their own .fx (deserializeSong migrates v1's
  // per-type fxParams onto them), so instrumentsFromParams rebuilds per-instance fx.
  app.engine.instruments = instrumentsFromParams(instrumentSpecs(doc));
  app._syncRendererFx();
  app._hydrateSampleUrls();

  let patterns = doc.patterns.map(patternFromSerialized);
  if (!patterns.length) patterns = [new Pattern(32, 8)];
  app.engine.loadSong({
    patterns,
    order: doc.order.length ? [...doc.order] : [0],
    rowsPerBeat: doc.rowsPerBeat,
    bpm: doc.bpm,
    pan: doc.pan,
    master: doc.master,
    lfos: doc.lfos,
    modRoutings: doc.modRoutings,
  });
  app.engine.currentPatternIdx = 0;

  // Empty instrument table (a saved blank song) → no selection, like New.
  app.controls.selected = app.engine.instruments.length ? 0 : -1;
  app.controls.select(app.controls.selected);

  app.view.cursor.row = 0;
  app.view.cursor.ch = 0;
  app.view.selection = null;
  app.view.scroll = 0;
  const lenInput = $<HTMLInputElement>('pattern-len');
  if (lenInput) lenInput.value = String(app.view.pattern.rows);
  app.view.draw();
  app._renderSongEditor();
  app._updatePatternSelector();
  seedHistory(app);   // loaded document → new undo baseline
  app._buildSongPicker();
}
