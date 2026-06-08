// App entry: builds the GL renderer + audio pipeline + tracker engine + UI and
// wires keyboard/transport. Audio is created lazily on the first user gesture
// (browser autoplay policy), so the grid is interactive before any sound.
import { createGL } from './gl/context.js';
import { SynthRenderer } from './gl/synth-renderer.js';
import { defaultFxParams, normalizeFxOrder } from './gl/effects.js';
import { AudioPipeline } from './audio/pipeline.js';
import { Engine } from './tracker/engine.js';
import { TrackerView } from './ui/tracker-view.js';
import { Controls, bindKnob } from './ui/controls.js';
import { DEMO_SONGS, loadSongInstruments, instrumentsFromParams } from './tracker/song.js';
import { serializeSong, deserializeSong, patternFromSerialized, instrumentSpecs } from './tracker/song-io.js';
import type { SerializedSong } from './tracker/song-io.js';
import { History } from './tracker/history.js';
import { SongStore } from './tracker/song-store.js';
import { instGlow, DEFAULT_MASTER } from './constants.js';
import { byType } from './instruments/index.js';
import { EMPTY, OFF, Pattern } from './tracker/pattern.js';
import { fxByKey } from './tracker/fx.js';
import { targetsForType, TARGETS } from './tracker/automation.js';
import { LFO_SHAPES, LFO_SHAPE_WAVETABLE, MAX_ROUTINGS, defaultRouting } from './tracker/lfo.js';
import { WT_BANKS } from './instruments/wavetables.js';
import { showExportDialog } from './audio/export.js';
import { renderArranger } from './ui/arranger.js';
import { invalidateTheme, themeVar } from './ui/theme.js';
import { initHelp } from './ui/help.js';
import pkg from '../package.json';
import type { ParamTarget } from './types.js';

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

// Lower keyboard row → semitone offset within the current octave.
const KEY_SEMI: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
};
// For 808, keys select drum slots rather than pitches.
const DRUM_KEYS = [36, 38, 42, 46, 39, 41, 45, 48, 56];

// FX panel layout: category headers (with bypass toggle) interleaved with knob
// rows. Ordered to follow the signal-flow chain (see DEFAULT_FX_ORDER in
// effects.js). Static, so it lives at module scope rather than rebuilt per call.
interface FxDef {
  category?: string;
  fxKey?: string;                   // registry effect key (category rows) — for reordering
  enableKey?: string;
  label?: string;
  key?: string;
  min?: number;
  max?: number;
  step?: number;
  log?: boolean;                    // logarithmic knob (e.g. Crush Hz)
  fmt?: (v: number) => string;      // custom value label (e.g. "Off" at the max)
}

// Knob labels intentionally drop the effect-name prefix — they sit under their
// category header, so "Mix"/"Rate"/etc. are unambiguous (and repeat per effect).
const FX_DEFS: FxDef[] = [
  { category: 'Distortion', fxKey: 'distortion', enableKey: 'distOn' },
  { label: 'Drive', key: 'dist', min: 0.001, max: 20, step: 0.1 },
  { label: 'Tone', key: 'tone', min: 0, max: 1, step: 0.01 },
  { label: 'Level', key: 'level', min: 0, max: 2, step: 0.01 },

  { category: 'Overdrive', fxKey: 'overdrive', enableKey: 'odOn' },
  { label: 'Drive', key: 'odDrive', min: 1, max: 30, step: 0.1, log: true },
  { label: 'Tone', key: 'odTone', min: 0, max: 1, step: 0.01 },
  { label: 'Level', key: 'odLevel', min: 0, max: 1.5, step: 0.01 },

  { category: 'Filter', fxKey: 'filter', enableKey: 'filterOn' },
  { label: 'Cutoff', key: 'filterCutoff', min: 20, max: 18000, step: 1, log: true,
    fmt: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '' },
  { label: 'Reso', key: 'filterReso', min: 0, max: 1, step: 0.01 },
  { label: 'Mode', key: 'filterMode', min: 0, max: 2, step: 1, fmt: (v) => ['LP', 'HP', 'BP'][Math.round(v)] ?? 'LP' },
  { label: 'Mix', key: 'filterMix', min: 0, max: 1, step: 0.01 },

  { category: 'Compressor', fxKey: 'compressor', enableKey: 'compOn' },
  { label: 'Thresh', key: 'compThresh', min: -60, max: 0, step: 0.5, fmt: (v) => v.toFixed(1) + 'dB' },
  { label: 'Ratio', key: 'compRatio', min: 1, max: 20, step: 0.1, log: true, fmt: (v) => v.toFixed(1) + ':1' },
  { label: 'Attack', key: 'compAttack', min: 0.1, max: 100, step: 0.1, log: true, fmt: (v) => v.toFixed(1) + 'ms' },
  { label: 'Release', key: 'compRelease', min: 5, max: 500, step: 1, log: true, fmt: (v) => Math.round(v) + 'ms' },
  { label: 'Makeup', key: 'compMakeup', min: 0, max: 24, step: 0.5, fmt: (v) => v.toFixed(1) + 'dB' },

  { category: 'Stereo Chorus', fxKey: 'chorus', enableKey: 'chorusOn' },
  { label: 'Mix', key: 'chorusMix', min: 0, max: 1, step: 0.01 },
  { label: 'Rate', key: 'chorusRate', min: 0.1, max: 5.0, step: 0.05 },
  { label: 'Depth', key: 'chorusDepth', min: 0.5, max: 5.0, step: 0.1 },

  { category: 'Stereo Tremolo (Auto-Pan)', fxKey: 'tremolo', enableKey: 'tremoloOn' },
  { label: 'Mix', key: 'tremoloMix', min: 0, max: 1, step: 0.01 },
  { label: 'Rate', key: 'tremoloRate', min: 0.5, max: 15.0, step: 0.1 },

  { category: 'Delay', fxKey: 'delay', enableKey: 'delayOn' },
  { label: 'Time', key: 'delayTime', min: 0.02, max: 1.2, step: 0.01 },
  { label: 'Feedback', key: 'delayFeedback', min: 0, max: 0.9, step: 0.01 },
  { label: 'Mix', key: 'delayMix', min: 0, max: 1, step: 0.01 },

  { category: 'Reverb', fxKey: 'reverb', enableKey: 'reverbOn' },
  { label: 'Decay', key: 'reverbDecay', min: 0, max: 0.97, step: 0.01 },
  { label: 'Damp', key: 'reverbDamp', min: 0, max: 0.95, step: 0.01 },
  { label: 'Mix', key: 'reverbMix', min: 0, max: 1, step: 0.01 },

  { category: 'Bitcrusher', fxKey: 'bitcrush', enableKey: 'bitcrushOn' },
  { label: 'Bits', key: 'bitcrushBits', min: 4, max: 33, step: 1, fmt: (v) => v >= 33 ? 'Off' : String(Math.round(v)) },
  { label: 'Hz', key: 'bitcrushRate', min: 100, max: 48000, step: 100, log: true,
    fmt: (v) => v >= 48000 ? 'Off' : (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '') },
  { label: 'Mix', key: 'bitcrushMix', min: 0, max: 1, step: 0.01 },

  { category: 'Stereo Field', fxKey: 'width', enableKey: 'widthOn' },
  { label: 'Width', key: 'width', min: 0, max: 2, step: 0.01 },

  { category: 'Limiter', fxKey: 'limiter', enableKey: 'limitOn' },
  { label: 'Ceiling', key: 'limitCeil', min: -24, max: 0, step: 0.1, fmt: (v) => v.toFixed(1) + 'dB' },
  { label: 'Release', key: 'limitRelease', min: 5, max: 500, step: 1, log: true, fmt: (v) => Math.round(v) + 'ms' },
];

