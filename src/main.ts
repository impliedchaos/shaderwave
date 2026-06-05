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
import { instGlow, DEFAULT_MASTER } from './constants.js';
import { EMPTY, OFF, Pattern } from './tracker/pattern.js';
import { targetsForType, TARGETS } from './tracker/automation.js';
import { showExportDialog } from './audio/export.js';
import { renderArranger } from './ui/arranger.js';
import { invalidateTheme, themeVar } from './ui/theme.js';
import { initHelp } from './ui/help.js';
import pkg from '../package.json';
import type { FxParams, FxParamsByType, ParamTarget } from './types.js';

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

// Deep-clone song params so slider mutations never corrupt the DEMO_SONGS defs.
function cloneFx(src: Record<string, FxParams>): FxParamsByType {
  const dst: Record<string, FxParams> = {};
  for (const k in src) dst[k] = { ...src[k] };
  return dst as FxParamsByType;
}

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
  enableKey?: string;
  label?: string;
  key?: string;
  min?: number;
  max?: number;
  step?: number;
}

const FX_DEFS: FxDef[] = [
  { category: 'Distortion', enableKey: 'distOn' },
  { label: 'Tone', key: 'tone', min: 0, max: 1, step: 0.01 },
  { label: 'Level', key: 'level', min: 0, max: 2, step: 0.01 },
  { label: 'Dist', key: 'dist', min: 0.001, max: 20, step: 0.1 },

  { category: 'Stereo Chorus', enableKey: 'chorusOn' },
  { label: 'Cho Mix', key: 'chorusMix', min: 0, max: 1, step: 0.01 },
  { label: 'Cho Rate', key: 'chorusRate', min: 0.1, max: 5.0, step: 0.05 },
  { label: 'Cho Depth', key: 'chorusDepth', min: 0.5, max: 5.0, step: 0.1 },

  { category: 'Stereo Tremolo (Auto-Pan)', enableKey: 'tremoloOn' },
  { label: 'Trem Mix', key: 'tremoloMix', min: 0, max: 1, step: 0.01 },
  { label: 'Trem Rate', key: 'tremoloRate', min: 0.5, max: 15.0, step: 0.1 },

  { category: 'Delay', enableKey: 'delayOn' },
  { label: 'Dly Time', key: 'delayTime', min: 0.02, max: 1.2, step: 0.01 },
  { label: 'Dly FB', key: 'delayFeedback', min: 0, max: 0.9, step: 0.01 },
  { label: 'Dly Mix', key: 'delayMix', min: 0, max: 1, step: 0.01 },

  { category: 'Reverb', enableKey: 'reverbOn' },
  { label: 'Rev Decay', key: 'reverbDecay', min: 0, max: 0.97, step: 0.01 },
  { label: 'Rev Damp', key: 'reverbDamp', min: 0, max: 0.95, step: 0.01 },
  { label: 'Rev Mix', key: 'reverbMix', min: 0, max: 1, step: 0.01 },

  { category: 'Bitcrusher', enableKey: 'bitcrushOn' },
  { label: 'Crush Bits', key: 'bitcrushBits', min: 1, max: 16, step: 1 },
  { label: 'Crush Hz', key: 'bitcrushRate', min: 100, max: 22000, step: 100 },

  { category: 'Stereo Field & Output', enableKey: 'widthOn' },
  { label: 'Width', key: 'width', min: 0, max: 2, step: 0.01 },
  { label: 'Level', key: 'master', min: 0, max: 1.5, step: 0.01 },
];

// A knob <div> the UI loop drives externally (see bindKnob in controls.ts).
type KnobEl = HTMLElement & { _extSet?: (v: number) => void };
// One copied tracker cell.
// A copied cell is either a note cell (note/inst/vol) or an automation-track
// cell (`auto` = the row's Int16 value). `auto === undefined` discriminates.
type ClipCell = { note: number; inst: number; vol: number; auto?: number };

