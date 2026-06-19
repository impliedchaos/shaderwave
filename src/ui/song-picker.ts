// Song picker dropdown — extracted from main.ts.
import type { App } from '../main.js';
import { DEMO_SONGS, loadSongInstruments } from '../tracker/song.js';


const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSongPicker(app: App) {
  const btn = $('song-picker-btn');
  if (btn) btn.onclick = (e) => { e.stopPropagation(); toggleSongMenu(app); };
  // Dismiss on an outside click or Escape.
  document.addEventListener('mousedown', (e) => {
    const root = $('song-picker'), menu = $('song-picker-menu');
    if (menu && !menu.hidden && root && !root.contains(e.target as Node)) closeSongMenu(app);
  });
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') closeSongMenu(app); });
  buildSongPicker(app);
}

export function toggleSongMenu(app: App) {
  const menu = $('song-picker-menu');
  const btn = $('song-picker-btn');
  if (!menu) return;
  if (menu.hidden) {
    buildSongPicker(app);
    // Position the fixed menu under the trigger (it's fixed so the LCD panel's
    // overflow:hidden can't clip it).
    if (btn) { const r = btn.getBoundingClientRect(); menu.style.left = `${Math.round(r.left - 8)}px`; menu.style.top = `${Math.round(r.bottom + 8)}px`; }
    menu.hidden = false;
    btn?.setAttribute('aria-expanded', 'true');
  } else closeSongMenu(app);
}

export function closeSongMenu(_app: App) {
  const menu = $('song-picker-menu');
  if (menu) menu.hidden = true;
  $('song-picker-btn')?.setAttribute('aria-expanded', 'false');
}

// Refresh the trigger label + rebuild the menu rows (user songs first, then demos).
export function buildSongPicker(app: App) {
  const label = $('song-picker-current');
  if (label) label.textContent = app.songDisplayName();
  const menu = $('song-picker-menu');
  if (!menu) return;
  menu.innerHTML = '';

  const group = (title: string) => {
    const h = document.createElement('div');
    h.className = 'song-grp'; h.textContent = title;
    menu.appendChild(h);
  };
  const row = (o: { name: string; color: string; active: boolean; onClick: () => void; onDelete?: () => void }) => {
    const r = document.createElement('div');
    r.className = 'song-row' + (o.active ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'song-dot'; dot.style.background = o.color;
    const nm = document.createElement('span'); nm.className = 'song-row-name'; nm.textContent = o.name;
    r.append(dot, nm);
    r.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closeSongMenu(app); o.onClick(); };
    if (o.onDelete) {
      const del = document.createElement('button');
      del.className = 'song-del'; del.textContent = '🗑'; del.title = 'Delete this saved song';
      del.onclick = (e) => { e.stopPropagation(); o.onDelete!(); };
      r.appendChild(del);
    }
    menu.appendChild(r);
  };

  const users = app.store.list();
  if (users.length) {
    group('MY SONGS');
    for (const m of users) row({
      name: m.name, color: m.color || '#7d8aa0',
      active: app.currentSong.kind === 'user' && app.currentSong.id === m.id,
      onClick: () => app._loadUserSong(m.id),
      onDelete: () => app._deleteUserSong(m.id, m.name),
    });
  }
  group('DEMOS');
  const demos = DEMO_SONGS.map((s, i) => ({ s, i })).sort((a, b) => a.s.name.localeCompare(b.s.name));
  for (const { s, i } of demos) row({
    name: s.name, color: '#5a6b86',   // a uniform muted dot marks demos vs. vivid user colours
    active: app.currentSong.kind === 'demo' && app.currentSong.demoIdx === i,
    onClick: () => app._loadDemo(i),
  });
}

// Load a built-in demo (resets to a fresh, pruned instrument table).
export function loadDemo(app: App, idx: number) {
  const songDef = DEMO_SONGS[idx];
  if (!songDef) return;
  app._autosaveNow();                 // flush any pending edit on the outgoing song
  app.customSongName = null;
  app.currentSong = { kind: 'demo', demoIdx: idx };
  app.songAuthor = songDef.author ?? '';
  app.songNote = songDef.note ?? '';
  const bpmInput = $<HTMLInputElement>('bpm');
  if (bpmInput) bpmInput.value = String(songDef.bpm);
  app.engine.bpm = songDef.bpm;
  const loaded = loadSongInstruments(songDef);
  app.engine.instruments = loaded.instruments;
  app._syncRendererFx();
  app._hydrateSampleUrls();

  const wasPlaying = app.engine.playing;
  app.engine.stop();
  app.engine.loadSong(loaded.data);
  app.engine.currentPatternIdx = 0;

  app.controls.selected = 0;
  app.controls.select(0);
  app.view.cursor.row = 0; app.view.cursor.ch = 0; app.view.selection = null; app.view.scroll = 0;
  const lenInput = $<HTMLInputElement>('pattern-len');
  if (lenInput) lenInput.value = String(app.view.pattern.rows);
  app.view.draw();
  app._renderSongEditor();
  app._updatePatternSelector();
  if (wasPlaying) app.engine.play();
  app._seedHistory();
  app._buildSongPicker();
}

// Open a saved user song from storage.
export async function loadUserSong(app: App, id: string) {
  app._autosaveNow();                             // flush the outgoing song first
  const doc = await app.store.load(id);
  if (!doc) { app._buildSongPicker(); return; }   // vanished/corrupt → just refresh the list
  app.currentSong = { kind: 'user', id };
  app._applySerializedSong(doc);
}

// Delete a saved user song; if it's the one open, fall back to the default demo.
export function deleteUserSong(app: App, id: string, name: string) {
  if (!confirm(`Delete saved song "${name}"? This can't be undone.`)) return;
  const isOpen = app.currentSong.kind === 'user' && app.currentSong.id === id;
  if (isOpen && app._autosaveTimer) { clearTimeout(app._autosaveTimer); app._autosaveTimer = undefined; }
  app.store.delete(id);
  if (isOpen) {
    // Switch identity OFF the deleted song BEFORE the fallback load, so its
    // autosave-flush can't resurrect what we just removed.
    app.currentSong = { kind: 'demo', demoIdx: 0 };
    const found = DEMO_SONGS.findIndex((s) => s.name === 'Antiseptik USA');
    app._loadDemo(found !== -1 ? found : 0);
  } else {
    app._buildSongPicker();
  }
}