// One reorderable chain block: a category header + its knob rows, keyed by the
// registry effect key. Derived once from FX_DEFS; the FX panel renders these in the
// selected instance's fxOrder so the displayed chain matches the audio chain.
interface FxGroup { fxKey: string; category: string; enableKey?: string; knobs: FxDef[] }
const FX_GROUPS: FxGroup[] = [];
for (const d of FX_DEFS) {
  if (d.category) FX_GROUPS.push({ fxKey: d.fxKey!, category: d.category, enableKey: d.enableKey, knobs: [] });
  else FX_GROUPS[FX_GROUPS.length - 1]?.knobs.push(d);
}
const FX_GROUP_BY_KEY: Record<string, FxGroup> = Object.fromEntries(FX_GROUPS.map((g) => [g.fxKey, g]));

// A knob <div> the UI loop drives externally (see bindKnob in controls.ts).
type KnobEl = HTMLElement & { _extSet?: (v: number) => void };
// One copied tracker cell.
// A copied cell is either a note cell (note/inst/vol) or an automation-track
// cell (`auto` = the row's Int16 value). `auto === undefined` discriminates.
type ClipCell = { note: number; inst: number; vol: number; fxCmd?: number; fxVal?: number; auto?: number };

// Which document is open: a built-in demo (by index) or a saved user song (by id).
type CurrentSong = { kind: 'demo'; demoIdx: number } | { kind: 'user'; id: string };

// markDirty tags that count as a "content" edit (touch patterns / the instrument set
// / order / metadata) — the trigger for forking a demo into an editable user copy.
// Everything else is a "tweak" (knobs, fx params, bpm, master, pan, LFO) which is
// undoable but doesn't, on its own, fork a demo or persist.
const CONTENT_TAGS = new Set([
  'note', 'clear', 'volnudge', 'autocell', 'editval', 'fx', 'cut', 'paste',
  'pattern', 'order', 'resize', 'autotrack', 'instrument', 'midicc', 'meta',
]);

export class App {
  gl: WebGL2RenderingContext;
  engine: Engine;
  currentSong: CurrentSong;
  store = new SongStore();
  _autosaveTimer?: ReturnType<typeof setTimeout>;
  _storageWarned = false;
  pipeline: AudioPipeline;
  renderer: SynthRenderer | null;
  audioReady: boolean;
  underruns: number;
  view: TrackerView;
  controls: Controls;
  held: Map<string, number>;
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
        if (!instr) {
          document.documentElement.style.setProperty('--accent', '#00f0ff');
          document.documentElement.style.setProperty('--accent-glow', 'rgba(0, 240, 255, 0.2)');
          document.documentElement.style.setProperty('--cursor-border', '#00f0ff');
          invalidateTheme();
          return;
        }

        // FX is per instrument INSTANCE — the panel edits the selected one's chain.
        this._buildFxPanel();

        // Theme the UI accent with this instance's colour.
        document.documentElement.style.setProperty('--accent', instr.color);
        document.documentElement.style.setProperty('--accent-glow', instGlow(instr.color, 0.2));
        document.documentElement.style.setProperty('--cursor-border', instr.color);
        invalidateTheme();
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
    this._bindKeys();
    this._bindBufferControl();
    initHelp();
    this._initMidi();
    this._loop();

    // Grid gestures that commit an edit (pan drag, auto-track removal) live in the
    // view, not a handler here — route them through markDirty.
    this.view.onEdit = (tag = 'edit') => this.markDirty(tag);
    // Seed undo history with the initial document.
    this._seedHistory();

