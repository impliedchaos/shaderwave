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
import { demoSong, DEMO_SONGS, loadSongInstruments, defaultParams, instrumentsFromParams } from './tracker/song.js';
import { instGlow } from './constants.js';
import { OFF, Pattern } from './tracker/pattern.js';
import { GLVisualizer } from './ui/visualizer.js';

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
    this.currentSongIdx = sortedIndices[0].i;
    const initialSong = DEMO_SONGS[this.currentSongIdx];
    const init = loadSongInstruments(initialSong);
    this.engine.instruments = init.instruments;
    this.engine.loadSong(init.data);
    this.engine.bpm = initialSong.bpm;
    this.fxParams = cloneFx(initialSong.fxParams);

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
          return;
        }

        // FX chains are per engine type
        this._buildFxPanel(instr.type);

        // Theme the UI accent with this instance's colour.
        document.documentElement.style.setProperty('--accent', instr.color);
        document.documentElement.style.setProperty('--accent-glow', instGlow(instr.color, 0.2));
        document.documentElement.style.setProperty('--cursor-border', instr.color);
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
    this._loop();

    this.pipeline.onStats = (s) => { this.underruns = s.underruns; };
    setInterval(() => { if (this.audioReady) this.pipeline.requestStats(); }, 500);
  }

  async ensureAudio() {
    if (this.audioReady) return;
    const sr = await this.pipeline.init();
    this.engine.sampleRate = sr;
    this.renderer = new SynthRenderer(this.gl, sr, this.fxParams);
    const produce = (blockStart) => this.renderer.renderBlock(this.engine.advance(blockStart), blockStart);
    await this.pipeline.start(produce);
    this.audioReady = true;
    $('audio-status').innerHTML = `audio: <span class="ok">running</span> @ ${sr | 0}Hz`;
  }

  _buildFxPanel(itName) {
    const defs = [
      { category: 'Distortion', enableKey: 'distOn' },
      { label: 'Tone', key: 'tone', min: 0, max: 1, step: 0.01 },
      { label: 'Level', key: 'level', min: 0, max: 2, step: 0.01 },
      { label: 'Dist', key: 'dist', min: 0.001, max: 20, step: 0.1 },

      { category: 'Bitcrusher', enableKey: 'bitcrushOn' },
      { label: 'Crush Bits', key: 'bitcrushBits', min: 1, max: 16, step: 1 },
      { label: 'Crush Hz', key: 'bitcrushRate', min: 100, max: 22000, step: 100 },

      { category: 'Stereo Field & Output', enableKey: 'widthOn' },
      { label: 'Width', key: 'width', min: 0, max: 2, step: 0.01 },
      { label: 'Master', key: 'master', min: 0, max: 1.5, step: 0.01 },

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
    ];
    const params = this.fxParams[itName];
    const host = $('fx');
    host.innerHTML = '';
    for (const d of defs) {
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
      if (this.engine.playing && this.engine.playMode === 'song') {
        this.engine.stop();
      } else {
        this.engine.play('song');
      }
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
        if (this.engine.playing && this.engine.playMode === 'pattern') {
          this.engine.stop();
        } else {
          this.engine.play('pattern');
        }
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
      exportBtn.onclick = () => this._showExportDialog();
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
      if (this._handleCursor(e)) { e.preventDefault(); return; }
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
    if (this.engine.instruments[this.controls.selected].type === '808') {
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
    // Shift+Up/Down: fine volume nudge on the note under the cursor.
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
        if (c.col > 0) c.col--; else { c.ch = (c.ch - 1 + p.channels) % p.channels; c.col = 2; }
        this._digitEntry = null; return true;
      case 'ArrowRight':
        if (c.col < 2) c.col++; else { c.ch = (c.ch + 1) % p.channels; c.col = 0; }
        this._digitEntry = null; return true;
      case 'Delete':
      case 'Backspace':
        if (this.view.selection) {
          const s = this.view.selection;
          for (let r = s.r0; r <= s.r1; r++) {
            for (let ch = s.c0; ch <= s.c1; ch++) {
              p.clear(r, ch);
            }
          }
          this.view.draw();
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
    if (c.col === 0) return false;                 // note column: let piano keys handle it
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
        rowCells.push({ note: p.notes[i], inst: p.inst[i], vol: p.vol[i] });
        if (cut) p.clear(r, ch);
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

    // Get dynamic colors from css variables
    const css = getComputedStyle(document.documentElement);
    const accentColor = css.getPropertyValue('--accent').trim() || '#00f5d4';
    const accentGlow = css.getPropertyValue('--accent-glow').trim() || 'rgba(0, 245, 212, 0.2)';

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

    // Draw spectrum as translucent glow fill using accent color
    const freqData = new Uint8Array(bufferLength);
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
    const waveData = new Uint8Array(bufferLength);
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
    const tick = () => {
      this.view.draw();
      this._drawVisualizer();

      // Reflect play/pause state in button class/text
      const playBtn = $('play');
      if (playBtn) {
        if (this.engine.playing && this.engine.playMode === 'song') {
          if (!playBtn.classList.contains('playing')) {
            playBtn.classList.add('playing');
            playBtn.innerHTML = '⏸ Pause';
          }
        } else {
          if (playBtn.classList.contains('playing')) {
            playBtn.classList.remove('playing');
            playBtn.innerHTML = '▶ Play';
            this._updatePatternSelector(); // sync back when song stops
          }
        }
      }

      const playPatBtn = $('play-pattern');
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

      const orderCards = document.querySelectorAll('#arranger-order-list .arranger-card');
      for (const card of orderCards) {
        const idx = parseInt(card.getAttribute('data-order-idx'));
        if (idx === activeOrderIdx) {
          if (!card.classList.contains('active-order')) card.classList.add('active-order');
        } else {
          if (card.classList.contains('active-order')) card.classList.remove('active-order');
        }
      }

      $('perf-status').textContent = this.audioReady
        ? `underruns: ${this.underruns}` : '';
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
    const song = this.engine.song;
    if (!song) return;

    const patList = $('arranger-pattern-list');
    if (patList) {
      patList.innerHTML = '';
      song.patterns.forEach((pat, i) => {
        const card = document.createElement('div');
        card.className = 'arranger-card';
        if (i === this.engine.currentPatternIdx) {
          card.classList.add('selected-pattern');
        }
        
        const info = document.createElement('div');
        info.className = 'arranger-card-info';
        info.onclick = () => {
          this.engine.currentPatternIdx = i;
          this._renderSongEditor();
          this._updatePatternSelector();
          this.view.draw();
        };

        const title = document.createElement('div');
        title.className = 'arranger-card-title';
        title.textContent = `🎹 Pattern ${i}`;
        
        const sub = document.createElement('div');
        sub.className = 'arranger-card-sub';
        sub.textContent = `${pat.rows} rows · ${pat.channels} channels`;
        
        info.appendChild(title);
        info.appendChild(sub);
        card.appendChild(info);
        
        const actions = document.createElement('div');
        actions.className = 'arranger-card-actions';
        
        const cloneBtn = document.createElement('button');
        cloneBtn.className = 'arranger-btn';
        cloneBtn.textContent = 'Clone';
        cloneBtn.onclick = (e) => {
          e.stopPropagation();
          const newPat = new Pattern(pat.rows, pat.channels);
          newPat.notes.set(pat.notes);
          newPat.inst.set(pat.inst);
          newPat.vol.set(pat.vol);
          song.patterns.push(newPat);
          this.engine.currentPatternIdx = song.patterns.length - 1;
          this._renderSongEditor();
          this._updatePatternSelector();
          this.view.draw();
        };
        actions.appendChild(cloneBtn);
        
        if (song.patterns.length > 1) {
          const delBtn = document.createElement('button');
          delBtn.className = 'arranger-btn danger';
          delBtn.textContent = 'Delete';
          delBtn.onclick = (e) => {
            e.stopPropagation();
            this._deletePattern(i);
          };
          actions.appendChild(delBtn);
        }
        
        card.appendChild(actions);
        patList.appendChild(card);
      });
    }

    const orderList = $('arranger-order-list');
    if (orderList) {
      orderList.innerHTML = '';
      song.order.forEach((patIdx, i) => {
        const card = document.createElement('div');
        card.className = 'arranger-card';
        card.setAttribute('data-order-idx', i);
        
        const info = document.createElement('div');
        info.className = 'arranger-card-info';
        
        const title = document.createElement('div');
        title.className = 'arranger-card-title';
        title.textContent = `#${i + 1} Slot`;
        
        const select = document.createElement('select');
        select.className = 'arranger-select';
        song.patterns.forEach((p, pIdx) => {
          const opt = document.createElement('option');
          opt.value = pIdx;
          opt.textContent = `Pattern ${pIdx}`;
          if (pIdx === patIdx) opt.selected = true;
          select.appendChild(opt);
        });
        select.onchange = (e) => {
          song.order[i] = parseInt(e.target.value);
          this._renderSongEditor();
        };
        
        info.appendChild(title);
        info.appendChild(select);
        card.appendChild(info);
        
        const actions = document.createElement('div');
        actions.className = 'arranger-card-actions';
        
        const upBtn = document.createElement('button');
        upBtn.className = 'arranger-btn';
        upBtn.textContent = '▲';
        upBtn.disabled = i === 0;
        upBtn.onclick = (e) => {
          e.stopPropagation();
          if (i > 0) {
            const temp = song.order[i];
            song.order[i] = song.order[i - 1];
            song.order[i - 1] = temp;
            this._renderSongEditor();
          }
        };
        actions.appendChild(upBtn);
        
        const downBtn = document.createElement('button');
        downBtn.className = 'arranger-btn';
        downBtn.textContent = '▼';
        downBtn.disabled = i === song.order.length - 1;
        downBtn.onclick = (e) => {
          e.stopPropagation();
          if (i < song.order.length - 1) {
            const temp = song.order[i];
            song.order[i] = song.order[i + 1];
            song.order[i + 1] = temp;
            this._renderSongEditor();
          }
        };
        actions.appendChild(downBtn);
        
        if (song.order.length > 1) {
          const rmBtn = document.createElement('button');
          rmBtn.className = 'arranger-btn danger';
          rmBtn.textContent = '✖';
          rmBtn.onclick = (e) => {
            e.stopPropagation();
            song.order.splice(i, 1);
            this._renderSongEditor();
          };
          actions.appendChild(rmBtn);
        }
        
        card.appendChild(actions);
        orderList.appendChild(card);
      });
    }
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

  _getSanitizedFilename(songName) {
    if (!songName) return 'untitled_song';
    return songName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled_song';
  }

  _showExportDialog() {
    const song = DEMO_SONGS[this.currentSongIdx];
    const defaultTitle = this.customSongName || (song ? song.name : 'Untitled');
    const defaultFilename = this._getSanitizedFilename(defaultTitle);
    
    $('export-song-title').value = defaultTitle;
    $('export-song-author').value = 'AI Slop';
    $('export-filename').value = defaultFilename;
    
    document.getElementsByName('export-format')[1].checked = true;
    $('export-visualizer-row').style.display = 'flex';
    
    $('export-config-panel').style.display = 'flex';
    $('export-progress-panel').style.display = 'none';
    $('export-overlay').style.display = 'flex';
    
    const radios = document.getElementsByName('export-format');
    radios.forEach(radio => {
      radio.onchange = (e) => {
        if (e.target.value === 'webm') {
          $('export-visualizer-row').style.display = 'flex';
        } else {
          $('export-visualizer-row').style.display = 'none';
        }
      };
    });
    
    $('export-close-btn').onclick = () => {
      $('export-overlay').style.display = 'none';
    };
    
    $('export-start-btn').onclick = () => {
      const title = $('export-song-title').value.trim() || 'Untitled Song';
      const author = $('export-song-author').value.trim() || 'AI Slop';
      const filename = $('export-filename').value.trim() || 'untitled_song';
      const format = document.querySelector('input[name="export-format"]:checked').value;
      const includeVisualizer = $('export-include-visualizer').checked;
      
      $('export-config-panel').style.display = 'none';
      $('export-progress-panel').style.display = 'flex';
      
      if (format === 'wav') {
        this._exportWav(filename, title, author);
      } else {
        this._exportVideo(filename, title, author, includeVisualizer);
      }
    };
  }

  _writeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (view, offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 2, true); // 2 channels
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  async _exportWav(filename, title, author) {
    await this.ensureAudio();
    
    const wasPlaying = this.engine.playing;
    this.engine.stop();
    
    this.pipeline.stop();
    
    const overlay = $('export-overlay');
    const progress = $('export-progress');
    const statusText = $('export-status-text');
    const cancelBtn = $('export-cancel');
    const progressTitle = $('export-progress-title');
    
    progressTitle.textContent = 'Exporting Audio';
    progress.style.width = '0%';
    statusText.textContent = 'Initializing offline render...';
    cancelBtn.textContent = 'Cancel';
    
    let cancelled = false;
    
    const restoreAudio = async () => {
      if (this.pipeline.produce) {
        await this.pipeline.start(this.pipeline.produce);
      }
      this.engine.stop();
      if (wasPlaying && !cancelled) this.engine.play();
    };
    
    cancelBtn.onclick = () => {
      cancelled = true;
      overlay.style.display = 'none';
      restoreAudio();
    };
    
    this.renderer.resetState();
    this.engine.playMode = 'song';
    this.engine.playing = true;
    this.engine.startFrame = 0;
    
    for (const v of this.engine.voices) {
      v.active = false;
      v.onFrame = 0;
      v.offFrame = 1e9;
    }
    
    const totalFrames = Math.ceil(this.engine.totalRows * this.engine.samplesPerRow);
    const samples = new Float32Array(totalFrames * 2);
    
    let blockStart = 0;
    const BLOCK_SIZE = 512;
    const blocksPerBatch = 40; 
    
    const renderBatch = () => {
      if (cancelled) return;
      
      for (let b = 0; b < blocksPerBatch && blockStart < totalFrames; b++) {
        const vd = this.engine.advance(blockStart);
        const out = this.renderer.renderBlock(vd, blockStart);
        
        const framesToCopy = Math.min(BLOCK_SIZE, totalFrames - blockStart);
        for (let i = 0; i < framesToCopy; i++) {
          samples[(blockStart + i) * 2] = out[i * 2];
          samples[(blockStart + i) * 2 + 1] = out[i * 2 + 1];
        }
        blockStart += BLOCK_SIZE;
      }
      
      const pct = Math.min(100, Math.floor((blockStart / totalFrames) * 100));
      progress.style.width = `${pct}%`;
      statusText.textContent = `Rendered ${pct}% (${Math.floor(blockStart / this.engine.sampleRate)}s / ${Math.floor(totalFrames / this.engine.sampleRate)}s)`;
      
      if (blockStart < totalFrames) {
        requestAnimationFrame(renderBatch);
      } else {
        statusText.textContent = 'Encoding WAV file...';
        
        setTimeout(() => {
          try {
            const blob = this._writeWav(samples, this.engine.sampleRate);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}.wav`;
            a.click();
            URL.revokeObjectURL(url);
            statusText.textContent = 'Done!';
            setTimeout(() => {
              overlay.style.display = 'none';
              restoreAudio();
            }, 500);
          } catch (e) {
            statusText.textContent = `Error: ${e.message}`;
            cancelBtn.textContent = 'Close';
            cancelBtn.onclick = () => {
              overlay.style.display = 'none';
              restoreAudio();
            };
          }
        }, 50);
      }
    };
    
    requestAnimationFrame(renderBatch);
  }

  async _exportVideo(filename, title, author, includeVisualizer) {
    await this.ensureAudio();
    
    const wasPlaying = this.engine.playing;
    this.engine.stop();
    
    const overlay = $('export-overlay');
    const progress = $('export-progress');
    const statusText = $('export-status-text');
    const cancelBtn = $('export-cancel');
    const progressTitle = $('export-progress-title');
    
    progressTitle.textContent = 'Recording Video';
    progress.style.width = '0%';
    statusText.textContent = 'Preparing 720p recording stream...';
    cancelBtn.textContent = 'Cancel';
    
    const ctx = this.pipeline.ctx;
    const dest = ctx.createMediaStreamDestination();
    
    this.pipeline.analyser.connect(dest);
    
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0.0;
    try {
      this.pipeline.analyser.disconnect(ctx.destination);
    } catch (e) {
      console.warn('Failed to disconnect analyser from destination:', e);
    }
    this.pipeline.analyser.connect(muteGain);
    muteGain.connect(ctx.destination);
    
    const audioTrack = dest.stream.getAudioTracks()[0];
    let recordStream;
    let recordCanvas = null;
    let recordVisualizer = null;
    
    if (includeVisualizer) {
      recordCanvas = document.createElement('canvas');
      recordCanvas.width = 1280;
      recordCanvas.height = 720;
      recordCanvas.style.cssText = 'position: fixed; left: -9999px; top: -9999px; width: 1280px; height: 720px; z-index: -1000; pointer-events: none;';
      document.body.appendChild(recordCanvas);
      
      recordVisualizer = new GLVisualizer(recordCanvas);
      const canvasStream = recordCanvas.captureStream(30); 
      if (audioTrack) {
        audioTrack.enabled = true;
        canvasStream.addTrack(audioTrack);
      }
      recordStream = canvasStream;
    } else {
      recordStream = dest.stream;
    }
    
    let options = { 
      mimeType: 'video/webm;codecs=vp9,opus',
      audioBitsPerSecond: 192000,
      videoBitsPerSecond: 1024000
    };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { 
        mimeType: 'video/webm;codecs=vp8,opus',
        audioBitsPerSecond: 192000,
        videoBitsPerSecond: 1024000
      };
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { 
        mimeType: 'video/webm',
        audioBitsPerSecond: 192000,
        videoBitsPerSecond: 1024000
      };
    }
    
    const recorder = new MediaRecorder(recordStream, options);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    
    let cancelled = false;
    
    const cleanUp = () => {
      this.engine.stop();
      if (this.pipeline && this.pipeline.node) {
        this.pipeline.node.port.postMessage({ cmd: 'reset' });
      }
      // Reset frame counters so the fill loop doesn't think the queue is
      // already saturated from the export session's accumulated frames.
      this.pipeline.writtenFrames = 0;
      this.pipeline.consumedFrames = 0;
      try {
        this.pipeline.analyser.disconnect(dest);
      } catch (e) {}
      try {
        this.pipeline.analyser.disconnect(muteGain);
      } catch (e) {}
      try {
        muteGain.disconnect(ctx.destination);
      } catch (e) {}
      try {
        this.pipeline.analyser.connect(ctx.destination);
      } catch (e) {
        console.warn('Failed to reconnect analyser:', e);
      }
      if (recordCanvas && recordCanvas.parentNode) {
        recordCanvas.parentNode.removeChild(recordCanvas);
      }
      overlay.style.display = 'none';
      if (wasPlaying && !cancelled) this.engine.play();
    };
    
    cancelBtn.onclick = () => {
      cancelled = true;
      recorder.stop();
      cleanUp();
    };
    
    recorder.onstop = () => {
      if (cancelled) return;
      statusText.textContent = `Saving ${includeVisualizer ? '720p WebM' : 'WebM audio'} file...`;
      
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      
      statusText.textContent = 'Done!';
      setTimeout(() => {
        cleanUp();
      }, 500);
    };
    
    this.renderer.resetState();
    this.engine.playMode = 'song';
    this.engine.play('song');
    recorder.start();
    
    const totalRows = this.engine.totalRows;
    this.lastRecordedRow = 0;
    let recordedRowsCount = 0;
    
    const checkProgress = () => {
      if (cancelled || recorder.state !== 'recording') return;
      
      let currentRow = 0;
      for (let i = 0; i < this.engine.displayOrder; i++) {
        const patIdx = this.engine.song.order[i];
        const pat = this.engine.song.patterns[patIdx];
        if (pat) currentRow += pat.rows;
      }
      currentRow += this.engine.displayRow;
      const totalRecordedPct = Math.min(100, Math.floor((currentRow / totalRows) * 100));
      
      progress.style.width = `${totalRecordedPct}%`;
      statusText.textContent = `Recording row ${currentRow} / ${totalRows} (${totalRecordedPct}%)`;
      
      if (recordVisualizer) {
        let freqData = null;
        let waveData = null;
        if (this.pipeline && this.pipeline.analyser) {
          const analyser = this.pipeline.analyser;
          freqData = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(freqData);
          waveData = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteTimeDomainData(waveData);
        }
        const css = getComputedStyle(document.documentElement);
        const accentColor = css.getPropertyValue('--accent').trim() || '#00f5d4';
        recordVisualizer.draw(freqData, waveData, this.engine.bpm, true, accentColor);
      }
      
      if (currentRow !== this.lastRecordedRow) {
        this.lastRecordedRow = currentRow;
      }
      
      if (!this.engine.playing) {
        // Wait 1.0s for the audio buffer and reverb/delay tail to drain completely.
        statusText.textContent = 'Draining audio tail...';
        setTimeout(() => {
          if (!cancelled && recorder.state === 'recording') {
            recorder.stop();
          }
        }, 1000);
        return;
      }
      
      requestAnimationFrame(checkProgress);
    };
    
    requestAnimationFrame(checkProgress);
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
