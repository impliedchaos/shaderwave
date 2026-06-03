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
import { demoSong, DEMO_SONGS, loadSongInstruments } from './tracker/song.js';
import { instGlow } from './constants.js';
import { EMPTY, OFF } from './tracker/pattern.js';

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

class App {
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
    this.currentSongIdx = 0;
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
          if (params[d.enableKey] === undefined) params[d.enableKey] = true;
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
    $('play').onclick = async () => { await this.ensureAudio(); this.engine.play(); };
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
      DEMO_SONGS.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = s.name;
        songSelect.appendChild(o);
      });
      songSelect.value = String(this.currentSongIdx);
      songSelect.onchange = (e) => {
        const idx = parseInt(e.target.value);
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

          // Reset to a valid instance and rebuild the selector + all panels.
          this.controls.selected = 0;
          this.controls.select(0);

          this.view.cursor.row = 0;
          this.view.cursor.ch = 0;
          const lenInput = $('pattern-len');
          if (lenInput) lenInput.value = this.view.pattern.rows;
          this.view.draw();

          if (wasPlaying) {
            this.engine.play();
          }
        }
      };
    }
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
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
      if (this._handleCursor(e)) return;

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
    if (e.shiftKey) {
      if (e.code === 'ArrowUp') {
        const idx = p.idx(c.row, c.ch);
        if (p.notes[idx] !== EMPTY) {
          p.vol[idx] = Math.min(1.0, Math.max(0.0, p.vol[idx] + 0.05));
        }
        return true;
      }
      if (e.code === 'ArrowDown') {
        const idx = p.idx(c.row, c.ch);
        if (p.notes[idx] !== EMPTY) {
          p.vol[idx] = Math.min(1.0, Math.max(0.0, p.vol[idx] - 0.05));
        }
        return true;
      }
    }
    switch (e.code) {
      case 'ArrowUp': c.row = (c.row - 1 + p.rows) % p.rows; return true;
      case 'ArrowDown': c.row = (c.row + 1) % p.rows; return true;
      case 'ArrowLeft': c.ch = (c.ch - 1 + p.channels) % p.channels; return true;
      case 'ArrowRight': c.ch = (c.ch + 1) % p.channels; return true;
      case 'Delete': case 'Backspace': p.clear(c.row, c.ch); this._advanceCursorRow(); return true;
      case 'Equal': p.set(c.row, c.ch, OFF, this.controls.selected); this._advanceCursorRow(); return true;
      default: return false;
    }
  }

  _advanceCursorRow() {
    const p = this.view.pattern;
    this.view.cursor.row = (this.view.cursor.row + 1) % p.rows;
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
        if (this.engine.playing) {
          if (!playBtn.classList.contains('playing')) {
            playBtn.classList.add('playing');
            playBtn.innerHTML = '⏸ Pause';
          }
        } else {
          if (playBtn.classList.contains('playing')) {
            playBtn.classList.remove('playing');
            playBtn.innerHTML = '▶ Play';
          }
        }
      }

      $('perf-status').textContent = this.audioReady
        ? `underruns: ${this.underruns}` : '';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

try {
  new App();
} catch (err) {
  $('gl-status').innerHTML = `gl: <span class="err">${err.message}</span>`;
  console.error(err);
}