    // Flush a pending autosave when the tab is hidden or closed (so the last edits
    // to a user song survive even if the debounce timer hasn't fired yet).
    window.addEventListener('beforeunload', () => this._autosaveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._autosaveNow();
    });

    this.pipeline.onStats = (s) => { this.underruns = s.underruns; };
    setInterval(() => { if (this.audioReady) this.pipeline.requestStats(); }, 500);
  }

  async ensureAudio() {
    if (this.audioReady) return;
    const sr = await this.pipeline.init();
    this.engine.sampleRate = sr;
    this._updateLatencyDisplay();   // now reflects the real sample rate
    this.renderer = new SynthRenderer(this.gl, sr);
    this._syncRendererFx();   // hand the renderer this song's per-instance fx
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

  _initMidi() {
    if ((navigator as any).requestMIDIAccess) {
      (navigator as any).requestMIDIAccess().then((midiAccess: any) => {
        const attachInputs = () => {
          for (const input of midiAccess.inputs.values()) {
            input.onmidimessage = (msg: any) => this._onMidiMessage(msg);
          }
        };
        attachInputs();
        midiAccess.onstatechange = attachInputs;
        const ms = $('midi-status');
        if (ms) ms.innerHTML = `midi: <span class="ok">connected</span>`;
      }).catch((e: any) => {
        console.warn("MIDI disabled", e);
        const ms = $('midi-status');
        if (ms) ms.innerHTML = `midi: <span class="err">failed</span>`;
      });
    } else {
      const ms = $('midi-status');
      if (ms) ms.innerHTML = `midi: <span class="err">unsupported</span>`;
    }
  }

  _onMidiMessage(msg: any) {
    if (!msg.data) return;
    const status = msg.data[0] & 0xf0;
    const data1 = msg.data[1];
    const data2 = msg.data.length > 2 ? msg.data[2] : 0;

    if (status === 0xb0) { // CC
      const cc = data1;
      const val = data2; // 0-127
      const instIdx = this.controls.selected;
      const instr = this.engine.instruments[instIdx];
      if (!instr) return;
      
      // CC→target map: knobs at CC70+ and CC1+ both index into the engine's
      // target list (CC70 or CC1 → target 0, …), so either common controller
      // layout works. CC0 (bank select) falls through to a negative index → ignored.
      const targets = targetsForType(instr.type);
      const targetIdx = cc >= 70 ? cc - 70 : cc - 1;
      const target = targets[targetIdx];
      if (!target) return;
      
      const val255 = (val << 1) | (val >> 6);

      // 1. Apply it live to the engine
      this.engine.applyAutomationLive(target, instIdx, this.view.cursor.ch, val255);

      // 2. If recording is enabled, write it to the pattern
      if (this._recordEnabled) {
        const row = this.engine.playing ? this.engine.displayRow : this.view.cursor.row;
        const curCh = this.view.cursor.ch;
        const patIdx = this.engine.currentPatternIdx;
        const p = this.engine.song?.patterns[patIdx];
        if (p) {
          // Record into the AutoTrack for this target, creating it if absent (so a
          // CC tweak always lands somewhere). The track's targetInstIdx depends on
          // scope: global → null, chan → the cursor channel it pans, inst/fx → the
          // selected instrument instance.
          const trackInst = target.scope === 'global' ? null
                          : target.scope === 'chan'   ? curCh
                          : instIdx;
          const before = p.autoTracks.length;
          const data = p.getOrCreateAutoTrack(trackInst, target.id);
          if (row >= 0 && row < data.length) data[row] = val255;
          this.markDirty('midicc', true);   // streamed CC → coalesce into one step
          if (p.autoTracks.length !== before) this.view._resize();  // new track widens the grid
          this.view.draw();
        }
      }
    } else if (status === 0x90 && data2 > 0) { // Note On
      const note = data1;
      const instIdx = this.controls.selected;
      
      this.ensureAudio().then(() => {
        const voice = this.engine.previewNote(instIdx, note, data2 / 127.0);
        this.held.set(`midi-${note}`, voice);
      });
      
      if (this._recordEnabled) {
        const row = this.engine.playing ? this.engine.displayRow : this.view.cursor.row;
        const curCh = this.view.cursor.ch;
        const patIdx = this.engine.currentPatternIdx;
        const p = this.engine.song?.patterns[patIdx];
        if (p) {
          if (curCh < p.channels) {
            p.set(row, curCh, note, instIdx, data2 / 127.0);
            this.markDirty('note');
            if (!this.engine.playing) {
               this._advanceCursorRow();
            }
          }
          this.view.draw();
        }
      }
    } else if (status === 0x80 || (status === 0x90 && data2 === 0)) { // Note Off
      const note = data1;
      const key = `midi-${note}`;
      if (this.held.has(key)) {
        this.engine.previewOff(this.held.get(key)!);
        this.held.delete(key);
      }
    }
  }

  // Hand the renderer the current per-instance fx (array indexed by instance), called
  // after any instrument-table or fx change. The renderer reads each instance.fx by
  // reference, so live knob edits are picked up without re-calling this.
  _syncRendererFx() {
    this.renderer?.setInstrumentFx(this.engine.instruments.map((i) => i.fx));
    this.renderer?.setInstrumentFxOrder(this.engine.instruments.map((i) => i.fxOrder));
  }

  _buildFxPanel() {
    const host = $('fx');
    host.innerHTML = '';
    this._fxKnobs = [];
    const idx = this.controls.selected;
    this._fxPanelInst = idx;
    const instr = this.engine.instruments[idx];
    if (!instr) return;                       // nothing selected (e.g. blank New song)
    const params = instr.fx as unknown as Record<string, number | boolean>;

    // Output level — its own section above the (collapsible) effects chain, since it
    // isn't a bypassable effect. Always shown, regardless of the master FX toggle.
    const outHost = $('fx-output');
    outHost.innerHTML = '';
    {
      const block = document.createElement('div');
      block.className = 'param-control-block';
      const label = document.createElement('label');
      label.textContent = 'Level';
      block.appendChild(label);
      const wrapper = document.createElement('div');
      wrapper.className = 'knob-wrapper';
      const knob = document.createElement('div');
      knob.className = 'knob';
      wrapper.appendChild(knob);
      const valSpan = document.createElement('span');
      valSpan.className = 'knob-value';
      wrapper.appendChild(valSpan);
      block.appendChild(wrapper);
      outHost.appendChild(block);
      if (params.master === undefined) params.master = 1.0;
      bindKnob(knob, valSpan, 0, 2, 0.01, params.master as number, false, (v) => { params.master = v; },
        null, () => this.markDirty('fxknob'));
      this._fxKnobs.push({ el: knob, key: 'master' });
    }

    // Master FX bypass (#fx-toggle lives outside #fx). When off, collapse the whole
    // panel — just the master toggle remains. Toggling re-renders so it expands again.
    const toggle = $('fx-toggle');
    toggle.className = params.enabled ? 'on' : '';
    toggle.textContent = params.enabled ? 'on' : 'off';
    toggle.onclick = () => { params.enabled = !params.enabled; this.markDirty('fx-enable'); this._buildFxPanel(); };
    if (!params.enabled) return;

    // Render the chain in the INSTANCE's order (normalized against the registry), so
    // the panel mirrors the audio chain. ▲▼ on each header reorders this instance.
    const order = normalizeFxOrder(instr.fxOrder);
    const reorder = (from: number, to: number) => {
      if (to < 0 || to >= order.length) return;
      const next = order.slice();
      const [m] = next.splice(from, 1); next.splice(to, 0, m);
      instr.fxOrder = next;            // persist on the instance
      this.markDirty('fx-order');
      this._buildFxPanel();
      this._syncRendererFx();          // push the new order to the renderer
    };

    const renderKnob = (d: FxDef) => {
      const key = d.key!, min = d.min!, max = d.max!, step = d.step!;
      if (params[key] === undefined) {
        if (key === 'bitcrushBits') params[key] = 8.0;
        else if (key === 'bitcrushRate') params[key] = 4000.0;
        else params[key] = min;
      }
      const block = document.createElement('div');
      block.className = 'param-control-block';
      const label = document.createElement('label');
      label.textContent = d.label ?? '';
      block.appendChild(label);
      const wrapper = document.createElement('div');
      wrapper.className = 'knob-wrapper';
      const knob = document.createElement('div');
      knob.className = 'knob';
      wrapper.appendChild(knob);
      const valSpan = document.createElement('span');
      valSpan.className = 'knob-value';
      wrapper.appendChild(valSpan);
      block.appendChild(wrapper);
      host.appendChild(block);
      const isPercent = min === 0 && max === 1 && step < 1;
      bindKnob(knob, valSpan, min, max, step, params[key] as number, isPercent, (v) => {
        params[key] = v;
      }, d.fmt ?? null, () => this.markDirty('fxknob'), d.log ?? false);
      this._fxKnobs.push({ el: knob, key });
    };

    order.forEach((fxKey, pos) => {
      const g = FX_GROUP_BY_KEY[fxKey];
      if (!g) return;
      const cat = document.createElement('h3');
      cat.textContent = g.category;

      // Move up/down within the chain.
      const moves = document.createElement('span');
      moves.className = 'fx-cat-move';
      const up = document.createElement('button');
      up.className = 'fx-move-btn'; up.textContent = '▲'; up.title = 'move earlier in chain';
      up.disabled = pos === 0;
      up.onclick = () => reorder(pos, pos - 1);
      const dn = document.createElement('button');
      dn.className = 'fx-move-btn'; dn.textContent = '▼'; dn.title = 'move later in chain';
      dn.disabled = pos === order.length - 1;
      dn.onclick = () => reorder(pos, pos + 1);
      moves.appendChild(up); moves.appendChild(dn);
      cat.appendChild(moves);

      let catOn = true;
      if (g.enableKey) {
        const ek = g.enableKey;
        if (params[ek] === undefined) {
          params[ek] = (ek === 'bitcrushOn' || ek === 'odOn' || ek === 'filterOn' || ek === 'compOn' || ek === 'limitOn') ? false : true;
        }
        catOn = params[ek] !== false;
        const btn = document.createElement('button');
        btn.className = 'fx-cat-toggle' + (catOn ? ' on' : '');
        btn.textContent = catOn ? 'on' : 'off';
        btn.onclick = () => { params[ek] = (params[ek] === false); this.markDirty('fx-enable'); this._buildFxPanel(); };
        cat.appendChild(btn);
      }
      host.appendChild(cat);
      if (catOn) for (const d of g.knobs) renderKnob(d);   // effect off → hide its knobs
    });
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
      recordBtn.onclick = () => {
        this._recordEnabled = !this._recordEnabled;
        if (this._recordEnabled) recordBtn.classList.add('playing');
        else recordBtn.classList.remove('playing');
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
    this._initSongPicker();

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
    const contentPat = $('pattern-editor-content');
    const contentSong = $('song-arranger-content');
    
    if (tabPat && tabSong && contentPat && contentSong) {
      tabPat.onclick = () => {
        tabPat.classList.add('active');
        tabSong.classList.remove('active');
        contentPat.style.display = 'flex';
        contentSong.style.display = 'none';
        
        // Force resize and redraw of the pattern view
        this.view._resize();
        this.view.draw();
      };
      
      tabSong.onclick = () => {
        tabSong.classList.add('active');
        tabPat.classList.remove('active');
        contentSong.style.display = 'flex';
        contentPat.style.display = 'none';
        
        // Render song editor DOM
        this._renderSongEditor();
      };
    }

    const newSongBtn = $('new-song-btn');
    if (newSongBtn) {
      newSongBtn.onclick = () => {
        this._autosaveNow();              // flush any pending edit on the outgoing song
        this.engine.stop();
        // A blank song is its own user record from the start (so it never replaces
        // another, even after repeated News, and autosaves immediately).
        this.customSongName = this._uniqueUntitled();
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

    const exportBtn = $('export');
    if (exportBtn) {
      exportBtn.onclick = () => showExportDialog(this);
    }
  }

  // The current song's display name: an explicit user title, else the demo's name.
  songDisplayName(): string {
    if (this.customSongName) return this.customSongName;
    if (this.currentSong.kind === 'demo') return DEMO_SONGS[this.currentSong.demoIdx]?.name ?? 'Untitled';
    return 'Untitled';
  }

  // Capture the WHOLE editable document as a portable, self-contained object — the
  // single source of truth for Save (→ file), undo/redo (→ history) and autosave
  // (→ localStorage). Returns null when there's no song loaded.
  _snapshot(): SerializedSong | null {
    const eng = this.engine;
    if (!eng.song) return null;
    const name = this.songDisplayName();
    return serializeSong({
      name,
      author: this.songAuthor,
      note: this.songNote,
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
  _seedHistory() {
    const snap = this._snapshot();
    if (snap) this.history.reset(snap);
    this._histTag = '';
    this._histTime = 0;
    this._refreshUndoUI();
  }

  // Record that the document changed. `tag` names the gesture; pass `coalesce` for
  // streaming gestures (knob drag, two-digit entry) so a burst folds into one undo
  // step rather than dozens. No-ops while a restore is applying (its mutations are
  // the undo itself, not new edits).
  markDirty(tag = 'edit', coalesce = false) {
    if (this._restoring) return;
    const snap = this._snapshot();
    if (!snap) return;
    const now = performance.now();
    if (coalesce && this._histTag === tag && now - this._histTime < 450) {
      this.history.replacePresent(snap);
    } else {
      this.history.push(snap);
    }
    this._histTag = tag;
    this._histTime = now;
    this._refreshUndoUI();

    // Persistence lifecycle. A user song autosaves; a demo forks into an editable
    // user copy on the FIRST content edit (tweaks alone don't fork or persist).
    if (this.currentSong.kind === 'user') {
      this._scheduleAutosave();
    } else if (CONTENT_TAGS.has(tag)) {
      this._forkDemo();
    }
  }

  // Demo → "<name> (edit)" user song on first content edit. Mints a record, switches
  // identity to it, persists immediately, and refreshes the picker. The original demo
  // stays in the list; undo history (already recorded) is unaffected.
  _forkDemo() {
    if (this.currentSong.kind === 'demo') {
      const demoName = DEMO_SONGS[this.currentSong.demoIdx]?.name ?? 'Untitled';
      // Honour a title the user typed; otherwise tag the copy "(edit)".
      if (!this.customSongName || this.customSongName === demoName) {
        this.customSongName = `${demoName} (edit)`;
      }
      this.currentSong = { kind: 'user', id: this.store.createId() };
    }
    this._autosaveNow();
    this._buildSongPicker();
  }

  // Debounced autosave for the active user song (coalesces a burst of edits).
  _scheduleAutosave() {
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => { this._autosaveTimer = undefined; this._autosaveNow(); }, 1500);
  }

  // Write the active user song to storage now (also called on fork + page hide).
  _autosaveNow() {
    if (this._autosaveTimer) { clearTimeout(this._autosaveTimer); this._autosaveTimer = undefined; }
    if (this.currentSong.kind !== 'user') return;
    const snap = this._snapshot();
    if (!snap) return;
    const res = this.store.save(this.currentSong.id, snap);
    if (!res.ok && !this._storageWarned) {
      this._storageWarned = true;
      console.warn('Autosave failed:', res.error);
      const status = $('audio-status');
      if (status && res.error) status.title = `Autosave: ${res.error}`;
    }
  }

  // ── Song picker (custom dropdown: saved user songs + demos, colours + delete) ──
  _initSongPicker() {
    const btn = $('song-picker-btn');
    if (btn) btn.onclick = (e) => { e.stopPropagation(); this._toggleSongMenu(); };
    // Dismiss on an outside click or Escape.
    document.addEventListener('mousedown', (e) => {
      const root = $('song-picker'), menu = $('song-picker-menu');
      if (menu && !menu.hidden && root && !root.contains(e.target as Node)) this._closeSongMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.code === 'Escape') this._closeSongMenu(); });
    this._buildSongPicker();
  }

  _toggleSongMenu() {
    const menu = $('song-picker-menu');
    const btn = $('song-picker-btn');
    if (!menu) return;
    if (menu.hidden) {
      this._buildSongPicker();
      // Position the fixed menu under the trigger (it's fixed so the LCD panel's
      // overflow:hidden can't clip it).
      if (btn) { const r = btn.getBoundingClientRect(); menu.style.left = `${Math.round(r.left - 8)}px`; menu.style.top = `${Math.round(r.bottom + 8)}px`; }
      menu.hidden = false;
      btn?.setAttribute('aria-expanded', 'true');
    } else this._closeSongMenu();
  }

  _closeSongMenu() {
    const menu = $('song-picker-menu');
    if (menu) menu.hidden = true;
    $('song-picker-btn')?.setAttribute('aria-expanded', 'false');
  }

  // Refresh the trigger label + rebuild the menu rows (user songs first, then demos).
  _buildSongPicker() {
    const label = $('song-picker-current');
    if (label) label.textContent = this.songDisplayName();
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
      r.onclick = () => { this._closeSongMenu(); o.onClick(); };
      if (o.onDelete) {
        const del = document.createElement('button');
        del.className = 'song-del'; del.textContent = '🗑'; del.title = 'Delete this saved song';
        del.onclick = (e) => { e.stopPropagation(); o.onDelete!(); };
        r.appendChild(del);
      }
      menu.appendChild(r);
    };

    const users = this.store.list();
    if (users.length) {
      group('MY SONGS');
      for (const m of users) row({
        name: m.name, color: m.color || '#7d8aa0',
        active: this.currentSong.kind === 'user' && this.currentSong.id === m.id,
        onClick: () => this._loadUserSong(m.id),
        onDelete: () => this._deleteUserSong(m.id, m.name),
      });
    }
    group('DEMOS');
    const demos = DEMO_SONGS.map((s, i) => ({ s, i })).sort((a, b) => a.s.name.localeCompare(b.s.name));
    for (const { s, i } of demos) row({
      name: s.name, color: '#5a6b86',   // a uniform muted dot marks demos vs. vivid user colours
      active: this.currentSong.kind === 'demo' && this.currentSong.demoIdx === i,
      onClick: () => this._loadDemo(i),
    });
  }

  // Load a built-in demo (resets to a fresh, pruned instrument table).
  _loadDemo(idx: number) {
    const songDef = DEMO_SONGS[idx];
    if (!songDef) return;
    this._autosaveNow();                 // flush any pending edit on the outgoing song
    this.customSongName = null;
    this.currentSong = { kind: 'demo', demoIdx: idx };
    this.songAuthor = songDef.author ?? '';
    this.songNote = songDef.note ?? '';
    const bpmInput = $<HTMLInputElement>('bpm');
    if (bpmInput) bpmInput.value = String(songDef.bpm);
    this.engine.bpm = songDef.bpm;
    const loaded = loadSongInstruments(songDef);
    this.engine.instruments = loaded.instruments;
    this._syncRendererFx();

    const wasPlaying = this.engine.playing;
    this.engine.stop();
    this.engine.loadSong(loaded.data);
    this.engine.currentPatternIdx = 0;

    this.controls.selected = 0;
    this.controls.select(0);
    this.view.cursor.row = 0; this.view.cursor.ch = 0; this.view.selection = null; this.view.scroll = 0;
    const lenInput = $<HTMLInputElement>('pattern-len');
    if (lenInput) lenInput.value = String(this.view.pattern.rows);
    this.view.draw();
    this._renderSongEditor();
    this._updatePatternSelector();
    if (wasPlaying) this.engine.play();
    this._seedHistory();
    this._buildSongPicker();
  }

  // Open a saved user song from storage.
  _loadUserSong(id: string) {
    const doc = this.store.load(id);
    if (!doc) { this._buildSongPicker(); return; }   // vanished/corrupt → just refresh the list
    this._autosaveNow();                             // flush the outgoing song first
    this.currentSong = { kind: 'user', id };
    this._applySerializedSong(doc);
  }

  // Delete a saved user song; if it's the one open, fall back to the default demo.
  _deleteUserSong(id: string, name: string) {
    if (!confirm(`Delete saved song "${name}"? This can't be undone.`)) return;
    const isOpen = this.currentSong.kind === 'user' && this.currentSong.id === id;
    if (isOpen && this._autosaveTimer) { clearTimeout(this._autosaveTimer); this._autosaveTimer = undefined; }
    this.store.delete(id);
    if (isOpen) {
      // Switch identity OFF the deleted song BEFORE the fallback load, so its
      // autosave-flush can't resurrect what we just removed.
      this.currentSong = { kind: 'demo', demoIdx: 0 };
      const found = DEMO_SONGS.findIndex((s) => s.name === 'Antiseptik USA');
      this._loadDemo(found !== -1 ? found : 0);
    } else {
      this._buildSongPicker();
    }
  }

  // A non-colliding "Untitled" / "Untitled N" name for a freshly created song.
  _uniqueUntitled(): string {
    const taken = new Set(this.store.list().map((m) => m.name));
    if (!taken.has('Untitled')) return 'Untitled';
    for (let n = 2; ; n++) { const c = `Untitled ${n}`; if (!taken.has(c)) return c; }
  }

  _undo() {
    const doc = this.history.undo();
    if (doc) this._restoreSnapshot(doc);
    this._refreshUndoUI();
  }

  _redo() {
    const doc = this.history.redo();
    if (doc) this._restoreSnapshot(doc);
    this._refreshUndoUI();
  }

  // Enable/disable the Undo/Redo buttons to match availability.
  _refreshUndoUI() {
    const u = $<HTMLButtonElement>('undo-btn');
    const r = $<HTMLButtonElement>('redo-btn');
    if (u) u.disabled = !this.history.canUndo();
    if (r) r.disabled = !this.history.canRedo();
  }

  // Restore a snapshot into the engine + UI WITHOUT pruning the instrument table
  // (so a just-added, note-less instrument survives undo) and WITHOUT moving the
  // editing position (cursor / pattern / selected instrument are preserved, clamped).
  // Routes through the same load path as a file open, so all transient engine state
  // (autoLive / panAuto / vd.master / LFO bases) is reset deterministically.
  _restoreSnapshot(doc: SerializedSong) {
    const eng = this.engine;
    this._restoring = true;
    try {
      const prevPat = eng.currentPatternIdx;
      const prevSel = this.controls.selected;
      const prevCur = { ...this.view.cursor };
      const prevScroll = this.view.scroll;

      this.customSongName = doc.name;
      this.songAuthor = doc.author ?? '';
      this.songNote = doc.note ?? '';

      eng.stop();
      eng.bpm = doc.bpm;
      const bpmInput = $<HTMLInputElement>('bpm');
      if (bpmInput) bpmInput.value = String(doc.bpm);

      eng.instruments = instrumentsFromParams(instrumentSpecs(doc));
      this._syncRendererFx();

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
      this.controls.selected = eng.instruments.length
        ? Math.min(prevSel < 0 ? 0 : prevSel, eng.instruments.length - 1) : -1;
      this.controls.select(this.controls.selected);

      const p = this.view.pattern;
      this.view.cursor.row = p ? Math.min(prevCur.row, p.rows - 1) : 0;
      this.view.cursor.ch = prevCur.ch;
      this.view.cursor.col = prevCur.col;
      this.view.selection = null;
      this.view.scroll = prevScroll;
      this.view.clampCursor();
      const lenInput = $<HTMLInputElement>('pattern-len');
      if (lenInput && this.view.pattern) lenInput.value = String(this.view.pattern.rows);

      this.view._resize();
      this.view.draw();
      this._renderSongEditor();
      this._updatePatternSelector();
      // Playback is left stopped (like a file load): the rebuilt patterns reset the
      // row clock, so resuming would jump to the top anyway.
    } finally {
      this._restoring = false;
    }
  }

  // Serialize the current song to a versioned JSON file and download it.
  _saveSong() {
    const doc = this._snapshot();
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
  _loadSongFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = deserializeSong(JSON.parse(String(reader.result)));
        this._autosaveNow();                 // flush the outgoing song first
        this.currentSong = { kind: 'user', id: this.store.createId() };
        this._applySerializedSong(doc);
        this._autosaveNow();                 // persist the import + add it to the picker
        this._buildSongPicker();
      } catch (err) {
        alert(`Couldn't load song: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.onerror = () => alert("Couldn't read the file.");
    reader.readAsText(file);
  }

  // Apply a deserialized song to the engine + UI. Identity-agnostic: the CALLER sets
  // `currentSong` (a saved-song open, a file import) before invoking.
  _applySerializedSong(doc: SerializedSong) {
    this.customSongName = doc.name || 'Untitled';
    this.songAuthor = doc.author ?? '';
    this.songNote = doc.note ?? '';

    this.engine.stop();
    this.engine.bpm = doc.bpm;
    const bpmInput = $<HTMLInputElement>('bpm');
    if (bpmInput) bpmInput.value = String(doc.bpm);

    // Serialized instruments carry their own .fx (deserializeSong migrates v1's
    // per-type fxParams onto them), so instrumentsFromParams rebuilds per-instance fx.
    this.engine.instruments = instrumentsFromParams(instrumentSpecs(doc));
    this._syncRendererFx();

    let patterns = doc.patterns.map(patternFromSerialized);
    if (!patterns.length) patterns = [new Pattern(32, 8)];
    this.engine.loadSong({
      patterns,
      order: doc.order.length ? [...doc.order] : [0],
      rowsPerBeat: doc.rowsPerBeat,
      bpm: doc.bpm,
      pan: doc.pan,
      master: doc.master,
      lfos: doc.lfos,
      modRoutings: doc.modRoutings,
    });
    this.engine.currentPatternIdx = 0;

    // Empty instrument table (a saved blank song) → no selection, like New.
    this.controls.selected = this.engine.instruments.length ? 0 : -1;
    this.controls.select(this.controls.selected);

    this.view.cursor.row = 0;
    this.view.cursor.ch = 0;
    this.view.selection = null;
    this.view.scroll = 0;
    const lenInput = $<HTMLInputElement>('pattern-len');
    if (lenInput) lenInput.value = String(this.view.pattern.rows);
    this.view.draw();
    this._renderSongEditor();
    this._updatePatternSelector();
    this._seedHistory();   // loaded document → new undo baseline
    this._buildSongPicker();
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

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      // Copy / cut / paste of a selected block (intercept before note entry,
      // since C/X/V are also piano keys).
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        // Undo/redo (intercept before note entry — Z is also a piano key).
        if (e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this._redo(); else this._undo(); return; }
        if (e.code === 'KeyY') { e.preventDefault(); this._redo(); return; }
        if (e.code === 'KeyC') { e.preventDefault(); this._copyBlock(false); return; }
        if (e.code === 'KeyX') { e.preventDefault(); this._copyBlock(true); return; }
        if (e.code === 'KeyV') { e.preventDefault(); this._pasteBlock(); return; }
        if (e.code === 'KeyA') {
          e.preventDefault();
          const p = this.view.pattern;
          if (p) {
            this.view.selection = {
              r0: 0, r1: p.rows - 1,
              c0: 0, c1: p.channels - 1
            };
            this.view.draw();
          }
          return;
        }
      }
      if (e.code === 'Escape') { this.view.selection = null; return; }
      if (e.code === 'Space') { e.preventDefault(); return this._togglePlay(); }
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
      if (this._handleCursor(e)) { e.preventDefault(); return; }
      if (this._handleAutoTrackEdit(e)) return;
      if (this._handleEdit(e)) return;
      if (this._handleFxEdit(e)) return;

      if (e.repeat) return;
      if (this.view.cursor.ch >= this.view.pattern.channels) return; // No note entry in AutoTracks
      if (this.view.cursor.col === 3) return;                        // effect column: no note entry

      const note = this._keyToNote(e.code);
      if (note == null) return;
      e.preventDefault();

      // Write into the pattern at the cursor and preview the sound.
      const inst = this.controls.selected;
      const p = this.view.pattern;
      const { row, ch } = this.view.cursor;
      p.set(row, ch, note, inst, 0.9);
      this.markDirty('note');
      this._advanceCursorRow();

      this.ensureAudio().then(() => {
        const v = this.engine.previewNote(inst, note, 0.9);
        this.held.set(e.code, v);
      });
    });

    document.addEventListener('keyup', (e) => {
      if (this.held.has(e.code)) { this.engine.previewOff(this.held.get(e.code)!); this.held.delete(e.code); }
    });
  }

  _keyToNote(code: string): number | null {
    // No instrument selected (e.g. a freshly created blank song) → nothing to play.
    const sel = this.engine.instruments[this.controls.selected];
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

  _handleCursor(e: KeyboardEvent) {
    const c = this.view.cursor, p = this.view.pattern;
    // Shift+Up/Down: fine nudge of the note's volume (±5%).
    if (e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      const idx = p.idx(c.row, c.ch);
      if (p.notes[idx] >= 0) {
        const d = e.code === 'ArrowUp' ? 0.05 : -0.05;
        p.vol[idx] = Math.min(1.0, Math.max(0.0, p.vol[idx] + d));
        this.markDirty('volnudge', true);
      }
      return true;
    }
    switch (e.code) {
      case 'ArrowUp': c.row = (c.row - 1 + p.rows) % p.rows; this.view.revealCursor(); this._digitEntry = null; this._hexEntry = null; return true;
      case 'ArrowDown': c.row = (c.row + 1) % p.rows; this.view.revealCursor(); this._digitEntry = null; this._hexEntry = null; return true;
      case 'PageUp': c.row = Math.max(0, c.row - this.view._viewRows()); this.view.revealCursor(); this._digitEntry = null; this._hexEntry = null; return true;
      case 'PageDown': c.row = Math.min(p.rows - 1, c.row + this.view._viewRows()); this.view.revealCursor(); this._digitEntry = null; this._hexEntry = null; return true;
      case 'Home': c.row = 0; this.view.revealCursor(); this._digitEntry = null; this._hexEntry = null; return true;
      case 'End': c.row = p.rows - 1; this.view.revealCursor(); this._digitEntry = null; this._hexEntry = null; return true;
      // Left/Right step through the note → instrument → volume sub-columns,
      // wrapping to the adjacent channel at the ends.
      case 'ArrowLeft':
        if (c.ch >= p.channels) {
          if (c.ch > p.channels) c.ch--;
          else { c.ch = p.channels - 1; c.col = this.view.maxCol; }
        } else {
          if (c.col > 0) c.col--; else {
            if (c.ch > 0) { c.ch--; c.col = this.view.maxCol; }
            else { c.ch = p.channels + p.autoTracks.length - 1; c.col = c.ch >= p.channels ? 0 : this.view.maxCol; }
          }
        }
        this._digitEntry = null; this._hexEntry = null; return true;
      case 'ArrowRight':
        if (c.ch >= p.channels) {
          if (c.ch < p.channels + p.autoTracks.length - 1) c.ch++;
          else { c.ch = 0; c.col = 0; }
        } else {
          if (c.col < this.view.maxCol) c.col++; else {
            c.ch++; c.col = 0;
          }
        }
        this._digitEntry = null; this._hexEntry = null; return true;
      case 'Delete':
      case 'Backspace':
        if (this.view.selection) {
          const s = this.view.selection;
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
          this.view.draw();
        } else if (c.ch >= p.channels) {
          const tIdx = c.ch - p.channels;
          if (tIdx < p.autoTracks.length) p.autoTracks[tIdx].data[c.row] = -1;
          this._advanceCursorRow();
        } else if (c.col === 3) {
          p.setFx(c.row, c.ch, -1, 0);   // effect column: clear just the effect
          this._advanceCursorRow();
        } else {
          p.clear(c.row, c.ch);
          this._advanceCursorRow();
        }
        this.markDirty('clear');
        return true;
      case 'Equal': p.set(c.row, c.ch, OFF, this.controls.selected); this.markDirty('note'); this._advanceCursorRow(); return true;
      default: return false;
    }
  }

  _handleAutoTrackEdit(e: KeyboardEvent) {
    const c = this.view.cursor, p = this.view.pattern;
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
    const same = this._hexEntry && this._hexEntry.ch === c.ch && this._hexEntry.row === c.row;
    
    track.data[c.row] = (same ? ((this._hexEntry!.first << 4) | nyb) : nyb) & 0xff;
    this._hexEntry = same ? null : { ch: c.ch, row: c.row, first: nyb };
    this.markDirty('autocell', true);

    // Automatically advance cursor on second digit
    if (same) this._advanceCursorRow();
    return true;
  }

  // Digit keys edit the instrument (col 1) or volume (col 2) of the note under
  // the cursor, two-digit accumulation per field (e.g. "2" then "5" → 25).
  _handleEdit(e: KeyboardEvent) {
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (!m) return false;
    const c = this.view.cursor;
    if (c.col !== 1 && c.col !== 2) return false;  // only instrument / volume here
    e.preventDefault();
    const p = this.view.pattern;
    const idx = p.idx(c.row, c.ch);
    if (p.notes[idx] < 0) return true;             // no real note here — nothing to edit
    const d = +m[1];
    const same = this._digitEntry && this._digitEntry.idx === idx && this._digitEntry.col === c.col;
    const val = same ? this._digitEntry!.first * 10 + d : d;
    this._digitEntry = same ? null : { idx, col: c.col, first: d };
    if (c.col === 1) p.inst[idx] = Math.min(val, this.engine.instruments.length - 1);
    else p.vol[idx] = Math.min(99, val) / 99;
    this.markDirty('editval', true);
    return true;
  }

  // Effect column (cursor col 3): a command key (0-4, A — see fx.ts) sets the
  // command and arms a 2-nibble hex value; the next two hex digits fill the value
  // byte and auto-advance the row, mirroring inst/vol and the auto-track entry.
  _handleFxEdit(e: KeyboardEvent): boolean {
    const c = this.view.cursor, p = this.view.pattern;
    if (c.col !== 3 || c.ch >= p.channels) return false;
    const idx = p.idx(c.row, c.ch);
    const armed = !!this._hexEntry && this._hexEntry.col === 3
      && this._hexEntry.ch === c.ch && this._hexEntry.row === c.row;

    if (!armed) {
      // Expect a command key; swallow anything else so col 3 never types a note.
      const ch = this._keyChar(e.code);
      if (ch === null) return false;
      const def = fxByKey(ch);
      e.preventDefault();
      if (def) {
        p.setFx(c.row, c.ch, def.code, 0);
        this.markDirty('fx', true);
        this._hexEntry = { col: 3, ch: c.ch, row: c.row, first: -1 };  // awaiting value
      }
      return true;
    }

    // Armed: consume two hex nibbles into the value byte.
    const nyb = this._keyHex(e.code);
    if (nyb === null) { e.preventDefault(); return true; }   // ignore non-hex while armed
    e.preventDefault();
    if (this._hexEntry!.first < 0) {
      p.fxVal[idx] = nyb;                                     // first (high) nibble
      this._hexEntry!.first = nyb;
    } else {
      p.fxVal[idx] = ((this._hexEntry!.first << 4) | nyb) & 0xff;
      this._hexEntry = null;
      this._advanceCursorRow();
    }
    this.markDirty('fx', true);
    return true;
  }

  // A single upper-case char for a Digit/Key code (else null).
  _keyChar(code: string): string | null {
    const d = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (d) return d[1];
    const k = /^Key([A-Z])$/.exec(code);
    return k ? k[1] : null;
  }
  // A 0..15 hex nibble from a digit/A–F key (else null).
  _keyHex(code: string): number | null {
    const ch = this._keyChar(code);
    if (ch === null) return null;
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
    if (ch >= 'A' && ch <= 'F') return ch.charCodeAt(0) - 55;
    return null;
  }

  _closeFxPicker() {
    if (this._fxPicker) { this._fxPicker.remove(); this._fxPicker = null; }
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

    if (instr) {
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

  _advanceCursorRow() {
    const p = this.view.pattern;
    this.view.cursor.row = (this.view.cursor.row + 1) % p.rows;
    this.view.revealCursor();
    this._digitEntry = null;
  }

  // Copy the selected block (or the single cursor cell) into the clipboard.
  // `cut` also clears the source cells.
  _copyBlock(cut: boolean) {
    const p = this.view.pattern, s = this.view.selection, c = this.view.cursor;
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
    this._clipboard = { rows: r1 - r0 + 1, chans: c1 - c0 + 1, cells };
    if (cut) { this.markDirty('cut'); this.view.draw(); }
  }

  // Paste the clipboard block with its top-left at the cursor, clipped to bounds.
  _pasteBlock() {
    const cb = this._clipboard;
    if (!cb) return;
    const p = this.view.pattern, c = this.view.cursor;
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
    this.markDirty('paste');
    this.view.draw();
  }

  async _togglePlay() {
    await this.ensureAudio();
    if (this.engine.playing) this.engine.stop(); else this.engine.play();
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

  // Build the two global-LFO control panels in the Song Editor. Rebuilds from
  // scratch (target options depend on the live instrument table); each control
  // mutates engine.lfos[i] in place. Native controls — no custom knobs — kept
  // intentionally compact. See src/tracker/lfo.ts for the model.
  _buildLfoUI() {
    const host = document.getElementById('lfo-panels');
    if (!host) return;
    const eng = this.engine;
    const voices = eng.voices.length;

    // Flat target list: Off · Global (VOL) · per-instrument inst/fx · per-channel pan.
    type Opt = { paramId: number; instIdx: number | null; label: string };
    const opts: Opt[] = [{ paramId: -1, instIdx: null, label: '— Off —' }];
    for (const t of TARGETS) if (t.scope === 'global' && t.code !== 'BPM') opts.push({ paramId: t.id, instIdx: null, label: `Global · ${t.label}` });
    for (let i = 0; i < eng.instruments.length; i++) {
      const instr = eng.instruments[i];
      for (const t of targetsForType(instr.type)) {
        if (t.scope === 'inst') opts.push({ paramId: t.id, instIdx: i, label: `${i}:${instr.type.toUpperCase()} · ${t.label}` });
        else if (t.scope === 'fx') opts.push({ paramId: t.id, instIdx: i, label: `${i}:${instr.type.toUpperCase()} · FX ${t.label}` });
      }
    }
    for (const t of TARGETS) if (t.scope === 'chan') for (let ch = 0; ch < voices; ch++) opts.push({ paramId: t.id, instIdx: ch, label: `Ch ${ch + 1} · ${t.label}` });

    const BEATS: [number, string][] = [[16, '4 bars'], [8, '2 bars'], [4, '1 bar'], [2, '1/2 bar'], [1, '1 beat'], [0.5, '1/2'], [0.25, '1/4'], [0.125, '1/8']];
    const q = <T extends HTMLElement>(root: ParentNode, k: string) => root.querySelector(`[data-k="${k}"]`) as T;

    host.innerHTML = '';

    // ── LFO SOURCE panels (waveform generators; no target — see the matrix below) ──
    eng.lfos.forEach((cfg, i) => {
      const panel = document.createElement('div');
      panel.className = 'lfo-panel';
      const shapeOpts = LFO_SHAPES.map((s, k) => `<option value="${k}">${s}</option>`).join('');
      const beatOpts = BEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      const bankOpts = WT_BANKS.map((b, k) => `<option value="${k}">${b.name}</option>`).join('');
      panel.innerHTML = `
        <div class="lfo-head">LFO ${i + 1}</div>
        <label class="lfo-row">Shape <select data-k="shape">${shapeOpts}</select></label>
        <label class="lfo-row"><input type="checkbox" data-k="sync"> Sync</label>
        <label class="lfo-row" data-when="sync">Rate <select data-k="beats">${beatOpts}</select></label>
        <label class="lfo-row" data-when="free">Hz <input type="range" data-k="hz" min="0.05" max="20" step="0.05"><span data-k="hzv" class="lfo-val"></span></label>
        <label class="lfo-row" data-when="wt">Bank <select data-k="wtbank">${bankOpts}</select></label>
        <label class="lfo-row" data-when="wt">Pos <input type="range" data-k="wtpos" min="0" max="1" step="0.01"><span data-k="wtposv" class="lfo-val"></span></label>`;
      host.appendChild(panel);

      const shape = q<HTMLSelectElement>(panel, 'shape');
      const sync = q<HTMLInputElement>(panel, 'sync');
      const beats = q<HTMLSelectElement>(panel, 'beats');
      const hz = q<HTMLInputElement>(panel, 'hz');
      const hzv = q<HTMLSpanElement>(panel, 'hzv');
      const wtbank = q<HTMLSelectElement>(panel, 'wtbank');
      const wtpos = q<HTMLInputElement>(panel, 'wtpos');
      const wtposv = q<HTMLSpanElement>(panel, 'wtposv');

      const refresh = () => {
        shape.value = String(cfg.shape);
        sync.checked = cfg.sync;
        beats.value = String(cfg.rateBeats);
        hz.value = String(cfg.rateHz); hzv.textContent = cfg.rateHz.toFixed(2) + 'Hz';
        wtbank.value = String(cfg.wtBank);
        wtpos.value = String(cfg.wtPos); wtposv.textContent = cfg.wtPos.toFixed(2);
        const isWt = cfg.shape === LFO_SHAPE_WAVETABLE;
        panel.querySelectorAll<HTMLElement>('[data-when]').forEach((el) => {
          const w = el.dataset.when;
          el.style.display = (w === 'sync' ? cfg.sync : w === 'free' ? !cfg.sync : w === 'wt' ? isWt : true) ? '' : 'none';
        });
      };
      shape.onchange = () => { cfg.shape = +shape.value; refresh(); this.markDirty('lfo'); };
      sync.onchange = () => { cfg.sync = sync.checked; refresh(); this.markDirty('lfo'); };
      beats.onchange = () => { cfg.rateBeats = +beats.value; this.markDirty('lfo'); };
      hz.oninput = () => { cfg.rateHz = +hz.value; hzv.textContent = cfg.rateHz.toFixed(2) + 'Hz'; };
      hz.onchange = () => this.markDirty('lfo');         // commit (drag end) → one undo step
      wtbank.onchange = () => { cfg.wtBank = +wtbank.value; this.markDirty('lfo'); };
      wtpos.oninput = () => { cfg.wtPos = +wtpos.value; wtposv.textContent = cfg.wtPos.toFixed(2); };
      wtpos.onchange = () => this.markDirty('lfo');
      refresh();
    });

    // ── Modulation MATRIX: each routing points a target at an LFO source, with its
    //    own depth/polarity. Many routings can share one source (one LFO → many). ──
    const matrix = document.createElement('div');
    matrix.className = 'lfo-matrix';
    const addBtn = eng.modRoutings.length < MAX_ROUTINGS ? '<button class="lfo-add" data-k="add">+ Add</button>' : '';
    matrix.innerHTML = `<div class="lfo-head">Routings ${addBtn}</div>`;
    const srcOpts = eng.lfos.map((_, i) => `<option value="${i}">LFO ${i + 1}</option>`).join('');
    const tgtOpts = opts.map((o, k) => `<option value="${k}">${o.label}</option>`).join('');

    eng.modRoutings.forEach((r, ri) => {
      const row = document.createElement('div');
      row.className = 'lfo-route';
      row.innerHTML = `
        <select data-k="src" title="LFO source">${srcOpts}</select>
        <select data-k="tgt" title="target">${tgtOpts}</select>
        <input type="range" data-k="depth" min="0" max="1" step="0.01" title="depth">
        <label class="lfo-bip" title="bipolar"><input type="checkbox" data-k="bip"> ±</label>
        <button data-k="del" title="remove routing">✕</button>`;
      matrix.appendChild(row);
      const src = q<HTMLSelectElement>(row, 'src');
      const tgt = q<HTMLSelectElement>(row, 'tgt');
      const depth = q<HTMLInputElement>(row, 'depth');
      const bip = q<HTMLInputElement>(row, 'bip');
      const del = q<HTMLButtonElement>(row, 'del');
      src.value = String(Math.min(r.source, eng.lfos.length - 1));
      const ti = opts.findIndex((o) => o.paramId === r.targetParamId && o.instIdx === r.targetInstIdx);
      tgt.value = String(ti >= 0 ? ti : 0);
      depth.value = String(r.depth);
      bip.checked = r.bipolar;
      src.onchange = () => { r.source = +src.value; this.markDirty('lfo'); };
      tgt.onchange = () => { const o = opts[+tgt.value]; r.targetParamId = o.paramId; r.targetInstIdx = o.instIdx; this.markDirty('lfo'); };
      depth.oninput = () => { r.depth = +depth.value; };
      depth.onchange = () => this.markDirty('lfo');      // commit (drag end) → one undo step
      bip.onchange = () => { r.bipolar = bip.checked; this.markDirty('lfo'); };
      del.onclick = () => { eng.modRoutings.splice(ri, 1); this.markDirty('lfo'); this._buildLfoUI(); };
    });

    const add = q<HTMLButtonElement>(matrix, 'add');
    if (add) add.onclick = () => { eng.modRoutings.push(defaultRouting()); this.markDirty('lfo'); this._buildLfoUI(); };
    host.appendChild(matrix);
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
    this.markDirty('pattern');
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
    this.markDirty('pattern');
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
