// Sidebar: instrument selector + parameter sliders. The selector lists the
// engine's instrument table (instances); editing a slider writes straight into
// the selected instance, which the engine snapshots onto each new note.
import { INSTRUMENTS, instGlow } from '../constants.js';
import { DEMO_SONGS } from '../tracker/song.js';
import { defaultFxParams } from '../gl/effects.js';
import { PRESETS } from './presets.js';

const DX7_ROMS = [
  { name: 'ROM 1A - Keyboard / Pluck', file: 'rom1a.syx' },
  { name: 'ROM 1B - Brass / Synth', file: 'rom1b.syx' },
  { name: 'ROM 2A - Guitars / Keys', file: 'rom2a.syx' },
  { name: 'ROM 2B - Bass / Drums', file: 'rom2b.syx' },
  { name: 'ROM 3A - Strings / Pads', file: 'rom3a.syx' },
  { name: 'ROM 3B - SFX / Percussion', file: 'rom3b.syx' },
  { name: 'ROM 4A - Classical / Organ', file: 'rom4a.syx' },
  { name: 'ROM 4B - Orchestral / Brass', file: 'rom4b.syx' },
  { name: 'Bass', file: 'solidlatelybass.syx' },
  { name: 'AI Slop', file: 'aislop.syx' }
];

// Slider metadata. `bank`/`i` index into params[inst].p0 / p1.
const PARAM_DEFS = {
  '303': [
    { label: 'Cutoff', bank: 'p0', i: 0, min: 30, max: 4000, step: 1 },
    { label: 'Reso', bank: 'p0', i: 1, min: 0, max: 0.98, step: 0.01 },
    { label: 'EnvMod', bank: 'p0', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'Accent', bank: 'p0', i: 3, min: 0, max: 1, step: 0.01 },
    { label: 'Wave', bank: 'p1', i: 0, min: 0, max: 4, step: 1 },
    { label: 'FiltDecay', bank: 'p1', i: 1, min: 0.05, max: 1, step: 0.01 },
    { label: 'AmpDecay', bank: 'p1', i: 2, min: 0.05, max: 1, step: 0.01 },
  ],
  '808': [
    { label: 'Tone', bank: 'p0', i: 1, min: 0, max: 1, step: 0.01 },
    { label: 'Decay', bank: 'p0', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'Snappy', bank: 'p0', i: 3, min: 0, max: 1, step: 0.01 },
  ],
  'moog': [
    { label: 'Cutoff', bank: 'p0', i: 0, min: 30, max: 6000, step: 1 },
    { label: 'Reso', bank: 'p0', i: 1, min: 0, max: 0.98, step: 0.01 },
    { label: 'EnvAmt', bank: 'p0', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'KbdTrack', bank: 'p0', i: 3, min: 0, max: 1, step: 0.01 },
    { label: 'Detune', bank: 'p1', i: 0, min: 0, max: 30, step: 0.5 },
    { label: 'AmpSus', bank: 'p1', i: 1, min: 0, max: 1, step: 0.01 },
    { label: 'FiltDecay', bank: 'p1', i: 2, min: 0.05, max: 2, step: 0.01 },
    { label: 'AmpDecay', bank: 'p1', i: 3, min: 0.05, max: 2, step: 0.01 },
    { label: 'Osc1 Wave', bank: 'p2', i: 0, min: 0, max: 4, step: 1 },
    { label: 'Osc2 Wave', bank: 'p2', i: 1, min: 0, max: 4, step: 1 },
    { label: 'Osc3 Wave', bank: 'p2', i: 2, min: 0, max: 4, step: 1 },
    { label: 'Glide', bank: 'p2', i: 3, min: 0, max: 1.5, step: 0.01 },
    { label: 'Osc1 Oct', bank: 'p3', i: 0, min: 0, max: 4, step: 1 },
    { label: 'Osc2 Oct', bank: 'p3', i: 1, min: 0, max: 4, step: 1 },
    { label: 'Osc3 Oct', bank: 'p3', i: 2, min: 0, max: 4, step: 1 },
    { label: 'Noise', bank: 'p3', i: 3, min: 0, max: 1, step: 0.01 },
  ],
};

// Display labels for the Moog stepped osc knobs.
const MOOG_WAVES = { 0: 'Tri', 1: 'Saw', 2: 'Square', 3: 'WidePul', 4: 'NarPul' };
const MOOG_OCTS = { 0: "32'", 1: "16'", 2: "8'", 3: "4'", 4: "2'" };