export class App {
  gl: WebGL2RenderingContext;
  engine: Engine;
  currentSongIdx: number;
  fxParams: FxParamsByType;
  pipeline: AudioPipeline;
  renderer: SynthRenderer | null;
  audioReady: boolean;
  underruns: number;
  view: TrackerView;
  controls: Controls;
  held: Map<string, number>;
  customSongName: string | null = null;
  lastRecordedRow = 0;        // video-export progress cursor
  _playbackVolume?: number;
  _fxKnobs: { el: KnobEl; key: string }[] = [];
  _songVolumeKnob?: KnobEl;
  _fxPanelType?: string;
  _digitEntry: { idx: number; col: number; first: number } | null = null;
  _hexEntry: { idx?: number; ch?: number; row?: number; first: number } | null = null;
  _clipboard: { rows: number; chans: number; cells: ClipCell[][] } | null = null;
  _fxPicker: HTMLElement | null = null;
  _vuL = 0;
  _vuR = 0;
  _freqData?: Uint8Array<ArrayBuffer>;
  _waveData?: Uint8Array<ArrayBuffer>;
  _recordEnabled = false;

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
    const defaultIdx = DEMO_SONGS.findIndex(s => s.name === "Antiseptik USA");
    this.currentSongIdx = defaultIdx !== -1 ? defaultIdx : sortedIndices[0].i;
    const initialSong = DEMO_SONGS[this.currentSongIdx];
    const init = loadSongInstruments(initialSong);
    this.engine.instruments = init.instruments;
    this.engine.loadSong(init.data);
    this.engine.bpm = initialSong.bpm;
    this.fxParams = cloneFx(initialSong.fxParams);
    this.engine.fxParams = this.fxParams;   // let the engine apply fx-scope automation

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

        // FX chains are per engine type
        this._buildFxPanel(instr.type);

