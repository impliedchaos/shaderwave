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
import { instGlow } from './constants.js';
import { OFF, NO_FX, Pattern } from './tracker/pattern.js';
import { targetsForType, targetById, fmtValue } from './tracker/automation.js';
import { showExportDialog } from './audio/export.js';
import { renderArranger } from './ui/arranger.js';
import { invalidateTheme, themeVar } from './ui/theme.js';
import { initHelp } from './ui/help.js';

const $ = (id) => document.getElementById(id);

// Deep-clone song params so slider mutations never corrupt the DEMO_SONGS defs.
function cloneFx(src) {
  const dst = {};
  for (const k in src) dst[k] = { ...src[k] };
  return dst;
}

// Lower keyboard row → semitone offset within the current octave.
const KEY_SEMI = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
};
// For 808, keys select drum slots rather than pitches.
const DRUM_KEYS = [36, 38, 42, 46, 39, 41, 45, 48, 56];

// FX panel layout: category headers (with bypass toggle) interleaved with knob
// rows. Ordered to follow the signal-flow chain (see DEFAULT_FX_ORDER in
// effects.js). Static, so it lives at module scope rather than rebuilt per call.
const FX_DEFS = [
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
  { label: 'Master', key: 'master', min: 0, max: 1.5, step: 0.01 },
];

export class App {
  constructor() {
    // GL renders audio entirely into FBOs (read back via readPixels), so its
    // canvas is never displayed — and it MUST be separate from the 2D grid
    // canvas, since a canvas can only ever hand out one context type.
    const glCanvas = document.createElement('canvas');
    glCanvas.width = 1; glCanvas.height = 1;
    this.gl = createGL(glCanvas);
    $('gl-status').innerHTML = 'gl: <span class="ok">ready</span>';

    const canvas = $('grid');

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

    const bpmInput = $('bpm');
    if (bpmInput) {
      bpmInput.value = initialSong.bpm;
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
          Object.assign(this.fxParams[instName], fxParams);
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
    const produce = (blockStart) => this.renderer.renderBlock(this.engine.advance(blockStart), blockStart);
    await this.pipeline.start(produce);
    this.audioReady = true;
    $('audio-status').innerHTML = `audio: <span class="ok">running</span> @ ${sr | 0}Hz`;
  }

  _buildFxPanel(itName) {
    const params = this.fxParams[itName];
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
          if (params[d.enableKey] === undefined) {
            params[d.enableKey] = (d.enableKey === 'bitcrushOn') ? false : true;
          }
          const btn = document.createElement('button');
          btn.className = 'fx-cat-toggle';
          const sync = () => {
            const isOn = params[d.enableKey] !== false;
            btn.className = 'fx-cat-toggle' + (isOn ? ' on' : '');
            btn.textContent = isOn ? 'on' : 'off';
          };
          sync();
          btn.onclick = () => { params[d.enableKey] = (params[d.enableKey] === false); sync(); };
          cat.appendChild(btn);
        }
        host.appendChild(cat);
        continue;
      }
      if (params[d.key] === undefined) {
        if (d.key === 'bitcrushBits') params[d.key] = 8.0;
        else if (d.key === 'bitcrushRate') params[d.key] = 4000.0;
        else params[d.key] = d.min;
      }
      const block = document.createElement('div');
      block.className = 'param-control-block';

      const label = document.createElement('label');
      label.textContent = d.label;
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

      const isPercent = d.min === 0 && d.max === 1 && d.step < 1;

