// App entry: builds the GL renderer + audio pipeline + tracker engine + UI and
// wires keyboard/transport. Audio is created lazily on the first user gesture
// (browser autoplay policy), so the grid is interactive before any sound.
import { createGL } from './gl/context.js';
import { SynthRenderer } from './gl/synth-renderer.js';
import { defaultFxParams } from './gl/effects.js';
import { AudioPipeline } from './audio/pipeline.js';
import { Engine } from './tracker/engine.js';
import { TrackerView } from './ui/tracker-view.js';
import { Controls, bindKnob } from './ui/controls.js';
import { DEMO_SONGS, loadSongInstruments } from './tracker/song.js';
import { decodeSampleUrl } from './audio/sample-loader.js';
import type { SerializedSong } from './tracker/song-io.js';
import { History } from './tracker/history.js';
import { SongStore } from './tracker/song-store.js';
import { PresetStore } from './tracker/preset-store.js';
import { buildShareUrl, decodeShareHash } from './tracker/song-codec.js';
import { instGlow, DEFAULT_MASTER } from './constants.js';
import { byType } from './instruments/index.js';
import { Pattern } from './tracker/pattern.js';
import { targetsForType, TARGETS } from './tracker/automation.js';
import { showExportDialog } from './audio/export.js';
import { renderArranger } from './ui/arranger.js';
import { invalidateTheme, themeVar, toggleTheme, currentTheme, displayAccent } from './ui/theme.js';
import { initHelp } from './ui/help.js';
import pkg from '../package.json';
import type { ParamTarget } from './types.js';

// ── Extracted modules ──
import { buildFxPanel, type KnobEl } from './ui/fx-panel.js';
import { buildLfoUI } from './ui/lfo-panel.js';
import { initMidi } from './ui/midi.js';
import { tickRecord } from './ui/record.js';
import { bindKeys, advanceCursorRow, closeFxPicker, type ClipCell } from './ui/input.js';
import {
  songDisplayName as _songDisplayName,
  snapshot as _snapshot,
  seedHistory, markDirty as _markDirty,
  autosaveNow as _autosaveNow,
  undo as _undo, redo as _redo,
  saveSong, loadSongFile,
  applySerializedSong as _applySerializedSong,
  uniqueUntitled,
} from './ui/song-lifecycle.js';
import {
  initSongPicker, buildSongPicker,
  loadDemo as _loadDemo, loadUserSong as _loadUserSong,
  deleteUserSong as _deleteUserSong,
} from './ui/song-picker.js';

// Display version from package.json
const versionSpan = document.getElementById('app-version');
if (versionSpan) {
  versionSpan.textContent = `v${pkg.version}`;
}

// Lookup an element by id, narrowed to T. Returns the cast node; callers that
// guard with `if (x)` still get correct runtime behaviour (getElementById can
// return null) — the cast just spares every call site a null check.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PLAY_ICON = `<svg class="icon" viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9-5.5-9-5.5z" fill="currentColor"/></svg>`;
const PAUSE_ICON = `<svg class="icon" viewBox="0 0 16 16" width="14" height="14"><path d="M3 2.5h3.5v11H3zm6.5 0h3.5v11H9.5z" fill="currentColor"/></svg>`;

// Which document is open: a built-in demo (by index) or a saved user song (by id).
export type CurrentSong = { kind: 'demo'; demoIdx: number } | { kind: 'user'; id: string } | { kind: 'shared' };

export class App {
  gl: WebGL2RenderingContext;
  engine: Engine;
  currentSong: CurrentSong;
  store = new SongStore();
  presetStore = new PresetStore();
  _autosaveTimer?: ReturnType<typeof setTimeout>;
  _storageWarned = false;
  pipeline: AudioPipeline;
  renderer: SynthRenderer | null;
  audioReady: boolean;
  underruns: number;
  view: TrackerView;
  controls: Controls;
  held: Map<string, number>;
  _samplesLoading = new Set<import('./types.js').InstrumentInstance>();
  customSongName: string | null = null;
  songAuthor = '';
  songNote = '';
  lastRecordedRow = 0;        // video-export progress cursor
  _playbackVolume?: number;
  _fxKnobs: { el: KnobEl; key: string }[] = [];
  _songVolumeKnob?: KnobEl;
  _fxPanelInst?: number;   // instrument-instance index the FX panel is editing
  _digitEntry: { idx: number; col: number; first: number } | null = null;
  _hexEntry: { idx?: number; ch?: number; row?: number; col?: number; first: number } | null = null;
  _clipboard: { rows: number; chans: number; cells: ClipCell[][] } | null = null;
  _fxPicker: HTMLElement | null = null;
  _vuL = 0;
  _vuR = 0;
  _freqData?: Uint8Array<ArrayBuffer>;
  _waveData?: Uint8Array<ArrayBuffer>;
  _recordEnabled = false;
  _accentColor = '#00f0ff';   // selected instrument's base colour; re-themed for light mode via _applyAccent
  // Live-record arm bookkeeping (see ui/record.ts). `_armUntil` is the linger
  // deadline (Infinity while a knob is held); `_armPrevRow`/`_armLastByte` let
  // tickRecord latch the held value into every row the playhead crosses.
  _armUntil = 0;
  _armPrevRow = -1;
  _armLastByte = -1;
  // Undo/redo: whole-document snapshot history. `_histTag`/`_histTime` drive the
  // coalescing of a continuing gesture (knob drag, two-digit entry) into one step.
  history = new History();
  _histTag = '';
  _histTime = 0;
  _restoring = false;        // guards against markDirty re-entrancy during a restore