        // Theme the UI accent with this instance's colour.
        document.documentElement.style.setProperty('--accent', instr.color);
        document.documentElement.style.setProperty('--accent-glow', instGlow(instr.color, 0.2));
        document.documentElement.style.setProperty('--cursor-border', instr.color);
        invalidateTheme();
      },
      onPresetChange: (instName, fxParams) => {
        if (instName !== 'dx7' && fxParams) {
          Object.assign((this.fxParams as Record<string, FxParams>)[instName], fxParams);
          this._buildFxPanel(instName);
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

    this.pipeline.onStats = (s) => { this.underruns = s.underruns; };
    setInterval(() => { if (this.audioReady) this.pipeline.requestStats(); }, 500);
  }

  async ensureAudio() {
    if (this.audioReady) return;
    const sr = await this.pipeline.init();
    this.engine.sampleRate = sr;
    this._updateLatencyDisplay();   // now reflects the real sample rate
    this.renderer = new SynthRenderer(this.gl, sr, this.fxParams);
    const produce = (blockStart: number) => this.renderer!.renderBlock(this.engine.advance(blockStart), blockStart);
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

  _buildFxPanel(itName: string) {
    const params = (this.fxParams as Record<string, FxParams>)[itName];
    const host = $('fx');
    host.innerHTML = '';
    // Knobs the UI loop re-reads from fxParams so fx-scope automation shows live.
    this._fxKnobs = [];
    this._fxPanelType = itName;
    for (const d of FX_DEFS) {
      if (d.category) {
        const cat = document.createElement('h3');
        cat.textContent = d.category;
        if (d.enableKey) {
          const ek = d.enableKey;
          if (params[ek] === undefined) {
            params[ek] = (ek === 'bitcrushOn') ? false : true;
          }
          const btn = document.createElement('button');
          btn.className = 'fx-cat-toggle';
          const sync = () => {
            const isOn = params[ek] !== false;
            btn.className = 'fx-cat-toggle' + (isOn ? ' on' : '');
            btn.textContent = isOn ? 'on' : 'off';
          };
          sync();
          btn.onclick = () => { params[ek] = (params[ek] === false); sync(); };
          cat.appendChild(btn);
        }
        host.appendChild(cat);
        continue;
      }
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
      });
      this._fxKnobs.push({ el: knob, key });
    }
    const toggle = $('fx-toggle');
    toggle.className = params.enabled ? 'on' : '';
    toggle.textContent = params.enabled ? 'on' : 'off';
    toggle.onclick = () => {
      params.enabled = !params.enabled;
      toggle.className = params.enabled ? 'on' : '';
      toggle.textContent = params.enabled ? 'on' : 'off';
    };
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
      const songDef = DEMO_SONGS[this.currentSongIdx];
      if (songDef) {
        songDef.bpm = val;
      }
    };
    const lenInput = $<HTMLInputElement>('pattern-len');
    if (lenInput) {
      lenInput.value = String(this.view.pattern.rows);
      lenInput.onchange = (e) => {
        const t = e.target as HTMLInputElement;
        const val = Math.max(1, Math.min(256, +t.value || this.view.pattern.rows));
        t.value = String(val);
        this.view.pattern.resize(val);
        if (this.view.cursor.row >= val) this.view.cursor.row = val - 1;
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
        (v) => `${Math.round((v / DEFAULT_MASTER) * 100)}%`);
    }
    const songSelect = $<HTMLSelectElement>('song-select');
    if (songSelect) {
      // Populate from DEMO_SONGS so the list never drifts out of sync.
      songSelect.innerHTML = '';
      const sortedSongs = DEMO_SONGS.map((s, i) => ({ s, i }))
        .sort((a, b) => a.s.name.localeCompare(b.s.name));
      sortedSongs.forEach(({ s, i }) => {
        const o = document.createElement('option');
        o.value = String(i); o.textContent = s.name;
        songSelect.appendChild(o);
      });
      songSelect.value = String(this.currentSongIdx);
      songSelect.onchange = (e) => {
        const idx = parseInt((e.target as HTMLSelectElement).value);
        if (idx === -1) return;
        const untitledOpt = songSelect.querySelector('option[value="-1"]');
        if (untitledOpt) {
          untitledOpt.remove();
        }
        this.customSongName = null;
        const songDef = DEMO_SONGS[idx];
        if (songDef) {
          this.currentSongIdx = idx;
          const bpmInput = $<HTMLInputElement>('bpm');
          if (bpmInput) {
            bpmInput.value = String(songDef.bpm);
          }
          this.engine.bpm = songDef.bpm;
          // Build the instrument table for this song, pruned to the engines it
          // actually uses (also discards any user-added instances).
          const loaded = loadSongInstruments(songDef);
          this.engine.instruments = loaded.instruments;
          this.fxParams = cloneFx(songDef.fxParams);
          this.engine.fxParams = this.fxParams;

          if (this.renderer) {
            for (const it of this.renderer.inst) {
              it.fx.params = this.fxParams[it.name];
            }
          }

          const wasPlaying = this.engine.playing;
          this.engine.stop();
          this.engine.loadSong(loaded.data);
          this.engine.currentPatternIdx = 0;

          // Reset to a valid instance and rebuild the selector + all panels.
          this.controls.selected = 0;
          this.controls.select(0);

          this.view.cursor.row = 0;
          this.view.cursor.ch = 0;
          this.view.selection = null;
          this.view.scroll = 0;
          const lenInput = $<HTMLInputElement>('pattern-len');
          if (lenInput) lenInput.value = String(this.view.pattern.rows);
          this.view.draw();
          this._renderSongEditor();
          this._updatePatternSelector();

          if (wasPlaying) {
            this.engine.play();
          }
        }
      };
    }

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

    // Bind Song Arranger Tab controls
    const addPatBtn = $('add-pattern-btn');
    if (addPatBtn) {
      addPatBtn.onclick = () => {
        const song = this.engine.song;
        if (!song) return;
        const p = this.view.pattern;
        const newPat = new Pattern(p ? p.rows : 64, p ? p.channels : 8);
        song.patterns.push(newPat);
        this.engine.currentPatternIdx = song.patterns.length - 1;
        this._renderSongEditor();
        this._updatePatternSelector();
        this.view.draw();
      };
    }

    const addOrdBtn = $('add-order-btn');
    if (addOrdBtn) {
      addOrdBtn.onclick = () => {
        if (!this.engine.song) return;
        this.engine.song.order.push(this.engine.currentPatternIdx);
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
        this.engine.stop();
        this.customSongName = 'Untitled';
        const songSelect = $<HTMLSelectElement>('song-select');
        if (songSelect) {
          let untitledOpt = songSelect.querySelector<HTMLOptionElement>('option[value="-1"]');
          if (!untitledOpt) {
            untitledOpt = document.createElement('option');
            untitledOpt.value = "-1";
            untitledOpt.textContent = "Untitled";
            songSelect.appendChild(untitledOpt);
          }
          songSelect.value = "-1";
        }

        const newPat = new Pattern(32, 8);
        const songData = {
          patterns: [newPat],
          order: [0],
          rowsPerBeat: 4
        };
        this.engine.loadSong(songData);
        this.engine.currentPatternIdx = 0;

        this.engine.instruments = [];
        this.fxParams = {
          '303': defaultFxParams(),
          'dx7': defaultFxParams(),
          '808': defaultFxParams(),
          'moog': defaultFxParams()
        };
        this.engine.fxParams = this.fxParams;

        if (this.renderer) {
          for (const it of this.renderer.inst) {
            it.fx.params = this.fxParams[it.name] || defaultFxParams();
          }
        }

        this.view.cursor.row = 0;
        this.view.cursor.ch = 0;
        this.view.selection = null;
        this.view.scroll = 0;

        this.controls.selected = -1;
        this.controls.select(-1);

        this.view.draw();
        this._renderSongEditor();
        this._updatePatternSelector();
      };
    }

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

      if (e.repeat) return;
      if (this.view.cursor.ch >= this.view.pattern.channels) return; // No note entry in AutoTracks

      const note = this._keyToNote(e.code);
      if (note == null) return;
      e.preventDefault();

      // Write into the pattern at the cursor and preview the sound.
      const inst = this.controls.selected;
      const p = this.view.pattern;
      const { row, ch } = this.view.cursor;
      p.set(row, ch, note, inst, 0.9);
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
    if (sel.type === '808') {
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
    // Shift+Up/Down: fine nudge. In the fx-value column it steps the value byte;
    // elsewhere it nudges the note's volume.
    if (e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      const idx = p.idx(c.row, c.ch);
      if (p.notes[idx] >= 0) {
        const d = e.code === 'ArrowUp' ? 0.05 : -0.05;
        p.vol[idx] = Math.min(1.0, Math.max(0.0, p.vol[idx] + d));
      }
      return true;
    }
    switch (e.code) {
      case 'ArrowUp': c.row = (c.row - 1 + p.rows) % p.rows; this.view.revealCursor(); this._digitEntry = null; return true;
      case 'ArrowDown': c.row = (c.row + 1) % p.rows; this.view.revealCursor(); this._digitEntry = null; return true;
      case 'PageUp': c.row = Math.max(0, c.row - this.view._viewRows()); this.view.revealCursor(); this._digitEntry = null; return true;
      case 'PageDown': c.row = Math.min(p.rows - 1, c.row + this.view._viewRows()); this.view.revealCursor(); this._digitEntry = null; return true;
      case 'Home': c.row = 0; this.view.revealCursor(); this._digitEntry = null; return true;
      case 'End': c.row = p.rows - 1; this.view.revealCursor(); this._digitEntry = null; return true;
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
        this._digitEntry = null; return true;
      case 'ArrowRight':
        if (c.ch >= p.channels) {
          if (c.ch < p.channels + p.autoTracks.length - 1) c.ch++;
          else { c.ch = 0; c.col = 0; }
        } else {
          if (c.col < this.view.maxCol) c.col++; else {
            c.ch++; c.col = 0;
          }
        }
        this._digitEntry = null; return true;
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
        } else {
          p.clear(c.row, c.ch);
          this._advanceCursorRow();
        }
        return true;
      case 'Equal': p.set(c.row, c.ch, OFF, this.controls.selected); this._advanceCursorRow(); return true;
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
    return true;
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
      const fp = this._fxPanelType ? (this.fxParams as Record<string, FxParams>)[this._fxPanelType] : undefined;
      if (fp && this._fxPanelType === instr.type) {
        for (const k of this._fxKnobs || []) k.el._extSet?.(fp[k.key] as number);
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
          rowCells.push({ note: p.notes[i], inst: p.inst[i], vol: p.vol[i] });
          if (cut) p.clear(r, ch);
        }
      }
      cells.push(rowCells);
    }
    this._clipboard = { rows: r1 - r0 + 1, chans: c1 - c0 + 1, cells };
    if (cut) this.view.draw();
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
        }
      }
    }
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
    
    this._renderSongEditor();
    this._updatePatternSelector();
    this.view.draw();
  }

  _renderSongEditor() {
    renderArranger(this);
    this._songVolumeKnob?._extSet?.(this.engine.songMaster);   // reflect the loaded song's volume
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