      bindKnob(knob, valSpan, d.min, d.max, d.step, params[d.key], isPercent, (v) => {
        params[d.key] = v;
      });
      this._fxKnobs.push({ el: knob, key: d.key });
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
    $('stop').onclick = () => this.engine.stop();
    $('bpm').oninput = (e) => {
      const val = Math.max(40, Math.min(300, +e.target.value || 125));
      this.engine.bpm = val;
      const songDef = DEMO_SONGS[this.currentSongIdx];
      if (songDef) {
        songDef.bpm = val;
      }
    };
    const lenInput = $('pattern-len');
    if (lenInput) {
      lenInput.value = this.view.pattern.rows;
      lenInput.onchange = (e) => {
        const val = Math.max(1, Math.min(256, +e.target.value || this.view.pattern.rows));
        e.target.value = val;
        this.view.pattern.resize(val);
        if (this.view.cursor.row >= val) this.view.cursor.row = val - 1;
        this.view.draw();
        this._renderSongEditor();
      };
    }
    const fxColBtn = $('fx-col-btn');
    if (fxColBtn) {
      fxColBtn.onclick = () => { this.view.toggleFx(); this._updateFxColBtn(); };
      this._updateFxColBtn();
    }
    const volInput = $('volume');
    const volVal = $('volume-val');
    if (volInput && volVal) {
      volInput.oninput = (e) => {
        const val = +e.target.value;
        volVal.textContent = `${val}%`;
        this.engine.vd.master = val / 100;
      };
    }
    const songSelect = $('song-select');
    if (songSelect) {
      // Populate from DEMO_SONGS so the list never drifts out of sync.
      songSelect.innerHTML = '';
      const sortedSongs = DEMO_SONGS.map((s, i) => ({ s, i }))
        .sort((a, b) => a.s.name.localeCompare(b.s.name));
      sortedSongs.forEach(({ s, i }) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = s.name;
        songSelect.appendChild(o);
      });
      songSelect.value = String(this.currentSongIdx);
      songSelect.onchange = (e) => {
        const idx = parseInt(e.target.value);
        if (idx === -1) return;
        const untitledOpt = songSelect.querySelector('option[value="-1"]');
        if (untitledOpt) {
          untitledOpt.remove();
        }
        this.customSongName = null;
        const songDef = DEMO_SONGS[idx];
        if (songDef) {
          this.currentSongIdx = idx;
          const bpmInput = $('bpm');
          if (bpmInput) {
            bpmInput.value = songDef.bpm;
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
          const lenInput = $('pattern-len');
          if (lenInput) lenInput.value = this.view.pattern.rows;
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
        const p = this.view.pattern;
        const newPat = new Pattern(p ? p.rows : 64, p ? p.channels : 8);
        this.engine.song.patterns.push(newPat);
        this.engine.currentPatternIdx = this.engine.song.patterns.length - 1;
        this._renderSongEditor();
        this._updatePatternSelector();
        this.view.draw();
      };
    }

    const addOrdBtn = $('add-order-btn');
    if (addOrdBtn) {
      addOrdBtn.onclick = () => {
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
        const songSelect = $('song-select');
        if (songSelect) {
          let untitledOpt = songSelect.querySelector('option[value="-1"]');
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

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
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
        const input = $('octave');
        input.value = Math.max(+input.min || 0, Math.min(+input.max || 8, (+input.value || 4) - 1));
        return;
      }
      if (e.code === 'BracketRight') {
        e.preventDefault();
        const input = $('octave');
        input.value = Math.max(+input.min || 0, Math.min(+input.max || 8, (+input.value || 4) + 1));
        return;
      }
      // Toggle the automation column (F), except while editing an fx field.
      if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey && this.view.cursor.col < 3) {
        e.preventDefault(); this.view.toggleFx(); this._updateFxColBtn(); return;
      }
      if (this._handleCursor(e)) { e.preventDefault(); return; }
      if (this._handleFxEdit(e)) return;
      if (this._handleEdit(e)) return;

      if (e.repeat) return;
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
      if (this.held.has(e.code)) { this.engine.previewOff(this.held.get(e.code)); this.held.delete(e.code); }
    });
  }

  _keyToNote(code) {
    // No instrument selected (e.g. a freshly created blank song) → nothing to play.
    const sel = this.engine.instruments[this.controls.selected];
    if (!sel) return null;
    if (sel.type === '808') {
      const semi = KEY_SEMI[code];
      return semi == null ? null : (DRUM_KEYS[semi] ?? null);
    }
    const semi = KEY_SEMI[code];
    if (semi == null) return null;
    const oct = Math.max(0, Math.min(8, +$('octave').value || 4));
    return (oct + 1) * 12 + semi;
  }

  _handleCursor(e) {
    const c = this.view.cursor, p = this.view.pattern;
    // Shift+Up/Down: fine nudge. In the fx-value column it steps the value byte;
    // elsewhere it nudges the note's volume.
    if (e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      const idx = p.idx(c.row, c.ch);
      if (c.col === 4 && p.fxCmd[idx] !== NO_FX) {
        const d = e.code === 'ArrowUp' ? 1 : -1;
        p.fxVal[idx] = Math.min(255, Math.max(0, p.fxVal[idx] + d));
      } else if (p.notes[idx] >= 0) {
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
        if (c.col > 0) c.col--; else { c.ch = (c.ch - 1 + p.channels) % p.channels; c.col = this.view.maxCol; }
        this._digitEntry = null; return true;
      case 'ArrowRight':
        if (c.col < this.view.maxCol) c.col++; else { c.ch = (c.ch + 1) % p.channels; c.col = 0; }
        this._digitEntry = null; return true;
      case 'Delete':
      case 'Backspace':
        if (this.view.selection) {
          const s = this.view.selection;
          for (let r = s.r0; r <= s.r1; r++) {
            for (let ch = s.c0; ch <= s.c1; ch++) {
              p.clear(r, ch); p.clearFx(r, ch);
            }
          }
          this.view.draw();
        } else if (c.col >= 3) {
          p.clearFx(c.row, c.ch);          // fx columns: clear the automation command
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

  // Digit keys edit the instrument (col 1) or volume (col 2) of the note under
  // the cursor, two-digit accumulation per field (e.g. "2" then "5" → 25).
  _handleEdit(e) {
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
    const val = same ? this._digitEntry.first * 10 + d : d;
    this._digitEntry = same ? null : { idx, col: c.col, first: d };
    if (c.col === 1) p.inst[idx] = Math.min(val, this.engine.instruments.length - 1);
    else p.vol[idx] = Math.min(99, val) / 99;
    return true;
  }

  // FX columns: col 3 = command target (opens picker), col 4 = value byte (hex).
  // Consumes all letter/number keys so they never leak to note entry.
  _handleFxEdit(e) {
    const c = this.view.cursor;
    if (!this.view.showFx || c.col < 3) return false;
    const isLetter = /^Key([A-Z])$/.exec(e.code);
    const isDigit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (!isLetter && !isDigit && e.code !== 'Enter') return false;
    e.preventDefault();
    const p = this.view.pattern, idx = p.idx(c.row, c.ch);

    if (c.col === 3) {                         // command → target picker
      if (e.code === 'Enter' || isLetter) this._openFxPicker(isLetter ? isLetter[1] : '');
      return true;                             // consume digits too
    }

    // col 4 — value byte, two-hex accumulation (0-9, A-F). A command must exist.
    if (p.fxCmd[idx] === NO_FX) return true;
    let nyb = null;
    if (isDigit) nyb = parseInt(isDigit[1], 10);
    else if (isLetter && isLetter[1] <= 'F') nyb = parseInt(isLetter[1], 16);
    if (nyb === null) return true;             // non-hex letter: swallow, no-op
    const same = this._hexEntry && this._hexEntry.idx === idx;
    p.fxVal[idx] = (same ? ((this._hexEntry.first << 4) | nyb) : nyb) & 0xff;
    this._hexEntry = same ? null : { idx, first: nyb };
    return true;
  }

  // Best engine type for a cell: its own note's instrument, else the nearest
  // note above it on the channel, else the selected instrument.
  _channelInstType(p, row, ch) {
    if (p.notes[p.idx(row, ch)] >= 0) return this.engine.instruments[p.inst[p.idx(row, ch)]]?.type || '303';
    for (let r = row - 1; r >= 0; r--) {
      const j = p.idx(r, ch);
      if (p.notes[j] >= 0) return this.engine.instruments[p.inst[j]]?.type || '303';
    }
    const sel = this.engine.instruments[this.controls.selected];
    return sel ? sel.type : '303';
  }

  // Modal target picker for the cell under the cursor. `prefill` seeds the filter
  // (so typing a code letter in the command column jumps straight to filtering).
  _openFxPicker(prefill = '') {
    this._closeFxPicker();
    const p = this.view.pattern, c = this.view.cursor;
    const type = this._channelInstType(p, c.row, c.ch);
    const targets = targetsForType(type);
    const idx = p.idx(c.row, c.ch);

    const overlay = document.createElement('div');
    overlay.className = 'fx-picker-overlay';
    overlay.innerHTML = `<div class="fx-picker">
      <div class="fx-picker-title">Automate ${type.toUpperCase()} · Ch ${c.ch + 1}</div>
      <input class="fx-picker-input" placeholder="type code or name…" />
      <ul class="fx-picker-list"></ul>
      <div class="fx-picker-hint">↑↓ select · Enter set · Esc cancel · then type 2 hex digits for the value</div>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.fx-picker-input');
    const list = overlay.querySelector('.fx-picker-list');
    input.value = prefill;

    let sel = 0, filtered = targets;
    const commit = (t) => {
      if (!t) return;
      const keep = p.fxCmd[idx] !== NO_FX ? p.fxVal[idx] : 0x80; // default mid-value
      p.setFx(c.row, c.ch, t.id, keep);
      this._closeFxPicker();
      this.view.cursor.col = 4;     // hop to the value field
      this.view.draw();
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      filtered = targets.filter((t) => !q || t.code.toLowerCase().startsWith(q) || t.label.toLowerCase().includes(q));
      if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1);
      list.innerHTML = filtered.map((t, i) =>
        `<li class="fx-picker-item${i === sel ? ' sel' : ''}${t.scope === 'fx' ? ' fx' : ''}" data-i="${i}">
          <span class="fx-code">${t.code}</span><span class="fx-label">${t.label}</span>
          ${t.scope === 'fx' ? '<span class="fx-tag">track</span>' : ''}</li>`).join('');
      list.querySelectorAll('.fx-picker-item').forEach((li) => {
        li.onclick = () => commit(filtered[+li.dataset.i]);
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
    input.setSelectionRange(input.value.length, input.value.length);
  }

  _closeFxPicker() {
    if (this._fxPicker) { this._fxPicker.remove(); this._fxPicker = null; }
  }

  _updateFxColBtn() {
    const btn = $('fx-col-btn');
    if (!btn) return;
    btn.classList.toggle('on', this.view.showFx);
    this.view.draw();
  }

  // Status-bar buffer control: sets the pipeline's prebuffer depth live and shows
  // the resulting latency. Deeper buffer = fewer underruns, more latency.
  _bindBufferControl() {
    const input = $('prebuffer');
    if (!input) return;
    input.value = this.pipeline.prebufferBlocks;
    input.onchange = () => {
      const v = Math.max(2, Math.min(64, Math.round(+input.value) || this.pipeline.prebufferBlocks));
      input.value = v;
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
        k.el._extSet(live !== undefined ? live : instr[k.bank][k.i]);
      }
      const fp = this.fxParams[this._fxPanelType];
      if (fp && this._fxPanelType === instr.type) {
        for (const k of this._fxKnobs || []) k.el._extSet(fp[k.key]);
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
  _copyBlock(cut) {
    const p = this.view.pattern, s = this.view.selection, c = this.view.cursor;
    const r0 = s ? s.r0 : c.row, r1 = s ? s.r1 : c.row;
    const c0 = s ? s.c0 : c.ch,  c1 = s ? s.c1 : c.ch;
    const cells = [];
    for (let r = r0; r <= r1; r++) {
      const rowCells = [];
      for (let ch = c0; ch <= c1; ch++) {
        const i = p.idx(r, ch);
        rowCells.push({ note: p.notes[i], inst: p.inst[i], vol: p.vol[i], fxCmd: p.fxCmd[i], fxVal: p.fxVal[i] });
        if (cut) { p.clear(r, ch); p.clearFx(r, ch); }
      }
      cells.push(rowCells);
    }
    this._clipboard = { rows: r1 - r0 + 1, chans: c1 - c0 + 1, cells };
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
        if (ch >= p.channels) break;
        const cell = cb.cells[dr][dc], i = p.idx(r, ch);
        p.notes[i] = cell.note; p.inst[i] = cell.inst; p.vol[i] = cell.vol;
        p.fxCmd[i] = cell.fxCmd ?? NO_FX; p.fxVal[i] = cell.fxVal ?? 0;
      }
    }
  }

  async _togglePlay() {
    await this.ensureAudio();
    if (this.engine.playing) this.engine.stop(); else this.engine.play();
  }

  _drawVisualizer() {
    const canvas = $('visualizer');
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
    const freqData = this._freqData;
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
    const waveData = this._waveData;
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

    const tick = () => {
      this.view.draw();
      this._drawVisualizer();
      this._syncKnobs();

      // Reflect play/pause state in button class/text
      if (playBtn) {
        if (this.engine.playing && this.engine.playMode === 'song') {
          if (!playBtn.classList.contains('playing')) {
            playBtn.classList.add('playing');
            playBtn.innerHTML = '⏸︎ Pause';
          }
        } else {
          if (playBtn.classList.contains('playing')) {
            playBtn.classList.remove('playing');
            playBtn.innerHTML = '▶︎ Play';
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
          const lenInput = $('pattern-len');
          if (lenInput && activePat) {
            lenInput.value = activePat.rows;
          }
        }
      }

      if (orderListEl) {
        const orderCards = orderListEl.querySelectorAll('.arranger-card');
        for (const card of orderCards) {
          const idx = parseInt(card.getAttribute('data-order-idx'), 10);
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

  _deletePattern(idx) {
    const song = this.engine.song;
    if (song.patterns.length <= 1) return;
    
    song.patterns.splice(idx, 1);
    
    const newOrder = [];
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
  }

  _updatePatternSelector() {
    const patNum = $('pat-num-display');
    if (patNum) {
      patNum.textContent = String(this.engine.currentPatternIdx);
    }
    const lenInput = $('pattern-len');
    if (lenInput && this.view.pattern) {
      lenInput.value = this.view.pattern.rows;
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
  _fmtTime(sec) {
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
    $('gl-status').innerHTML = `gl: <span class="err">${err.message}</span>`;
    console.error(err);
  }
}