  constructor() {
    // GL renders audio entirely into FBOs (read back via readPixels), so its
    // canvas is never displayed — and it MUST be separate from the 2D grid
    // canvas, since a canvas can only ever hand out one context type.
    const glCanvas = document.createElement('canvas');
    glCanvas.width = 1; glCanvas.height = 1;
    this.gl = createGL(glCanvas);
    $('gl-status').innerHTML = 'gl: <span class="ok">ready</span>';

    const canvas = $<HTMLCanvasElement>('grid');

    this.engine = new Engine(48000); // sample rate reconciled when audio starts
    // Sort indices alphabetically to determine the default song index
    const sortedIndices = DEMO_SONGS.map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.name.localeCompare(b.s.name));
    const found = DEMO_SONGS.findIndex(s => s.name === "Antiseptik USA");
    const defaultIdx = found !== -1 ? found : sortedIndices[0].i;
    this.currentSong = { kind: 'demo', demoIdx: defaultIdx };
    const initialSong = DEMO_SONGS[defaultIdx];
    this.songAuthor = initialSong.author ?? '';
    this.songNote = initialSong.note ?? '';
    const init = loadSongInstruments(initialSong);
    this.engine.instruments = init.instruments;
    this.engine.loadSong(init.data);
    this.engine.bpm = initialSong.bpm;
    // fx is per-instrument now: each instance carries its own .fx (set by
    // loadSongInstruments). The renderer is told via _syncRendererFx() once it exists.

    const bpmInput = $<HTMLInputElement>('bpm');
    if (bpmInput) {
      bpmInput.value = String(initialSong.bpm);
    }

    this.pipeline = new AudioPipeline();
    this.renderer = null;
    this.audioReady = false;
    this.underruns = 0;

    this.view = new TrackerView(canvas, this.engine);
    this.controls = new Controls(this.engine, {
      instEl: $('instruments'), paramEl: $('params'),
      app: this,
      onSelect: (idx) => {
        const instr = this.engine.instruments[idx];
        this._accentColor = instr ? instr.color : '#00f0ff';
        if (instr) this._buildFxPanel();   // FX is per instance — the panel edits the selected one's chain
        this._applyAccent();
      },
      onPresetChange: (instName, fx) => {
        // A preset carries its own fx chain → apply it to the SELECTED instance
        // (default-filled so the preset fully defines its sound), then resync.
        const instr = this.engine.instruments[this.controls.selected];
        if (instr && !byType(instName)?.customControls && fx) {
          instr.fx = Object.assign(defaultFxParams(), fx);
          // (markDirty for the whole preset load is recorded by Controls.loadPreset)
          this._buildFxPanel();
          this._syncRendererFx();
        }
      }
    });

    this.held = new Map(); // keyCode → voice index (for preview release)
    
    this.controls.select(0); // initialize color scheme and FX panel

    this._bindTransport();
    this._renderSongEditor();
    this._updatePatternSelector();
    bindKeys(this);
    this._bindBufferControl();
    initHelp();
    this._bindTheme();
    initMidi(this);
    this._loop();

    // Grid gestures that commit an edit (pan drag, auto-track removal) live in the
    // view, not a handler here — route them through markDirty.
    this.view.onEdit = (tag = 'edit') => this.markDirty(tag);
    // Seed undo history with the initial document.
    this._seedHistory();