// DX7 slider set (global algorithm/feedback + per-operator params). Static, so
// it lives at module scope rather than being rebuilt on every _buildParams call.
const DX7_PARAM_DEFS = [
  { label: 'Algo', type: 'global', bank: 'p1', i: 0, min: 1, max: 32, step: 1 },
  { label: 'Feedback', type: 'global', bank: 'p0', i: 3, min: 0, max: 1.5, step: 0.01 },
  { label: 'Op Mode', type: 'op', key: 'mode', min: 0, max: 1, step: 1 },
  { label: 'Op Coarse', type: 'op', key: 'coarse', min: 0.5, max: 31, step: 0.5 },
  { label: 'Op Fine', type: 'op', key: 'fine', min: 0, max: 99, step: 1 },
  { label: 'Op Level', type: 'op', key: 'level', min: 0, max: 99, step: 1 },
  { label: 'Op Detune', type: 'op', key: 'detune', min: -7, max: 7, step: 1 },
  { label: 'Op Decay', type: 'op', key: 'decay', min: 0.05, max: 4, step: 0.01 },
  { label: 'Op Sustain', type: 'op', key: 'sustain', min: 0, max: 1, step: 0.01 },
  { label: 'Op Release', type: 'op', key: 'release', min: 0.05, max: 4, step: 0.01 },
];

export class Controls {
  constructor(engine, { instEl, paramEl, onSelect, onPresetChange, app }) {
    this.engine = engine;
    this.instEl = instEl;
    this.paramEl = paramEl;
    this.onSelect = onSelect;
    this.onPresetChange = onPresetChange;
    this.app = app;
    this.selected = 0;
    this.activeOp = 0;
    this.dx7Patches = null;
    this.activeRomFile = DX7_ROMS[0].file;
    this.romCache = {};

    // Initialize Operator select dropdown if it exists
    const opSelect = document.getElementById('operator-select');
    if (opSelect) {
      this.activeOp = parseInt(opSelect.value) || 0;
      opSelect.onchange = (e) => {
        this.activeOp = parseInt(e.target.value);
        this._buildParams();
      };
    }

    // Initialize ROM select dropdown if it exists
    const romSelect = document.getElementById('sysex-rom');
    if (romSelect) {
      romSelect.innerHTML = '';
      DX7_ROMS.forEach((rom) => {
        const opt = document.createElement('option');
        opt.value = rom.file;
        opt.textContent = rom.name;
        romSelect.appendChild(opt);
      });
      romSelect.onchange = (e) => {
        this.loadRom(e.target.value, true);
      };
    }

    // Initialize Preset select dropdown if it exists
    const presetSelect = document.getElementById('instrument-preset');
    if (presetSelect) {
      presetSelect.onchange = (e) => {
        const presetIdx = parseInt(e.target.value);
        this.loadPreset(presetIdx);
      };
    }

    // Preload all ROM banks
    this.loadAllRoms();

    this._buildAddMenu();
    this._buildInstruments();
    this._buildParams();
  }