    // Flush a pending autosave when the tab is hidden or closed (so the last edits
    // to a user song survive even if the debounce timer hasn't fired yet). NB: an
    // IndexedDB write can't be awaited in `beforeunload` — `visibilitychange:hidden`
    // (which fires on tab-switch/close and CAN complete) is the reliable path; the
    // beforeunload call is a best-effort backstop.
    window.addEventListener('beforeunload', () => this._autosaveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._autosaveNow();
    });

    // Open the song library and fill the picker once its metadata is loaded (async;
    // the picker already rendered with demos, this adds the MY SONGS group).
    this.store.init().then(() => this._buildSongPicker());
    // Load the user-preset library so the Instrument tab can list saved presets.
    this.presetStore.init().then(() => this.controls?._populatePresets());

    this.pipeline.onStats = (s) => { this.underruns = s.underruns; };
    setInterval(() => { if (this.audioReady) this.pipeline.requestStats(); }, 500);

    // If the page was opened via a share link (#s=…), replace the default song with
    // the decoded one — loaded transiently (Save persists it to the library).
    this._tryLoadSharedSong();
  }

  async _tryLoadSharedSong() {
    let doc: SerializedSong | null = null;
    try { doc = await decodeShareHash(); } catch { /* bad link → keep default */ }
    if (!doc) return;
    this.currentSong = { kind: 'shared' };
    this._applySerializedSong(doc);
    this._seedHistory();
    this._buildSongPicker();
  }

  async ensureAudio() {
    if (this.audioReady) return;
    const sr = await this.pipeline.init();
    this.engine.sampleRate = sr;
    this._updateLatencyDisplay();   // now reflects the real sample rate
    this.renderer = new SynthRenderer(this.gl, sr);
    this._syncRendererFx();   // hand the renderer this song's per-instance fx
    this._hydrateSampleUrls(); // fetch any URL-referenced sampler PCM (e.g. demo vocals)
    // Realtime path: pipelined async readback (read block N-1 while N's DMA is in
    // flight) so the GPU→CPU copy never stalls the producer's main thread. Offline
    // WAV export keeps using the synchronous renderBlock (it wants exact, full-length
    // output and has no main-thread-stall concern).
    const produce = (blockStart: number) => this.renderer!.renderBlockAsync(this.engine.advance(blockStart), blockStart);
    await this.pipeline.start(produce);
    this.pipeline.setVolume(this._playbackVolume ?? 1.0); // apply the slider's monitor gain
    this.audioReady = true;
    $('audio-status').innerHTML = `audio: <span class="ok">running</span> @ ${sr | 0}Hz`;
  }

  // ── Thin wrappers → extracted modules ──

  _buildFxPanel() { buildFxPanel(this); }
  _buildLfoUI() { buildLfoUI(this); }

  // Single switch point for the editor tabs (Pattern / Song / Instrument).
  // Called by the tab buttons and by the instrument list's "open editor" icon.
  activateTab(name: 'pattern' | 'song' | 'instrument') {
    const tabs: Record<typeof name, { btn: string; content: string }> = {
      pattern: { btn: 'tab-pattern', content: 'pattern-editor-content' },
      song: { btn: 'tab-song', content: 'song-arranger-content' },
      instrument: { btn: 'tab-instrument', content: 'instrument-editor-content' },
    };
    for (const k of Object.keys(tabs) as (typeof name)[]) {
      const sel = k === name;
      document.getElementById(tabs[k].btn)?.classList.toggle('active', sel);
      const content = document.getElementById(tabs[k].content);
      if (content) content.style.display = sel ? 'flex' : 'none';
    }
    // Per-tab activation hooks.
    if (name === 'pattern') { this.view._resize(); this.view.draw(); }
    else if (name === 'song') { this._renderSongEditor(); }
    // 'instrument': params/fx are kept live on selection — nothing to rebuild.
  }

  songDisplayName(): string { return _songDisplayName(this); }
  _snapshot(): SerializedSong | null { return _snapshot(this); }
  _seedHistory() { seedHistory(this); }
  markDirty(tag = 'edit', coalesce = false) { _markDirty(this, tag, coalesce); }
  _autosaveNow() { _autosaveNow(this); }
  _undo() { _undo(this); }
  _redo() { _redo(this); }
  _saveSong() { saveSong(this); }
  _loadSongFile(file: File) { loadSongFile(this, file); }
  _applySerializedSong(doc: SerializedSong) { _applySerializedSong(this, doc); }

  _buildSongPicker() { buildSongPicker(this); }
  _loadDemo(idx: number) { _loadDemo(this, idx); }
  async _loadUserSong(id: string) { await _loadUserSong(this, id); }
  _deleteUserSong(id: string, name: string) { _deleteUserSong(this, id, name); }

  _advanceCursorRow() { advanceCursorRow(this); }
  _closeFxPicker() { closeFxPicker(this); }

  // Hand the renderer the current per-instance fx (array indexed by instance), called
  // after any instrument-table or fx change. The renderer reads each instance.fx by
  // reference, so live knob edits are picked up without re-calling this.
  _syncRendererFx() {
    this.renderer?.setInstrumentFx(this.engine.instruments.map((i) => i.fx));
    this.renderer?.setInstrumentFxOrder(this.engine.instruments.map((i) => i.fxOrder));
    this.renderer?.syncSamplerSlots(this.engine.instruments);
    this.renderer?.syncAdditiveSpectra(this.engine.instruments);   // analyze + upload Spectra resynthesis profiles
  }

  // Fetch + decode any sampler instance that carries a sample URL but no PCM yet
  // (presets/demo songs ship samples by reference). Async and idempotent: each
  // instance is fetched at most once; the sound pops in when ready, then we
  // re-sync the renderer's atlas. NOT a user edit, so it never marks the song dirty.
  _hydrateSampleUrls() {
    for (const inst of this.engine.instruments) {
      const s = inst.sample;
      if (!s || !s.url || s.pcm.length > 0 || this._samplesLoading.has(inst)) continue;
      this._samplesLoading.add(inst);
      decodeSampleUrl(s.url)
        .then((pcm) => {
          if (inst.sample !== s) return;          // song changed under us — drop
          s.pcm = pcm;
          if (!s.loopEnd) s.loopEnd = pcm.length;
          this._syncRendererFx();                 // re-upload the now-filled slot
        })
        .catch((e) => console.error(`Failed to hydrate sample ${s.url}`, e))
        .finally(() => this._samplesLoading.delete(inst));
    }
  }

  // Light/dark theme toggle in the header. The saved theme is already applied by the
  // inline <head> script (no flash); here we just flip + relabel + repaint the canvas
  // grid (the DOM recolours via CSS vars; the visualizer repaints each frame anyway).
  _bindTheme() {
    const btn = document.getElementById('theme');
    if (!btn) return;
    const relabel = () => { btn.innerHTML = currentTheme() === 'light' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg><span class="btn-label">Theme</span>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg><span class="btn-label">Theme</span>'; };
    relabel();
    btn.onclick = () => { toggleTheme(); relabel(); this._applyAccent(); this.controls._buildInstruments(); this.view.draw(); };
  }

  // Push the selected instrument's colour into the UI accent vars, darkened for light
  // mode if it's a too-bright neon (see displayAccent). Re-run on instrument select AND
  // on theme toggle so the accent stays readable on whichever theme is active.
  _applyAccent() {
    const a = displayAccent(this._accentColor);
    const s = document.documentElement.style;
    s.setProperty('--accent', a);
    s.setProperty('--accent-glow', instGlow(a, 0.2));
    s.setProperty('--cursor-border', a);
    invalidateTheme();
  }

  _bindTransport() {
    $('play').onclick = async () => {
      await this.ensureAudio();
      const e = this.engine;
      if (e.playing && e.playMode === 'song') e.pause();
      else if (e.paused && e.playMode === 'song') e.resume();
      else e.play('song');
    };
    $('stop').onclick = () => {
      this.engine.stop();
      if (this._recordEnabled) {
        this._recordEnabled = false;
        const rBtn = $('record');
        if (rBtn) rBtn.classList.remove('playing');
      }
    };
    const recordBtn = $('record');
    if (recordBtn) {
      recordBtn.onclick = async () => {
        this._recordEnabled = !this._recordEnabled;
        recordBtn.classList.toggle('playing', this._recordEnabled);
        // Arming record starts playback so notes/automation land at the playhead.
        // If something's already playing (incl. a pattern loop) leave its mode be.
        if (this._recordEnabled && !this.engine.playing) {
          await this.ensureAudio();
          if (this.engine.paused) this.engine.resume(); else this.engine.play('song');
        }
      };
    }
    $<HTMLInputElement>('bpm').oninput = (e) => {
      const val = Math.max(40, Math.min(300, +(e.target as HTMLInputElement).value || 125));
      this.engine.bpm = val;
    };
    $<HTMLInputElement>('bpm').onchange = () => this.markDirty('bpm');   // one undo step per commit
    const lenInput = $<HTMLInputElement>('pattern-len');
    if (lenInput) {
      lenInput.value = String(this.view.pattern.rows);
      lenInput.onchange = (e) => {
        const t = e.target as HTMLInputElement;
        const val = Math.max(1, Math.min(256, +t.value || this.view.pattern.rows));
        t.value = String(val);
        this.view.pattern.resize(val);
        if (this.view.cursor.row >= val) this.view.cursor.row = val - 1;
        this.markDirty('resize');
        this.view.draw();
        this._renderSongEditor();
      };
    }
    const addAutoTrackBtn = $('add-auto-track-btn');
    if (addAutoTrackBtn) {
      addAutoTrackBtn.onclick = () => this._openAutoTrackPicker();
    }
    const volInput = $<HTMLInputElement>('volume');
    const volVal = $('volume-val');
    if (volInput && volVal) {
      this._playbackVolume = (+volInput.value || 100) / 100; // monitor gain, not the render level
      volInput.oninput = (e) => {
        let val = +(e.target as HTMLInputElement).value;
        if (Math.abs(val - 100) <= 5) { val = 100; (e.target as HTMLInputElement).value = '100'; } // detent at unity
        volVal.textContent = `${val}%`;
        this._playbackVolume = val / 100;
        this.pipeline.setVolume(this._playbackVolume);
      };
    }
    // Global output volume knob (Song Editor): sets the song's base master — the
    // render-level gain baked into recordings — NOT the monitor slider above. Same
    // range as the VOL automation target, so 100% == a 0x80 VOL cell == default.
    const volKnob = $('song-volume-knob') as KnobEl;
    const volKnobVal = $('song-volume-val');
    if (volKnob && volKnobVal) {
      this._songVolumeKnob = volKnob;
      const max = DEFAULT_MASTER * 255 / 128;
      bindKnob(volKnob, volKnobVal, 0, max, max / 255, this.engine.songMaster, false,
        (v) => this.engine.setMaster(v),
        (v) => `${Math.round((v / DEFAULT_MASTER) * 100)}%`,
        () => this.markDirty('master'));
    }
    this._buildLfoUI();
    initSongPicker(this);

    // Bind Play Pattern
    const playPatBtn = $('play-pattern');
    if (playPatBtn) {
      playPatBtn.onclick = async () => {
        await this.ensureAudio();
        const e = this.engine;
        if (e.playing && e.playMode === 'pattern') e.pause();
        else if (e.paused && e.playMode === 'pattern') e.resume();
        else e.play('pattern');
      };
    }

    // Bind Next/Prev Pattern Buttons
    const prevPat = $('pat-prev-btn');
    const nextPat = $('pat-next-btn');
    if (prevPat && nextPat) {
      prevPat.onclick = () => {
        if (!this.engine.song) return;
        const totalPatterns = this.engine.song.patterns.length;
        this.engine.currentPatternIdx = (this.engine.currentPatternIdx - 1 + totalPatterns) % totalPatterns;
        this._renderSongEditor();
        this._updatePatternSelector();
        this.view.draw();
      };
      nextPat.onclick = () => {
        if (!this.engine.song) return;
        const totalPatterns = this.engine.song.patterns.length;
        this.engine.currentPatternIdx = (this.engine.currentPatternIdx + 1) % totalPatterns;
        this._renderSongEditor();
        this._updatePatternSelector();
        this.view.draw();
      };
    }

    // Pattern-editor toolbar: add / duplicate / delete the current pattern.
    const patAddBtn = $('pat-add-btn');
    if (patAddBtn) patAddBtn.onclick = () => this._addPattern();
    const patDupBtn = $('pat-dup-btn');
    if (patDupBtn) patDupBtn.onclick = () => this._duplicatePattern();
    const patDelBtn = $('pat-del-btn');
    if (patDelBtn) patDelBtn.onclick = () => {
      const song = this.engine.song;
      if (!song || song.patterns.length <= 1) return;   // never delete the last pattern
      if (confirm(`Delete pattern ${this.engine.currentPatternIdx}? (Ctrl+Z to undo)`)) {
        this._deletePattern(this.engine.currentPatternIdx);
      }
    };

    // Song-info metadata fields (saved with the song).
    const titleInput = $<HTMLInputElement>('song-title');
    if (titleInput) titleInput.oninput = () => {
      this.customSongName = titleInput.value || 'Untitled';
      const label = $('song-picker-current');   // reflect the rename in the picker trigger live
      if (label) label.textContent = this.customSongName;
    };
    if (titleInput) titleInput.onchange = () => { this.markDirty('meta'); this._buildSongPicker(); };   // commit → one undo step + relabel
    const authorInput = $<HTMLInputElement>('song-author');
    if (authorInput) {
      authorInput.oninput = () => { this.songAuthor = authorInput.value; };
      authorInput.onchange = () => this.markDirty('meta');
    }
    const noteInput = $<HTMLTextAreaElement>('song-note');
    if (noteInput) {
      noteInput.oninput = () => { this.songNote = noteInput.value; };
      noteInput.onchange = () => this.markDirty('meta');
    }

    const addOrdBtn = $('add-order-btn');
    if (addOrdBtn) {
      addOrdBtn.onclick = () => {
        if (!this.engine.song) return;
        this.engine.song.order.push(this.engine.currentPatternIdx);
        this.markDirty('order');
        this._renderSongEditor();
      };
    }

    // Bind Tabs Switching
    const tabPat = $('tab-pattern');
    const tabSong = $('tab-song');
    const tabInst = $('tab-instrument');
    if (tabPat) tabPat.onclick = () => this.activateTab('pattern');
    if (tabSong) tabSong.onclick = () => this.activateTab('song');
    if (tabInst) tabInst.onclick = () => this.activateTab('instrument');

    const newSongBtn = $('new-song-btn');
    if (newSongBtn) {
      newSongBtn.onclick = () => {
        this._autosaveNow();              // flush any pending edit on the outgoing song
        this.engine.stop();
        // A blank song is its own user record from the start (so it never replaces
        // another, even after repeated News, and autosaves immediately).
        this.customSongName = uniqueUntitled(this);
        this.currentSong = { kind: 'user', id: this.store.createId() };
        this.songAuthor = '';
        this.songNote = '';

        const newPat = new Pattern(32, 8);
        this.engine.loadSong({ patterns: [newPat], order: [0], rowsPerBeat: 4 });
        this.engine.currentPatternIdx = 0;

        this.engine.instruments = [];   // blank song → no instruments, no fx chains
        this._syncRendererFx();

        this.view.cursor.row = 0;
        this.view.cursor.ch = 0;
        this.view.selection = null;
        this.view.scroll = 0;

        this.controls.selected = -1;
        this.controls.select(-1);

        this.view.draw();
        this._renderSongEditor();
        this._updatePatternSelector();
        this._seedHistory();              // fresh blank document → new undo baseline
        this._autosaveNow();              // persist the new record + add it to the picker
        this._buildSongPicker();
      };
    }

    const undoBtn = $('undo-btn');
    if (undoBtn) undoBtn.onclick = () => this._undo();
    const redoBtn = $('redo-btn');
    if (redoBtn) redoBtn.onclick = () => this._redo();

    const saveSongBtn = $('save-song-btn');
    if (saveSongBtn) saveSongBtn.onclick = () => this._saveSong();

    const loadSongBtn = $('load-song-btn');
    const loadSongInput = $<HTMLInputElement>('load-song-input');
    if (loadSongBtn && loadSongInput) {
      loadSongBtn.onclick = () => loadSongInput.click();
      loadSongInput.onchange = () => {
        const file = loadSongInput.files?.[0];
        if (file) this._loadSongFile(file);
        loadSongInput.value = '';   // allow re-loading the same file
      };
    }

    const shareBtn = $('share-song-btn');
    if (shareBtn) shareBtn.onclick = async () => {
      const doc = this._snapshot();
      if (!doc) return;
      const { url, tooBig } = await buildShareUrl(doc);
      if (tooBig) {
        alert('This song is too big to share by link (it has a large sample). Save it to a file and share that instead.');
        return;
      }
      const label = shareBtn.querySelector('.btn-label');
      const flash = (msg: string) => { if (label) { const t = label.textContent; label.textContent = msg; setTimeout(() => { label.textContent = t; }, 1400); } };
      try { await navigator.clipboard.writeText(url); flash('Copied!'); }
      catch { prompt('Copy this share link:', url); }
    };

    const exportBtn = $('export');
    if (exportBtn) {
      exportBtn.onclick = () => showExportDialog(this);
    }
  }

  _openAutoTrackPicker() {
    this._closeFxPicker(); // We can reuse the same modal mechanism
    const p = this.view.pattern;
    const instruments = this.engine.instruments;
    
    // Build a unified target list: Global targets + targets for every instrument instance
    const allTargets: { target: ParamTarget, instIdx: number | null, instName: string }[] = [];
    
    for (const t of TARGETS) {
      if (t.scope === 'global') {
        allTargets.push({ target: t, instIdx: null, instName: 'Global' });
      } else if (t.scope === 'chan') {
        // chan scope targets are per-channel, so we add one for each channel
        for (let ch = 0; ch < p.channels; ch++) {
          allTargets.push({ target: t, instIdx: ch, instName: `Channel ${ch}` });
        }
      }
    }
    
    for (let i = 0; i < instruments.length; i++) {
      const instr = instruments[i];
      const targets = targetsForType(instr.type);
      for (const t of targets) {
        if (t.scope === 'inst' || t.scope === 'fx') {
          allTargets.push({ target: t, instIdx: i, instName: `${i}: ${instr.type.toUpperCase()}` });
        }
      }
    }

    const overlay = document.createElement('div');
    overlay.className = 'fx-picker-overlay';
    overlay.innerHTML = `<div class="fx-picker" style="width: 400px; max-width: 90vw;">
      <div class="fx-picker-title">Add Auto Track</div>
      <input class="fx-picker-input" placeholder="type code or name…" />
      <ul class="fx-picker-list"></ul>
      <div class="fx-picker-hint">↑↓ select · Enter add track · Esc cancel<br/><span style="opacity: 0.7">(Right-click an AutoTrack header to remove it)</span></div>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.fx-picker-input') as HTMLInputElement;
    const list = overlay.querySelector('.fx-picker-list') as HTMLElement;
    input.value = '';

    let sel = 0, filtered = allTargets;
    const commit = (entry: typeof allTargets[0] | undefined) => {
      if (!entry) return;
      p.autoTracks.push({
        targetScope: entry.target.scope,
        targetInstIdx: entry.instIdx,
        targetParamId: entry.target.id,
        data: new Int16Array(p.rows).fill(-1)
      });
      this.markDirty('autotrack');
      this._closeFxPicker();
      this.view._resize();
      this.view.draw();
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      filtered = allTargets.filter((e) => !q || 
        e.target.code.toLowerCase().startsWith(q) || 
        e.target.label.toLowerCase().includes(q) ||
        e.instName.toLowerCase().includes(q)
      );
      if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1);
      list.innerHTML = filtered.map((e, i) => {
        let tagHtml = '';
        let rowStyle = '';
        if (e.target.scope === 'global') {
          tagHtml = '<span class="fx-tag" style="background: #ff5f5f; color: #000;">global</span>';
        } else if (e.target.scope === 'chan') {
          tagHtml = '<span class="fx-tag" style="background: #00f0ff; color: #000;">channel</span>';
        } else if (e.instIdx !== null) {
          const color = instruments[e.instIdx].color;
          rowStyle = `border-left: 3px solid ${color}; ${i === sel ? '' : `background: ${instGlow(color, 0.05)};`}`;
          tagHtml = `<span class="fx-tag" style="background: ${color}; color: #000;">inst ${e.instIdx}</span>`;
        }
        return `<li class="fx-picker-item${i === sel ? ' sel' : ''}${e.target.scope === 'fx' ? ' fx' : ''}" data-i="${i}" style="${rowStyle}">
          <span class="fx-code" style="min-width: 80px;">${e.instName}</span><span class="fx-code" style="margin-left: 10px">${e.target.code}</span><span class="fx-label">${e.target.label}</span>
          ${tagHtml}</li>`;
      }).join('');
      list.querySelectorAll<HTMLElement>('.fx-picker-item').forEach((li, i) => {
        if (i === sel) li.scrollIntoView({ block: 'nearest' });
        li.onclick = () => commit(filtered[+li.dataset.i!]);
      });
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.code === 'Escape') { ev.preventDefault(); this._closeFxPicker(); }
      else if (ev.code === 'ArrowDown') { ev.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); }
      else if (ev.code === 'ArrowUp') { ev.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (ev.code === 'Enter') { ev.preventDefault(); commit(filtered[sel]); }
    });
    input.addEventListener('input', () => { sel = 0; render(); });
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) this._closeFxPicker(); });
    this._fxPicker = overlay;
    render();
    input.focus();
  }

  // Status-bar buffer control: sets the pipeline's prebuffer depth live and shows
  // the resulting latency. Deeper buffer = fewer underruns, more latency.
  _bindBufferControl() {
    const input = $<HTMLInputElement>('prebuffer');
    if (!input) return;
    input.value = String(this.pipeline.prebufferBlocks);
    input.onchange = () => {
      const v = Math.max(2, Math.min(64, Math.round(+input.value) || this.pipeline.prebufferBlocks));
      input.value = String(v);
      this.pipeline.prebufferBlocks = v;
      this._updateLatencyDisplay();
    };
    this._updateLatencyDisplay();
  }

  _updateLatencyDisplay() {
    const el = $('latency-display');
    if (el) el.textContent = `· ~${Math.round(this.pipeline.bufferLatencyMs)} ms`;
  }

  // Make the sidebar follow automation each frame. fx-scope commands mutate the
  // real fxParams object, so those knobs just re-read it (also catches preset
  // loads). inst-scope commands write the live voice slot, so while playing we
  // show the engine's last applied value for the selected instance and fall back
  // to the stored base when stopped.
  _syncKnobs() {
    const playing = this.engine.playing;
    const instIdx = this.controls.selected;
    const instr = this.engine.instruments[instIdx];

    // While live-recording a param, leave the inst knobs alone — the drag owns
    // them. Otherwise the armed track is suppressed in _applyAutomation, so
    // autoLive freezes at a stale value and _extSet would fight the user's hand.
    if (instr && !this.engine._armedTrack) {
      for (const k of this.controls.paramKnobs || []) {
        const live = playing ? this.engine.autoLive.inst.get(`${instIdx}:${k.bank}:${k.i}`) : undefined;
        k.el._extSet?.(live !== undefined ? live : (instr as any)[k.bank!][k.i!]);
      }
      // Reflect the selected instance's fx (so fx-scope automation animates the knobs).
      if (this._fxPanelInst === instIdx && instr.fx) {
        const fp = instr.fx as unknown as Record<string, number>;
        for (const k of this._fxKnobs || []) k.el._extSet?.(fp[k.key]);
      }
    }
    
    if (playing) {
      const bpmInput = $<HTMLInputElement>('bpm');
      if (bpmInput && document.activeElement !== bpmInput) {
        if (Math.round(this.engine.bpm).toString() !== bpmInput.value) {
          bpmInput.value = Math.round(this.engine.bpm).toString();
        }
      }
    }
  }

  // Drive the L/R VU bars from the post-volume peak. Width maps 0..125% of full
  // scale (so the bar's 100% point lines up with the slider's), green up to
  // unity and red once it clips. Instant attack, smooth release.
  _drawVuMeters(lEl: HTMLElement | null, rEl: HTMLElement | null) {
    if (!lEl || !rEl) return;
    const [pl, pr] = (this.pipeline && this.pipeline.peaks) ? this.pipeline.peaks() : [0, 0];
    this._vuL = Math.max(pl, (this._vuL || 0) * 0.82);
    this._vuR = Math.max(pr, (this._vuR || 0) * 0.82);
    const apply = (el: HTMLElement, v: number) => {
      // Linear mapping matching the volume slider thumb's center offset at 100% volume (77.375% width)
      el.style.width = Math.min(100, v * 77.375) + '%';
      el.classList.toggle('clip', v > 1.0);
    };
    apply(lEl, this._vuL);
    apply(rEl, this._vuR);
  }

  _drawVisualizer() {
    const canvas = $<HTMLCanvasElement>('visualizer');
    if (!canvas) return;

    // Dynamically adjust drawing buffer width/height to match container client bounds
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(r.width * dpr);
    const targetH = Math.floor(r.height * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;

    if (W === 0 || H === 0) return; // avoid drawing when hidden or empty

    // Background
    ctx.fillStyle = '#030406';
    ctx.fillRect(0, 0, W, H);

    // Background grid lines (tech scope style)
    ctx.strokeStyle = 'rgba(45, 58, 82, 0.12)';
    ctx.lineWidth = 1;
    
    // Horizontal center line
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Vertical subdivisions
    ctx.beginPath();
    const divisions = 10;
    for (let x = W / divisions; x < W; x += W / divisions) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();

    // Get dynamic colors from css variables (cached; refreshed on select)
    const accentColor = themeVar('--accent', '#00f5d4');
    const accentGlow = themeVar('--accent-glow', 'rgba(0, 245, 212, 0.2)');

    // If audio is not active or engine is not playing, draw an animated idle wave
    if (!this.audioReady || !this.pipeline || !this.pipeline.analyser || !this.engine.playing) {
      ctx.strokeStyle = accentColor;
      ctx.shadowColor = accentColor;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      const time = Date.now() * 0.003;
      for (let x = 0; x < W; x++) {
        // Double sine wave overlay
        const y = H / 2 + Math.sin(x * 0.02 + time) * (H * 0.15) * Math.sin(x * 0.004);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      return;
    }

    const analyser = this.pipeline.analyser;
    const bufferLength = analyser.frequencyBinCount;

    // Reuse scratch buffers across frames (avoids per-frame GC churn at 60fps).
    if (!this._freqData || this._freqData.length !== bufferLength) {
      this._freqData = new Uint8Array(bufferLength);
      this._waveData = new Uint8Array(bufferLength);
    }

    // Draw spectrum as translucent glow fill using accent color
    const freqData = this._freqData!;
    analyser.getByteFrequencyData(freqData);

    ctx.fillStyle = accentGlow;
    ctx.beginPath();
    ctx.moveTo(0, H);
    const barWidth = W / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      const val = freqData[i] / 255.0;
      const heightVal = Math.pow(val, 1.2) * H * 0.85;
      const y = H - heightVal;
      ctx.lineTo(i * barWidth, y);
    }
    ctx.lineTo(W, H);
    ctx.fill();

    // Draw wave/oscilloscope using accent color
    const waveData = this._waveData!;
    analyser.getByteTimeDomainData(waveData);

    ctx.strokeStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 6;
    ctx.lineWidth = 2;
    ctx.beginPath();

    const sliceWidth = W / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = waveData[i] / 128.0;
      const y = v * (H / 2);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // reset shadow
  }

  _loop() {
    // Resolve the frame-loop's DOM targets once, not every animation frame.
    const playBtn = $('play');
    const playPatBtn = $('play-pattern');
    const perfStatus = $('perf-status');
    const orderListEl = $('arranger-order-list');
    const trackTimeEl = $('track-time');
    const vuLEl = $('vu-l');
    const vuREl = $('vu-r');

    const tick = () => {
      tickRecord(this);
      this.view.draw();
      this._drawVisualizer();
      this._syncKnobs();
      this._drawVuMeters(vuLEl, vuREl);

      // Reflect play/pause state in button class/text
      if (playBtn) {
        if (this.engine.playing && this.engine.playMode === 'song') {
          if (!playBtn.classList.contains('playing')) {
            playBtn.classList.add('playing');
            playBtn.innerHTML = PAUSE_ICON;
            playBtn.title = 'Pause';
          }
        } else {
          if (playBtn.classList.contains('playing')) {
            playBtn.classList.remove('playing');
            playBtn.innerHTML = PLAY_ICON;
            playBtn.title = 'Play';
            this._updatePatternSelector(); // sync back when song stops
          }
        }
      }

      if (playPatBtn) {
        if (this.engine.playing && this.engine.playMode === 'pattern') {
          if (!playPatBtn.classList.contains('playing')) {
            playPatBtn.classList.add('playing');
            playPatBtn.innerHTML = '⏸ Pause Pattern';
          }
        } else {
          if (playPatBtn.classList.contains('playing')) {
            playPatBtn.classList.remove('playing');
            playPatBtn.innerHTML = '🔁 Play Pattern';
          }
        }
      }

      // Update Arrangement Timeline slot highlights
      const activeOrderIdx = (this.engine.playing && this.engine.playMode === 'song') ? this.engine.displayOrder : -1;
      
      // When playing a song, update the pattern number display and length to match the active pattern in the timeline.
      if (this.engine.playing && this.engine.playMode === 'song' && this.engine.song) {
        const activePatIdx = this.engine.song.order[this.engine.displayOrder] ?? 0;
        const patNum = $('pat-num-display');
        if (patNum && patNum.textContent !== String(activePatIdx)) {
          patNum.textContent = String(activePatIdx);
          const activePat = this.engine.song.patterns[activePatIdx];
          const lenInput = $<HTMLInputElement>('pattern-len');
          if (lenInput && activePat) {
            lenInput.value = String(activePat.rows);
          }
        }
      }

      if (orderListEl) {
        const orderCards = orderListEl.querySelectorAll('.arranger-card');
        for (const card of orderCards) {
          const idx = parseInt(card.getAttribute('data-order-idx') ?? '-1', 10);
          if (idx === activeOrderIdx) {
            if (!card.classList.contains('active-order')) card.classList.add('active-order');
          } else {
            if (card.classList.contains('active-order')) card.classList.remove('active-order');
          }
        }
      }

      if (perfStatus) {
        perfStatus.textContent = this.audioReady ? `underruns: ${this.underruns}` : '';
      }

      if (trackTimeEl) {
        const spr = this.engine.secondsPerRow;
        const text = `${this._fmtTime(this._currentSongRow() * spr)} / ${this._fmtTime(this.engine.songRowCount() * spr)}`;
        if (trackTimeEl.textContent !== text) trackTimeEl.textContent = text;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _deletePattern(idx: number) {
    const song = this.engine.song;
    if (!song || song.patterns.length <= 1) return;

    song.patterns.splice(idx, 1);

    const newOrder: number[] = [];
    for (let i = 0; i < song.order.length; i++) {
      const patIdx = song.order[i];
      if (patIdx === idx) {
        continue;
      } else if (patIdx > idx) {
        newOrder.push(patIdx - 1);
      } else {
        newOrder.push(patIdx);
      }
    }
    if (newOrder.length === 0) {
      newOrder.push(0);
    }
    song.order = newOrder;
    
    if (this.engine.currentPatternIdx >= song.patterns.length) {
      this.engine.currentPatternIdx = song.patterns.length - 1;
    }

    this.markDirty('pattern');
    this._renderSongEditor();
    this._updatePatternSelector();
    this.view.draw();
  }

  _renderSongEditor() {
    renderArranger(this);
    this._populateSongMeta();
    this._songVolumeKnob?._extSet?.(this.engine.songMaster);   // reflect the loaded song's volume
    this._buildLfoUI();   // rebuild (target options depend on the instrument table)
  }

  // Reflect the current song's metadata into the Song Info fields (without
  // clobbering a field the user is actively typing in).
  _populateSongMeta() {
    const title = $<HTMLInputElement>('song-title');
    const author = $<HTMLInputElement>('song-author');
    const note = $<HTMLTextAreaElement>('song-note');
    const titleVal = this.songDisplayName();
    if (title && document.activeElement !== title) title.value = titleVal;
    if (author && document.activeElement !== author) author.value = this.songAuthor;
    if (note && document.activeElement !== note) note.value = this.songNote;
  }

  // Add a new blank pattern, matching the current pattern's length, and select it.
  _addPattern() {
    const song = this.engine.song;
    if (!song) return;
    const cur = this.view.pattern;
    song.patterns.push(new Pattern(cur ? cur.rows : 64, cur ? cur.channels : 8));
    this.engine.currentPatternIdx = song.patterns.length - 1;
    song.order.push(this.engine.currentPatternIdx);
    this.markDirty('pattern');
    this.markDirty('order');
    this._renderSongEditor();
    this._updatePatternSelector();
    this.view.draw();
  }

  // Duplicate the current pattern (cells + automation) as a new pattern, selected.
  _duplicatePattern() {
    const song = this.engine.song;
    if (!song) return;
    const src = song.patterns[this.engine.currentPatternIdx];
    if (!src) return;
    const dup = new Pattern(src.rows, src.channels);
    dup.notes.set(src.notes);
    dup.inst.set(src.inst);
    dup.vol.set(src.vol);
    dup.fxCmd.set(src.fxCmd);
    dup.fxVal.set(src.fxVal);
    dup.autoTracks = src.autoTracks.map((t) => ({
      targetScope: t.targetScope,
      targetInstIdx: t.targetInstIdx,
      targetParamId: t.targetParamId,
      data: new Int16Array(t.data),
    }));
    song.patterns.push(dup);
    this.engine.currentPatternIdx = song.patterns.length - 1;
    song.order.push(this.engine.currentPatternIdx);
    this.markDirty('pattern');
    this.markDirty('order');
    this._renderSongEditor();
    this._updatePatternSelector();
    this.view.draw();
  }

  _updatePatternSelector() {
    this.view.clampCursor();   // track/row counts vary per pattern — keep the cursor valid
    const patNum = $('pat-num-display');
    if (patNum) {
      patNum.textContent = String(this.engine.currentPatternIdx);
    }
    const lenInput = $<HTMLInputElement>('pattern-len');
    if (lenInput && this.view.pattern) {
      lenInput.value = String(this.view.pattern.rows);
    }
  }

  // The current position on the song timeline, as a row index.
  //  - playing a song: the live playhead (order slot + local row);
  //  - otherwise: the editor pattern's FIRST occurrence in the order, offset by
  //    the cursor row (or the playhead row when auditioning a single pattern).
  _currentSongRow() {
    const eng = this.engine, song = eng.song;
    if (!song) return 0;
    const order = song.order;

    if (eng.playing && eng.playMode === 'song') {
      let row = 0;
      for (let i = 0; i < eng.displayOrder; i++) {
        const pat = song.patterns[order[i]];
        if (pat) row += pat.rows;
      }
      return row + eng.displayRow;
    }

    const patIdx = eng.currentPatternIdx;
    const localRow = (eng.playing && eng.playMode === 'pattern') ? eng.displayRow : this.view.cursor.row;
    let row = 0, found = false;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === patIdx) { found = true; break; }
      const pat = song.patterns[order[i]];
      if (pat) row += pat.rows;
    }
    return (found ? row : 0) + localRow;
  }

  // Seconds → "m:ss".
  _fmtTime(sec: number) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}

// Auto-start on the real app page; skip when imported by a test harness.
if (document.getElementById('grid')) {
  try {
    new App();
  } catch (err) {
    $('gl-status').innerHTML = `gl: <span class="err">${err instanceof Error ? err.message : String(err)}</span>`;
    console.error(err);
  }
}