  async loadAllRoms() {
    for (const rom of DX7_ROMS) {
      try {
        const response = await fetch(`./sysex/DX7/${rom.file}`);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          this.romCache[rom.file] = this.parseSysex(data);
        }
      } catch (err) {
        console.error(`Failed to cache ROM ${rom.file}:`, err);
      }
    }
    this.dx7Patches = this.romCache[this.activeRomFile] || null;
    if (this._type === 'dx7') {
      this._populatePresets();
    }
  }

  // The currently selected instrument-table instance and its engine type.
  get _instr() { return this.engine.instruments[this.selected]; }
  get _type() { return this._instr ? this._instr.type : null; }

  // The "+ Add" dropdown (above the list) — pick an engine type to append.
  _buildAddMenu() {
    const sel = document.getElementById('inst-add');
    if (!sel) return;
    sel.innerHTML = '<option value="">+ Add</option>'
      + INSTRUMENTS.map((t) => `<option value="${t}">${t.toUpperCase()}</option>`).join('');
    sel.value = '';
    sel.onchange = (e) => {
      const type = e.target.value;
      e.target.value = '';
      if (!type) return;

      if (this.app && this.app.fxParams) {
        if (!this.app.fxParams[type]) {
          this.app.fxParams[type] = defaultFxParams();
        }
        const fx = this.app.fxParams[type];
        fx.enabled = false;
        fx.distOn = false;
        fx.chorusOn = false;
        fx.tremoloOn = false;
        fx.delayOn = false;
        fx.reverbOn = false;
        fx.widthOn = false;
        fx.bitcrushOn = false;

        if (this.app.renderer) {
          for (const it of this.app.renderer.inst) {
            if (it.name === type) {
              it.fx.params = fx;
            }
          }
        }
      }

      const idx = this.engine.addInstrument(type);
      this.select(idx);   // select() rebuilds the list
    };
  }

  _buildInstruments() {
    this.instEl.innerHTML = '';
    this.engine.instruments.forEach((instr, i) => {
      const b = document.createElement('button');
      const num = document.createElement('span');
      num.className = 'inst-num';
      num.textContent = String(i).padStart(2, '0') + ':';
      const label = document.createElement('span');
      label.className = 'inst-name';
      label.textContent = instr.name || instr.type.toUpperCase();
      b.append(num, label);
      const sel = i === this.selected;
      b.className = sel ? 'sel' : '';
      // Each instance carries its own colour so duplicate engines are
      // distinguishable here and in the tracker grid.
      b.style.color = instr.color;
      if (sel) {
        b.style.borderColor = instr.color;
        b.style.boxShadow = `0 0 12px ${instGlow(instr.color)}, inset 0 0 8px ${instGlow(instr.color)}`;
        b.style.textShadow = `0 0 8px ${instGlow(instr.color)}`;
      }
      b.title = 'Click to select · right-click to remove';
      b.onclick = () => { this.select(i); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        if (this.engine.removeInstrument(i)) {
          if (this.selected >= this.engine.instruments.length) {
            this.selected = this.engine.instruments.length - 1;
          }
          this.select(this.selected);   // select() rebuilds the list
        }
      };
      this.instEl.appendChild(b);
    });
  }

  select(i) {
    this.selected = i;
    // Rebuild the list so per-instance colours/glow recompute for the new
    // selection (a plain class toggle would leave the old button's inline glow).
    this._buildInstruments();

    // Toggle UI visibility for ROM and Operator selectors
    const isDX7 = this._type === 'dx7';
    const sysexRow = document.getElementById('sysex-select-row');
    const opRow = document.getElementById('op-select-row');
    if (sysexRow) sysexRow.style.display = isDX7 ? 'flex' : 'none';
    if (opRow) opRow.style.display = isDX7 ? 'flex' : 'none';

    // Populate presets dropdown for selected instrument
    this._populatePresets();

    // Build params from current engine state (don't auto-load a preset,
    // which would overwrite any song-specific parameter values)
    this._buildParams();
    if (this.onSelect) this.onSelect(i);
  }

  _findMatchingPreset() {
    const instName = this._type;
    const pr = this._instr;
    if (!instName || !pr) return { rom: null, index: -1 };

    if (instName === 'dx7') {
      for (const romFile of Object.keys(this.romCache)) {
        const patches = this.romCache[romFile];
        for (let idx = 0; idx < patches.length; idx++) {
          const patch = patches[idx];
          if (pr.p1[0] !== patch.algo) continue;
          if (Math.abs(pr.p0[3] - patch.feedback) > 0.12) continue;
          let match = true;
          for (let k = 0; k < 6; k++) {
            const op = pr.ops[k];
            const pop = patch.ops[k];
            if (!op || !pop) {
              match = false;
              break;
            }
            const opCoarse = op.coarse !== undefined ? op.coarse : 1.0;
            const popCoarse = pop.coarse !== undefined ? pop.coarse : 1.0;
            const opFine = op.fine !== undefined ? op.fine : 0;
            const popFine = pop.fine !== undefined ? pop.fine : 0;
            const opLevel = op.level !== undefined ? op.level : 0;
            const popLevel = pop.level !== undefined ? pop.level : 0;
            const opDetune = op.detune !== undefined ? op.detune : 0;
            const popDetune = pop.detune !== undefined ? pop.detune : 0;
            const opDecay = op.decay !== undefined ? op.decay : 0.5;
            const popDecay = pop.decay !== undefined ? pop.decay : 0.5;
            const opMode = op.mode !== undefined ? op.mode : 0;
            const popMode = pop.mode !== undefined ? pop.mode : 0;
            const opSustain = op.sustain !== undefined ? op.sustain : 0.7;
            const popSustain = pop.sustain !== undefined ? pop.sustain : 0.7;
            const opRelease = op.release !== undefined ? op.release : 0.25;
            const popRelease = pop.release !== undefined ? pop.release : 0.25;

            if (opCoarse !== popCoarse ||
                opFine !== popFine ||
                opLevel !== popLevel ||
                opDetune !== popDetune ||
                Math.abs(opDecay - popDecay) > 0.05 ||
                opMode !== popMode ||
                Math.abs(opSustain - popSustain) > 0.02 ||
                Math.abs(opRelease - popRelease) > 0.05) {
              match = false;
              break;
            }
          }
          if (match) return { rom: romFile, index: idx };
        }
      }
    } else {
      const plist = PRESETS[instName];
      if (!plist) return { rom: null, index: -1 };
      for (let idx = 0; idx < plist.length; idx++) {
        const preset = plist[idx];
        if (!preset.p0 || !preset.p1 || pr.p0.length !== preset.p0.length || pr.p1.length !== preset.p1.length) {
          continue;
        }
        let match = true;
        for (let i = 0; i < pr.p0.length; i++) {
          if (Math.abs(pr.p0[i] - preset.p0[i]) > 0.001) {
            match = false;
            break;
          }
        }
        if (!match) continue;
        for (let i = 0; i < pr.p1.length; i++) {
          if (Math.abs(pr.p1[i] - preset.p1[i]) > 0.001) {
            match = false;
            break;
          }
        }
        if (match) return { rom: null, index: idx };
      }
    }
    return { rom: null, index: -1 };
  }

  _populatePresets() {
    const presetSelect = document.getElementById('instrument-preset');
    if (!presetSelect) return;
    
    presetSelect.innerHTML = '';
    const instName = this._type;
    if (!instName) return;

    // Add a blank option at the top
    const blankOpt = document.createElement('option');
    blankOpt.value = -1;
    blankOpt.textContent = '';
    presetSelect.appendChild(blankOpt);

    if (instName === 'dx7' && this.dx7Patches) {
      this.dx7Patches.forEach((p, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${idx + 1}: ${p.name}`;
        presetSelect.appendChild(opt);
      });
    } else if (PRESETS[instName]) {
      PRESETS[instName].forEach((p, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = p.name;
        presetSelect.appendChild(opt);
      });
    }

    const match = this._findMatchingPreset();
    if (instName === 'dx7' && match.rom && match.rom !== this.activeRomFile) {
      this.loadRom(match.rom, false);
      return;
    }
    presetSelect.value = match.index;
  }

  loadPreset(presetIdx) {
    if (presetIdx === -1) return;
    const instName = this._type;
    if (!instName) return;
    if (instName === 'dx7') {
      if (this.dx7Patches && this.dx7Patches[presetIdx]) {
        const patch = this.dx7Patches[presetIdx];
        const pr = this._instr;
        pr.p1[0] = patch.algo;
        pr.p0[3] = patch.feedback;
        for (let k = 0; k < 6; k++) {
          pr.ops[k].coarse = patch.ops[k].coarse;
          pr.ops[k].fine = patch.ops[k].fine;
          pr.ops[k].level = patch.ops[k].level;
          pr.ops[k].detune = patch.ops[k].detune;
          pr.ops[k].decay = patch.ops[k].decay;
          pr.ops[k].mode = patch.ops[k].mode !== undefined ? patch.ops[k].mode : 0;
          pr.ops[k].sustain = patch.ops[k].sustain !== undefined ? patch.ops[k].sustain : 0.7;
          pr.ops[k].release = patch.ops[k].release !== undefined ? patch.ops[k].release : 0.25;
        }
      }
    } else {
      const plist = PRESETS[instName];
      if (plist && plist[presetIdx]) {
        const preset = plist[presetIdx];
        const prDst = this._instr;
        prDst.p0 = [...preset.p0];
        prDst.p1 = [...preset.p1];
        // Moog carries the extra osc/glide/noise banks; reset to the classic
        // Model D default (3 saws at 8') when a preset doesn't specify them.
        if (instName === 'moog') {
          prDst.p2 = preset.p2 ? [...preset.p2] : [1, 1, 1, 0];
          prDst.p3 = preset.p3 ? [...preset.p3] : [2, 2, 2, 0];
        }
        if (this.onPresetChange && preset.fx) {
          this.onPresetChange(instName, preset.fx);
        }
      }
    }
    this._buildParams();
    const presetSelect = document.getElementById('instrument-preset');
    if (presetSelect) {
      presetSelect.value = presetIdx;
    }
  }

  async loadRom(filename, autoLoadFirstPreset = false) {
    if (this.romCache[filename]) {
      this.activeRomFile = filename;
      this.dx7Patches = this.romCache[filename];
      const romSelect = document.getElementById('sysex-rom');
      if (romSelect) {
        romSelect.value = filename;
      }
      if (this._type === 'dx7') {
        this._populatePresets();
        if (autoLoadFirstPreset) {
          this.loadPreset(0);
        }
      }
    } else {
      try {
        const response = await fetch(`./sysex/DX7/${filename}`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const patches = this.parseSysex(data);
        this.romCache[filename] = patches;
        this.activeRomFile = filename;
        this.dx7Patches = patches;
        const romSelect = document.getElementById('sysex-rom');
        if (romSelect) {
          romSelect.value = filename;
        }
        if (this._type === 'dx7') {
          this._populatePresets();
          if (autoLoadFirstPreset) {
            this.loadPreset(0);
          }
        }
      } catch (err) {
        console.error("Failed to load DX7 SysEx ROM:", err);
      }
    }
  }

  parseSysex(data) {
    if (data[0] !== 0xF0 || data[1] !== 0x43) {
      console.warn("Invalid SysEx header, attempting to parse anyway...");
    }
    
    const patches = [];
    // 32 voices, each voice is 128 bytes, starting at offset 6
    for (let i = 0; i < 32; i++) {
      const offset = 6 + i * 128;
      if (offset + 128 > data.length) break;
      
      const voiceData = data.subarray(offset, offset + 128);
      
      // Extract voice name from bytes 118 to 127
      let name = "";
      for (let c = 0; c < 10; c++) {
        const charCode = voiceData[118 + c];
        if (charCode >= 32 && charCode <= 126) {
          name += String.fromCharCode(charCode);
        } else {
          name += " ";
        }
      }
      name = name.trim() || `Patch ${i + 1}`;
      
      // Extract algorithm and feedback
      const algo = (voiceData[110] & 31) + 1; // 1 to 32
      const feedback = (voiceData[111] & 7) * (1.5 / 7.0); // scale 0-7 to 0-1.5
      
      // Extract operator parameters
      const ops = [];
      for (let k = 0; k < 6; k++) {
        // Operators are stored in reverse order: Op 6 is offset 0, Op 1 is offset 85
        const opOffset = (5 - k) * 17;
        
        const rate2 = voiceData[opOffset + 1];
        const decay = Math.max(0.05, 4.0 * (1.0 - rate2 / 99.0));
        
        const level = voiceData[opOffset + 14];
        
        const mode_coarse = voiceData[opOffset + 15];
        const mode = mode_coarse & 1;
        let coarse = (mode_coarse >> 1) & 31;
        if (mode === 0) {
          coarse = coarse === 0 ? 0.5 : coarse;
        } else {
          // Fixed frequency mode: coarse is 0, 1, 2, or 3, corresponding to 1, 10, 100, 1000 Hz
        }
        
        const fine = voiceData[opOffset + 16];
        
        const krs_detune = voiceData[opOffset + 12];
        const detune = ((krs_detune >> 3) & 15) - 7; // -7 to +7

        const l3 = voiceData[opOffset + 6]; // sustain level (0-99)
        const sustain = l3 / 99.0;

        const rate4 = voiceData[opOffset + 3]; // release rate (0-99)
        const release = Math.max(0.05, 4.0 * (1.0 - rate4 / 99.0));
        
        ops.push({ coarse, fine, level, detune, decay, mode, sustain, release });
      }
      
      patches.push({ name, algo, feedback, ops });
    }
    return patches;
  }

  _buildParams() {
    const name = this._type;
    const pr = this._instr;
    this.paramEl.innerHTML = '';
    if (!name || !pr) return;
    
    const defs = name === 'dx7' ? DX7_PARAM_DEFS : PARAM_DEFS[name];
    // Knobs that map to a p0/p1 param (not per-operator) — the UI loop drives
    // these from live automation while playing. Reset on every rebuild.
    this.paramKnobs = [];

    for (const d of defs) {
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
      this.paramEl.appendChild(block);

      const isPercent = d.min === 0 && d.max === 1 && d.step < 1;
      const formatFn = (d.label === 'Wave' && name === '303') ? (v) => {
        const map = { 0: 'Saw', 1: 'Square', 2: 'Triangle', 3: 'Sine', 4: 'Noise' };
        return map[Math.round(v)] || v.toString();
      } : (name === 'moog' && /Wave$/.test(d.label)) ? (v) => MOOG_WAVES[Math.round(v)] || v.toString()
        : (name === 'moog' && /Oct$/.test(d.label)) ? (v) => MOOG_OCTS[Math.round(v)] || v.toString()
        : (d.label === 'Op Mode' && name === 'dx7') ? (v) => {
        return Math.round(v) === 0 ? 'Ratio' : 'Fixed';
      } : (d.label === 'Op Coarse' && name === 'dx7' && pr.ops[this.activeOp].mode === 1) ? (v) => {
        const valMap = { 0: '1 Hz', 1: '10 Hz', 2: '100 Hz', 3: '1000 Hz' };
        return valMap[Math.round(v)] || (Math.round(v).toString() + ' Hz');
      } : null;

      const initialVal = d.type === 'op' ? pr.ops[this.activeOp][d.key] : pr[d.bank][d.i];

      let minVal = d.min;
      let maxVal = d.max;
      let stepVal = d.step;
      if (d.key === 'coarse' && name === 'dx7') {
        const isFixed = pr.ops[this.activeOp].mode === 1;
        minVal = isFixed ? 0 : 0.5;
        maxVal = isFixed ? 3 : 31;
        stepVal = isFixed ? 1 : 0.5;
      }

      bindKnob(knob, valSpan, minVal, maxVal, stepVal, initialVal, isPercent, (v) => {
        if (d.type === 'op') {
          pr.ops[this.activeOp][d.key] = v;
          if (d.key === 'mode') {
            // Rebuild params to dynamically update ranges (such as Op Coarse)
            this._buildParams();
          }
        } else {
          pr[d.bank][d.i] = v;
        }
      }, formatFn,
      // Preset matching scans every cached ROM bank, so run it once on drag-end
      // rather than on every pointer-move.
      () => this._refreshPresetSelection());

      // Per-operator dx7 knobs have no automation target; p0/p1 knobs do.
      if (d.type !== 'op') this.paramKnobs.push({ el: knob, bank: d.bank, i: d.i });
    }
  }

  // Sync the preset dropdown to whatever preset (if any) the current params match.
  _refreshPresetSelection() {
    const pSel = document.getElementById('instrument-preset');
    if (!pSel) return;
    const match = this._findMatchingPreset();
    if (this._type === 'dx7') {
      pSel.value = (match.rom === this.activeRomFile) ? match.index : -1;
    } else {
      pSel.value = match.index;
    }
  }
}

export function bindKnob(knobEl, valEl, min, max, step, initialVal, isPercent, onChange, formatFn, onCommit) {
  let val = initialVal;

  const updateUI = (v) => {
    const ratio = (v - min) / (max - min);
    const deg = -135 + ratio * 270;
    knobEl.style.transform = `rotate(${deg}deg)`;
    if (formatFn) {
      valEl.textContent = formatFn(v);
    } else if (isPercent) {
      valEl.textContent = Math.round(v * 100) + '%';
    } else {
      valEl.textContent = v.toFixed(step < 1 ? 2 : 0);
    }
  };

  updateUI(val);

  // Lets the UI loop drive the knob from outside (e.g. live automation tracking).
  // No-ops when the value is unchanged so per-frame calls are cheap.
  knobEl._extSet = (v) => {
    if (v === val || v == null || Number.isNaN(v)) return;
    val = v;
    updateUI(v);
  };

  const onStart = (e) => {
    e.preventDefault();
    const startY = e.clientY || (e.touches && e.touches[0].clientY);
    const startVal = val;
    const range = max - min;
    const pixelsPerRange = 150;

    const onMove = (moveEv) => {
      const currentY = moveEv.clientY || (moveEv.touches && moveEv.touches[0].clientY);
      const deltaY = startY - currentY;
      let newVal = startVal + (deltaY / pixelsPerRange) * range;
      newVal = Math.max(min, Math.min(max, newVal));
      if (step) {
        newVal = Math.round(newVal / step) * step;
      }
      val = newVal;
      updateUI(newVal);
      onChange(newVal);
    };

    const onEnd = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      if (onCommit) onCommit(val);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  };

  knobEl.addEventListener('mousedown', onStart);
  knobEl.addEventListener('touchstart', onStart, { passive: false });
}
