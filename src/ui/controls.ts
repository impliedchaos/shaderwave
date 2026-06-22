// Sidebar: instrument selector + parameter sliders. The selector lists the
// engine's instrument table (instances); editing a slider writes straight into
// the selected instance, which the engine snapshots onto each new note.
import { INSTRUMENTS, instGlow, INSTRUMENT_COLORS } from '../constants.js';
import { PRESETS } from './presets.js';
import { byType } from '../instruments/index.js';
import { resolveAssetUrl, decodeAudioFile } from '../audio/sample-loader.js';
import { displayAccent } from './theme.js';
import { recordKnob, disarmRecord, instParamTarget } from './record.js';
import { normalizeInstMod, cloneInstMod, instModHasContent, INST_SOURCE_LABELS, INST_MOD_MAX_ROUTES } from '../tracker/instmod.js';
import { serializeSample } from '../tracker/song-io.js';
import { instModTargetsForType } from '../tracker/automation.js';
import { LFO_SHAPES, LFO_SHAPE_WAVETABLE } from '../tracker/lfo.js';
import type { ModRoute } from '../types.js';
import { WT_BANKS, WT_TABLES, WT_FRAMES, WT_SAMPLES, sampleTable } from '../instruments/wavetables.js';
import type { Preset } from './presets.js';
import type { DX7Op, FxParams, InstrumentInstance, InstrumentType } from '../types.js';
import type { Engine } from '../tracker/engine.js';
import type { App } from '../main.js';

// A knob <div> the UI loop can drive externally (live automation tracking).
type KnobEl = HTMLElement & { _extSet?: (v: number) => void };

// An A/B explorer snapshot: the synth param banks + the engine type they came from
// (so recall/morph can be disabled when the selected instrument is a different engine).
interface BankSnap {
  type: InstrumentType;
  p0: number[]; p1: number[];
  p2?: number[]; p3?: number[]; p4?: number[];
}

// One DX7 voice parsed from a SysEx ROM.
interface SysexPatch {
  name: string;
  algo: number;
  feedback: number;
  ops: DX7Op[];
}

// (ParamDef now lives in types.ts so instrument descriptors can declare knobs.)

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

// Per-engine slider metadata now lives in each instrument descriptor's
// `paramDefs` (src/instruments/), fetched via byType(name).paramDefs.

// Display labels for the Moog stepped osc knobs.
const MOOG_WAVES: Record<number, string> = { 0: 'Tri', 1: 'Saw', 2: 'Square', 3: 'WidePul', 4: 'NarPul' };
const MOOG_OCTS: Record<number, string> = { 0: "32'", 1: "16'", 2: "8'", 3: "4'", 4: "2'" };
const E8E_WAVES: Record<number, string> = { 0: 'Sine', 1: 'Saw', 2: 'Square', 3: 'Triangle', 4: 'Noise' };

interface ControlsOpts {
  instEl: HTMLElement;
  paramEl: HTMLElement;
  onSelect?: (i: number) => void;
  onPresetChange?: (type: string, fx: Partial<FxParams>) => void;
  app?: App;
}

export class Controls {
  engine: Engine;
  instEl: HTMLElement;
  paramEl: HTMLElement;
  onSelect?: (i: number) => void;
  onPresetChange?: (type: string, fx: Partial<FxParams>) => void;
  app?: App;
  selected: number;
  activeOp: number;
  dx7Patches: SysexPatch[] | null;
  activeRomFile: string;
  romCache: Record<string, SysexPatch[]>;
  paramKnobs: { el: KnobEl; bank?: string; i?: number }[] = [];
  _abSlots: { A: BankSnap | null; B: BankSnap | null } = { A: null, B: null };   // preset explorer scratch
  _wtScopeRaf = 0;   // rAF handle for the live Wavewright oscilloscopes

  constructor(engine: Engine, { instEl, paramEl, onSelect, onPresetChange, app }: ControlsOpts) {
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
    const opSelect = document.getElementById('operator-select') as HTMLSelectElement | null;
    if (opSelect) {
      this.activeOp = parseInt(opSelect.value) || 0;
      opSelect.onchange = (e) => {
        this.activeOp = parseInt((e.target as HTMLSelectElement).value);
        this._buildParams();
      };
    }

    // Initialize ROM select dropdown if it exists
    const romSelect = document.getElementById('sysex-rom') as HTMLSelectElement | null;
    if (romSelect) {
      romSelect.innerHTML = '';
      DX7_ROMS.forEach((rom) => {
        const opt = document.createElement('option');
        opt.value = rom.file;
        opt.textContent = rom.name;
        romSelect.appendChild(opt);
      });
      romSelect.onchange = (e) => {
        this.loadRom((e.target as HTMLSelectElement).value, true);
      };
    }

    // Initialize Preset select dropdown if it exists
    const presetSelect = document.getElementById('instrument-preset') as HTMLSelectElement | null;
    if (presetSelect) {
      presetSelect.onchange = (e) => {
        const v = (e.target as HTMLSelectElement).value;
        // User presets are prefixed `u:<id>`; built-ins keep their bare numeric index.
        if (v.startsWith('u:')) this._loadUserPreset(v.slice(2));
        else this.loadPreset(parseInt(v));
        this._updatePresetActions();
      };
    }
    this._bindPresetActions();
    this._bindMorphControls();

    // Preload all ROM banks
    this.loadAllRoms();

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
  get _instr(): InstrumentInstance { return this.engine.instruments[this.selected]; }
  get _type(): InstrumentType | null { return this._instr ? this._instr.type : null; }

  _buildInstruments() {
    this.instEl.innerHTML = '';
    this.engine.instruments.forEach((instr: InstrumentInstance, i: number) => {
      const b = document.createElement('button');
      const num = document.createElement('span');
      num.className = 'inst-num';
      num.textContent = String(i).padStart(2, '0') + ':';
      const label = document.createElement('span');
      label.className = 'inst-name';
      label.textContent = instr.name || instr.type.toUpperCase();

      const icons = document.createElement('div');
      icons.className = 'inst-icons';
      icons.style.display = 'flex';
      icons.style.marginLeft = 'auto';
      icons.style.gap = '8px';
      icons.style.alignItems = 'center';

      // Sliders icon → jump to the Instrument editor tab focused on this instance.
      const openEditor = document.createElement('span');
      openEditor.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>';
      openEditor.title = 'Edit instrument (params & FX)';
      openEditor.style.cursor = 'pointer';
      openEditor.style.display = 'flex';
      openEditor.style.opacity = '0.5';
      openEditor.onmouseover = () => openEditor.style.opacity = '1';
      openEditor.onmouseout = () => openEditor.style.opacity = '0.5';
      openEditor.onclick = (e) => {
        e.stopPropagation();
        this.select(i);
        this.app?.activateTab?.('instrument');
      };

      const pencil = document.createElement('span');
      pencil.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" fill="currentColor"/></svg>';
      pencil.title = 'Edit instrument name';
      pencil.style.cursor = 'pointer';
      pencil.style.display = 'flex';
      pencil.style.opacity = '0.5';
      pencil.onmouseover = () => pencil.style.opacity = '1';
      pencil.onmouseout = () => pencil.style.opacity = '0.5';
      pencil.onclick = (e) => {
        e.stopPropagation();
        const newName = prompt('Enter new instrument name:', instr.name || instr.type.toUpperCase());
        if (newName !== null) {
          instr.name = newName.trim();
          this._buildInstruments();
          this.app?.markDirty('instrument');
        }
      };

      const colorWrapper = document.createElement('div');
      colorWrapper.style.position = 'relative';
      colorWrapper.style.display = 'flex';
      colorWrapper.style.alignItems = 'center';
      
      const colorPicker = document.createElement('span');
      colorPicker.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>';
      colorPicker.title = 'Change color';
      colorPicker.style.color = instr.color;
      colorPicker.style.cursor = 'pointer';
      colorPicker.style.display = 'flex';
      
      const colorSelect = document.createElement('select');
      colorSelect.style.opacity = '0';
      colorSelect.style.position = 'absolute';
      colorSelect.style.left = '0';
      colorSelect.style.top = '0';
      colorSelect.style.width = '100%';
      colorSelect.style.height = '100%';
      colorSelect.style.cursor = 'pointer';
      
      INSTRUMENT_COLORS.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        opt.style.background = c;
        opt.style.color = '#000';
        colorSelect.appendChild(opt);
      });
      colorSelect.value = instr.color;
      colorSelect.onclick = (e) => e.stopPropagation();
      colorSelect.onchange = () => {
        instr.color = colorSelect.value;
        this._buildInstruments();
        this.app?.markDirty('instrument');
      };
      
      colorWrapper.appendChild(colorPicker);
      colorWrapper.appendChild(colorSelect);

      icons.appendChild(openEditor);
      icons.appendChild(pencil);
      icons.appendChild(colorWrapper);
      b.append(num, label, icons);
      const sel = i === this.selected;
      b.className = sel ? 'sel' : '';
      // Each instance carries its own colour so duplicate engines are
      // distinguishable here and in the tracker grid.
      const col = displayAccent(instr.color);   // darkened for light mode if it's a too-bright neon
      b.style.color = col;
      if (sel) {
        b.style.borderColor = col;
        b.style.boxShadow = `0 0 12px ${instGlow(col)}, inset 0 0 8px ${instGlow(col)}`;
        b.style.textShadow = `0 0 8px ${instGlow(col)}`;
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
          this.app?._syncRendererFx();  // table shrank → re-map fx by instance index
          this.app?.markDirty('instrument');
        }
      };
      this.instEl.appendChild(b);
    });

    const addBtn = document.createElement('button');
    addBtn.style.position = 'relative';
    addBtn.style.opacity = '0.7';

    const plusSpan = document.createElement('span');
    plusSpan.className = 'inst-num';
    plusSpan.textContent = '+';

    const addLabel = document.createElement('span');
    addLabel.className = 'inst-name';
    addLabel.textContent = 'Add Instrument...';

    const addSelect = document.createElement('select');
    addSelect.style.opacity = '0';
    addSelect.style.position = 'absolute';
    addSelect.style.left = '0';
    addSelect.style.top = '0';
    addSelect.style.width = '100%';
    addSelect.style.height = '100%';
    addSelect.style.cursor = 'pointer';

    addSelect.innerHTML = '<option value="">+ Add Instrument</option>'
      + INSTRUMENTS.map((t) => `<option value="${t}">${byType(t)?.name ?? t.toUpperCase()}</option>`).join('');
    addSelect.value = '';
    
    addSelect.onchange = (e) => {
      const target = e.target as HTMLSelectElement;
      const type = target.value as InstrumentType;
      target.value = '';
      if (!type) return;

      const idx = this.engine.addInstrument(type);
      const fx = this.engine.instruments[idx]?.fx;
      if (fx) {
        fx.enabled = fx.distOn = fx.chorusOn = fx.tremoloOn = fx.delayOn = fx.reverbOn = fx.widthOn = fx.bitcrushOn = false;
      }
      this.app?._syncRendererFx();
      this.select(idx);
      this.app?.markDirty('instrument');
    };

    addBtn.append(plusSpan, addLabel, addSelect);
    this.instEl.appendChild(addBtn);
  }

  select(i: number) {
    this.selected = i;
    // Rebuild the list so per-instance colours/glow recompute for the new
    // selection (a plain class toggle would leave the old button's inline glow).
    this._buildInstruments();

    // Toggle UI visibility for ROM and Operator selectors
    const isDX7 = this._type === 'dx7';
    const sysexRow = document.getElementById('sysex-select-row') as HTMLElement | null;
    const opRow = document.getElementById('op-select-row') as HTMLElement | null;
    if (sysexRow) sysexRow.style.display = isDX7 ? 'flex' : 'none';
    if (opRow) opRow.style.display = isDX7 ? 'flex' : 'none';

    // Populate presets dropdown for selected instrument
    this._populatePresets();

    // Build params from current engine state (don't auto-load a preset,
    // which would overwrite any song-specific parameter values)
    this._buildParams();
    this._updateMorphControls();
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
            const op = pr.ops![k];
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

  // allowRedirect: on a passive refresh (instrument select / initial load) we may
  // auto-switch the DX7 bank to whichever ROM matches the current patch, to highlight
  // it. But when loadRom() is the caller it has ALREADY set the bank deliberately, so
  // it passes false — otherwise the "matching" old bank would yank the selection back
  // (you'd be unable to switch banks). See loadRom().
  _populatePresets(allowRedirect = true) {
    const presetSelect = document.getElementById('instrument-preset') as HTMLSelectElement | null;
    if (!presetSelect) return;

    presetSelect.innerHTML = '';
    const instName = this._type;
    if (!instName) return;

    // Add a blank option at the top
    const blankOpt = document.createElement('option');
    blankOpt.value = '-1';
    blankOpt.textContent = '';
    presetSelect.appendChild(blankOpt);

    if (instName === 'dx7' && this.dx7Patches) {
      this.dx7Patches.forEach((p, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = `${idx + 1}: ${p.name}`;
        presetSelect.appendChild(opt);
      });
    } else if (PRESETS[instName]) {
      PRESETS[instName].forEach((p: Preset, idx: number) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = p.name;
        presetSelect.appendChild(opt);
      });
    }

    // User presets for this engine type, grouped under "My Presets" (value `u:<id>`).
    const mine = this.app?.presetStore?.list(instName) ?? [];
    if (mine.length) {
      const og = document.createElement('optgroup');
      og.label = 'My Presets';
      mine.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = 'u:' + m.id;
        opt.textContent = m.name;
        og.appendChild(opt);
      });
      presetSelect.appendChild(og);
    }

    const match = this._findMatchingPreset();
    if (allowRedirect && instName === 'dx7' && match.rom && match.rom !== this.activeRomFile) {
      this.loadRom(match.rom, false);
      return;
    }
    presetSelect.value = String(match.index);
    this._updatePresetActions();
  }

  loadPreset(presetIdx: number) {
    if (presetIdx === -1) return;
    const instName = this._type;
    if (!instName) return;
    if (instName === 'dx7') {
      if (this.dx7Patches && this.dx7Patches[presetIdx]) {
        const patch = this.dx7Patches[presetIdx];
        const pr = this._instr;
        const ops = pr.ops!;   // dx7 instances always carry operator config
        pr.p1[0] = patch.algo;
        pr.p0[3] = patch.feedback;
        for (let k = 0; k < 6; k++) {
          ops[k].coarse = patch.ops[k].coarse;
          ops[k].fine = patch.ops[k].fine;
          ops[k].level = patch.ops[k].level;
          ops[k].detune = patch.ops[k].detune;
          ops[k].decay = patch.ops[k].decay;
          ops[k].mode = patch.ops[k].mode !== undefined ? patch.ops[k].mode : 0;
          ops[k].sustain = patch.ops[k].sustain !== undefined ? patch.ops[k].sustain : 0.7;
          ops[k].release = patch.ops[k].release !== undefined ? patch.ops[k].release : 0.25;
        }
      }
      this._buildParams();
      this.app?.markDirty('preset');
    } else {
      const plist = PRESETS[instName];
      if (plist && plist[presetIdx]) this._applyPreset(plist[presetIdx]);
    }
    const presetSelect = document.getElementById('instrument-preset') as HTMLSelectElement | null;
    if (presetSelect) {
      presetSelect.value = String(presetIdx);
    }
  }

  // Apply a Preset (built-in OR user/imported) to the selected instance: param banks,
  // DX7 operators, mod matrix, sample, fx, and chain order. Shared by loadPreset (for
  // built-ins) and _loadUserPreset. Not used for the DX7 built-in ROM-patch path —
  // that reads from the parsed SysEx and stays inline in loadPreset.
  _applyPreset(preset: Preset) {
    const instName = this._type;
    if (!instName) return;
    const prDst = this._instr;
    prDst.p0 = [...preset.p0];
    prDst.p1 = [...preset.p1];
    // Engines with extra banks (moog/e8e/groove) carry p2/p3; apply the preset's
    // values, falling back to the engine's descriptor defaults when omitted (for
    // moog that's the classic Model D: 3 saws at 8').
    const def = byType(instName);
    if (def?.defaults.p2) prDst.p2 = preset.p2 ? [...preset.p2] : [...def.defaults.p2];
    if (def?.defaults.p3) prDst.p3 = preset.p3 ? [...preset.p3] : [...def.defaults.p3];
    if (def?.defaults.p4) prDst.p4 = preset.p4 ? [...preset.p4] : [...def.defaults.p4];
    // DX7 operator config (user presets for the dx7 engine capture it; built-ins don't).
    if (preset.ops && prDst.ops) {
      for (let k = 0; k < prDst.ops.length && k < preset.ops.length; k++) {
        prDst.ops[k] = { ...preset.ops[k] };
      }
    }
    // Adopt the preset's modulation matrix if it carries one; otherwise leave the
    // instance's existing matrix untouched (built-in presets predate mod, so loading
    // one shouldn't silently wipe a user's LFO/env routings).
    if (preset.mod) prDst.mod = normalizeInstMod(preset.mod);
    if (preset.fxOrder) prDst.fxOrder = [...preset.fxOrder];
    if (preset.sample) {
      if (preset.sample.url) {
        // Load over HTTP
        fetch(resolveAssetUrl(preset.sample.url)).then(res => res.arrayBuffer()).then(buf => {
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
          return ctx.decodeAudioData(buf);
        }).then(audio => {
          let pcm = audio.getChannelData(0);
          if (audio.sampleRate !== 48000) {
            console.warn(`Resampling preset from ${audio.sampleRate} Hz to 48000 Hz`);
            const ratio = audio.sampleRate / 48000;
            const newLen = Math.floor(pcm.length / ratio);
            const newPcm = new Float32Array(newLen);
            for (let i = 0; i < newLen; i++) {
              const pos = i * ratio;
              const idx = Math.floor(pos);
              const frac = pos - idx;
              if (idx + 1 < pcm.length) {
                newPcm[i] = pcm[idx] * (1 - frac) + pcm[idx + 1] * frac;
              } else {
                newPcm[i] = pcm[idx];
              }
            }
            pcm = newPcm;
          }
          const maxLen = 4096 * (4096 / 16);
          if (pcm.length > maxLen) pcm = pcm.slice(0, maxLen);

          prDst.sample = {
            name: preset.sample.name,
            rootNote: preset.sample.rootNote,
            loopStart: preset.sample.loopStart,
            loopEnd: preset.sample.loopEnd || pcm.length,
            loopMode: preset.sample.loopMode,
            pcm
          };
          this.app?._syncRendererFx();
          this.app?.markDirty('instrument');
          this._buildParams();
        }).catch(err => console.error("Failed to load preset sample from URL", err));
      } else if (preset.sample.pcm) {
        const binary = atob(preset.sample.pcm);
        const u8 = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) {
          u8[j] = binary.charCodeAt(j);
        }
        const i16 = new Int16Array(u8.buffer);
        const pcm = new Float32Array(i16.length);
        for (let j = 0; j < i16.length; j++) {
          pcm[j] = i16[j] / 32768.0;
        }
        prDst.sample = {
          name: preset.sample.name,
          rootNote: preset.sample.rootNote,
          loopStart: preset.sample.loopStart,
          loopEnd: preset.sample.loopEnd,
          loopMode: preset.sample.loopMode,
          pcm
        };
        this.app?._syncRendererFx();
      }
    }
    if (this.onPresetChange && preset.fx) {
      this.onPresetChange(instName, preset.fx);
    }
    this._buildParams();
    this.app?.markDirty('preset');
  }

  // Snapshot the selected instance into a portable Preset (the unit saved to the
  // PresetStore and exported as .json). Inverse of _applyPreset.
  _capturePreset(name: string): Preset {
    const pr = this._instr;
    return {
      name,
      type: pr.type,
      p0: [...pr.p0],
      p1: [...pr.p1],
      ...(pr.p2 ? { p2: [...pr.p2] } : {}),
      ...(pr.p3 ? { p3: [...pr.p3] } : {}),
      ...(pr.p4 ? { p4: [...pr.p4] } : {}),
      ...(pr.ops ? { ops: pr.ops.map((o) => ({ ...o })) } : {}),
      fx: { ...pr.fx },
      ...(pr.fxOrder ? { fxOrder: [...pr.fxOrder] } : {}),
      ...(instModHasContent(pr.mod) ? { mod: cloneInstMod(pr.mod!) } : {}),
      ...(pr.sample ? { sample: serializeSample(pr.sample) } : {}),
    };
  }

  // Load + apply a user preset (PresetStore body) onto the selected instance.
  async _loadUserPreset(id: string) {
    const store = this.app?.presetStore;
    if (!store) return;
    const preset = await store.load(id);
    if (!preset) return;
    this._applyPreset(preset);
    const pSel = document.getElementById('instrument-preset') as HTMLSelectElement | null;
    if (pSel) pSel.value = 'u:' + id;
    this._updatePresetActions();
  }

  // The id of the currently-selected user preset, or null when a built-in / blank
  // option is showing (Rename/Delete only apply to user presets).
  _selectedUserPresetId(): string | null {
    const pSel = document.getElementById('instrument-preset') as HTMLSelectElement | null;
    const v = pSel?.value ?? '';
    return v.startsWith('u:') ? v.slice(2) : null;
  }

  // Enable Rename/Delete only when a user preset is selected.
  _updatePresetActions() {
    const isUser = !!this._selectedUserPresetId();
    const rn = document.getElementById('preset-rename') as HTMLButtonElement | null;
    const del = document.getElementById('preset-delete') as HTMLButtonElement | null;
    if (rn) rn.disabled = !isUser;
    if (del) del.disabled = !isUser;
  }

  // Wire the Save / Rename / Delete / Export / Import buttons (called once at init).
  _bindPresetActions() {
    const store = this.app?.presetStore;
    const $ = (id: string) => document.getElementById(id);
    const pSel = () => document.getElementById('instrument-preset') as HTMLSelectElement | null;

    $('preset-save')?.addEventListener('click', async () => {
      if (!store) { alert('Preset storage is unavailable.'); return; }
      const name = prompt('Save preset as:', this._instr?.name || (this._type ?? 'Preset'));
      if (name === null) return;
      const res = await store.save(this._capturePreset(name.trim() || 'Untitled'));
      if (!res.ok) { alert(res.error || 'Could not save the preset.'); return; }
      this._populatePresets();
      const sel = pSel(); if (sel && res.id) sel.value = 'u:' + res.id;
      this._updatePresetActions();
    });

    $('preset-rename')?.addEventListener('click', async () => {
      const id = this._selectedUserPresetId();
      if (!store || !id) return;
      const cur = store.metaFor(id);
      const name = prompt('Rename preset:', cur?.name || '');
      if (name === null || !name.trim()) return;
      const res = await store.rename(id, name.trim());
      if (!res.ok) { alert(res.error || 'Could not rename the preset.'); return; }
      this._populatePresets();
      const sel = pSel(); if (sel) sel.value = 'u:' + id;
      this._updatePresetActions();
    });

    $('preset-delete')?.addEventListener('click', async () => {
      const id = this._selectedUserPresetId();
      if (!store || !id) return;
      const cur = store.metaFor(id);
      if (!confirm(`Delete preset "${cur?.name || ''}"? This can't be undone.`)) return;
      await store.delete(id);
      this._populatePresets();
      const sel = pSel(); if (sel) sel.value = '-1';
      this._updatePresetActions();
    });

    $('preset-export')?.addEventListener('click', async () => {
      // Export the selected user preset's stored bytes if one is active; otherwise
      // capture the current instrument exactly as it sounds.
      const id = this._selectedUserPresetId();
      const preset = (id && store && (await store.load(id))) || this._capturePreset(this._instr?.name || (this._type ?? 'Preset'));
      const fname = (preset.name || 'preset').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      this._downloadJSON(`${fname}.swpreset.json`, JSON.stringify(preset));
    });

    const fileInput = $('preset-import-file') as HTMLInputElement | null;
    $('preset-import')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';   // allow re-importing the same file
      if (!file || !store) return;
      try {
        const preset = JSON.parse(await file.text()) as Preset;
        if (!preset || !preset.type || !Array.isArray(preset.p0) || !Array.isArray(preset.p1)) {
          alert('That doesn’t look like a ShaderWave preset file.'); return;
        }
        const res = await store.save(preset);
        if (!res.ok) { alert(res.error || 'Could not import the preset.'); return; }
        // Surface it immediately if it belongs to the current engine; else just confirm.
        if (preset.type === this._type) {
          this._populatePresets();
          const sel = pSel(); if (sel && res.id) sel.value = 'u:' + res.id;
          this._updatePresetActions();
        } else {
          alert(`Imported "${preset.name}" — select a ${preset.type} instrument to use it.`);
        }
      } catch {
        alert('Could not read that file as JSON.');
      }
    });
  }

  _downloadJSON(filename: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Preset explorer: A/B compare + morph + randomize/nudge ───────────────────
  // All three operate ONLY on the universal synth param banks (p0–p4) described by
  // paramDefs — fx chain and mod matrix are left alone. DX7 operator params are
  // `type:'op'` and thus excluded, so on DX7 these touch only algo/feedback.

  // The bank-backed knob params (i.e. excluding DX7 per-operator entries).
  _synthDefs() {
    return (byType(this._type ?? '')?.paramDefs ?? []).filter((d) => d.bank && d.type !== 'op');
  }

  _knobFor(bank: string, i: number): KnobEl | undefined {
    return this.paramKnobs.find((k) => k.bank === bank && k.i === i)?.el;
  }

  // Write one synth param (quantized to its step + clamped), pushing it to live
  // voices AND the on-screen knob without a DOM rebuild — cheap enough per-frame.
  _setSynthParam(d: { bank?: string; i?: number; min: number; max: number; step: number }, v: number) {
    const q = Math.max(d.min, Math.min(d.max, d.step ? Math.round(v / d.step) * d.step : v));
    (this._instr as any)[d.bank!][d.i!] = q;
    this.engine.updateInstrumentParam(this.selected, d.bank! as any, d.i!, q);
    this._knobFor(d.bank!, d.i!)?._extSet?.(q);
  }

  // Snapshot the current instance's banks + engine type into an A/B slot.
  _captureBanks(): BankSnap {
    const pr = this._instr;
    return {
      type: pr.type,
      p0: [...pr.p0], p1: [...pr.p1],
      ...(pr.p2 ? { p2: [...pr.p2] } : {}),
      ...(pr.p3 ? { p3: [...pr.p3] } : {}),
      ...(pr.p4 ? { p4: [...pr.p4] } : {}),
    };
  }

  _randomize(mode: 'full' | 'nudge') {
    for (const d of this._synthDefs()) {
      const cur = (this._instr as any)[d.bank!][d.i!] as number;
      const v = mode === 'full'
        ? d.min + Math.random() * (d.max - d.min)
        : cur + (Math.random() * 2 - 1) * 0.15 * (d.max - d.min);
      this._setSynthParam(d, v);
    }
    this._refreshPresetSelection();
    this.app?.markDirty(mode === 'full' ? 'randomize' : 'nudge');
  }

  // Blend slot A → slot B into the live instance (t in [0,1]); slots untouched.
  _morph(t: number, commit = false) {
    const a = this._abSlots.A, b = this._abSlots.B;
    if (!a || !b) return;
    for (const d of this._synthDefs()) {
      const av = (a as any)[d.bank!]?.[d.i!] ?? 0;
      const bv = (b as any)[d.bank!]?.[d.i!] ?? 0;
      this._setSynthParam(d, av + (bv - av) * t);
    }
    if (commit) { this._refreshPresetSelection(); this.app?.markDirty('morph'); }
  }

  // Restore a full bank snapshot (incl. non-knob slots), then sync knobs + voices.
  _recall(slot: 'A' | 'B') {
    const s = this._abSlots[slot];
    if (!s || s.type !== this._type) return;
    const pr = this._instr;
    for (const bank of ['p0', 'p1', 'p2', 'p3', 'p4'] as const) {
      if ((s as any)[bank]) (pr as any)[bank] = [...(s as any)[bank]];
    }
    for (const d of this._synthDefs()) {
      this.engine.updateInstrumentParam(this.selected, d.bank! as any, d.i!, (pr as any)[d.bank!][d.i!]);
      this._knobFor(d.bank!, d.i!)?._extSet?.((pr as any)[d.bank!][d.i!]);
    }
    this._refreshPresetSelection();
    this.app?.markDirty('preset');
  }

  // Enable Recall only for a slot matching the current engine; the morph slider
  // needs both slots present and matching.
  _updateMorphControls() {
    const type = this._type;
    const okA = !!this._abSlots.A && this._abSlots.A.type === type;
    const okB = !!this._abSlots.B && this._abSlots.B.type === type;
    const set = (id: string, on: boolean) => {
      const el = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
      if (el) (el as any).disabled = !on;
    };
    set('ab-recall-a', okA);
    set('ab-recall-b', okB);
    set('morph-slider', okA && okB);
  }

  _bindMorphControls() {
    const on = (id: string, ev: string, fn: (e: Event) => void) =>
      document.getElementById(id)?.addEventListener(ev, fn);
    on('ab-copy-a', 'click', () => { this._abSlots.A = this._captureBanks(); this._updateMorphControls(); });
    on('ab-copy-b', 'click', () => { this._abSlots.B = this._captureBanks(); this._updateMorphControls(); });
    on('ab-recall-a', 'click', () => this._recall('A'));
    on('ab-recall-b', 'click', () => this._recall('B'));
    on('rand-full', 'click', () => this._randomize('full'));
    on('rand-nudge', 'click', () => this._randomize('nudge'));
    on('morph-slider', 'input', (e) => this._morph(+(e.target as HTMLInputElement).value));
    on('morph-slider', 'change', (e) => this._morph(+(e.target as HTMLInputElement).value, true));
  }

  async loadRom(filename: string, autoLoadFirstPreset = false) {
    if (this.romCache[filename]) {
      this.activeRomFile = filename;
      this.dx7Patches = this.romCache[filename];
      const romSelect = document.getElementById('sysex-rom') as HTMLSelectElement | null;
      if (romSelect) {
        romSelect.value = filename;
      }
      if (this._type === 'dx7') {
        this._populatePresets(false);   // bank set explicitly here — don't auto-redirect away
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
        const romSelect = document.getElementById('sysex-rom') as HTMLSelectElement | null;
        if (romSelect) {
          romSelect.value = filename;
        }
        if (this._type === 'dx7') {
          this._populatePresets(false);   // bank set explicitly here — don't auto-redirect away
          if (autoLoadFirstPreset) {
            this.loadPreset(0);
          }
        }
      } catch (err) {
        console.error("Failed to load DX7 SysEx ROM:", err);
      }
    }
  }

  parseSysex(data: Uint8Array): SysexPatch[] {
    if (data[0] !== 0xF0 || data[1] !== 0x43) {
      console.warn("Invalid SysEx header, attempting to parse anyway...");
    }

    const patches: SysexPatch[] = [];
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
      const ops: DX7Op[] = [];
      for (let k = 0; k < 6; k++) {
        // Operators are stored in reverse order: Op 6 is offset 0, Op 1 is offset 85
        const opOffset = (5 - k) * 17;
        
        // 4-stage envelope: rates (0-99) and levels (0-99)
        const rate1 = voiceData[opOffset + 0];
        const rate2 = voiceData[opOffset + 1];
        const rate3 = voiceData[opOffset + 2];
        const rate4 = voiceData[opOffset + 3];
        const level1 = voiceData[opOffset + 4];
        const level2 = voiceData[opOffset + 5];
        const level3 = voiceData[opOffset + 6];
        const level4 = voiceData[opOffset + 7];
        
        // Crude but better DX7 rate mapping: rate 99 ~ 2ms, rate 0 ~ 30s.
        // Math.pow(2.0, (99 - R) * 0.14) * 0.002 gives a decent spread.
        const rToS = (r: number) => r === 99 ? 0.002 : Math.max(0.002, Math.pow(2.0, (99 - r) * 0.14) * 0.002);
        const lToF = (l: number) => l / 99.0;
        
        const r1 = rToS(rate1);
        const r2 = rToS(rate2);
        const r3 = rToS(rate3);
        const r4 = rToS(rate4);
        
        const l1 = lToF(level1);
        const l2 = lToF(level2);
        const l3 = lToF(level3);
        const l4 = lToF(level4);
        
        // Legacy fields mapping for compatibility if needed (decay, sustain, release)
        const decay = r2;
        const sustain = l3;
        const release = r4;
        
        const level = voiceData[opOffset + 14];
        
        const mode_coarse = voiceData[opOffset + 15];
        const mode = mode_coarse & 1;
        let coarse = (mode_coarse >> 1) & 31;
        if (mode === 0) {
          coarse = coarse === 0 ? 0.5 : coarse;
        }
        
        const fine = voiceData[opOffset + 16];
        
        const krs_detune = voiceData[opOffset + 12];
        const detune = ((krs_detune >> 3) & 15) - 7; // -7 to +7
        
        ops.push({ 
          coarse, fine, level, detune, mode, 
          decay, sustain, release,
          r1, r2, r3, r4, l1, l2, l3, l4 
        });
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
    
    const defs = byType(name)?.paramDefs ?? [];
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
      const formatFn: ((v: number) => string) | null = (d.label === 'Wave' && name === '303') ? (v: number) => {
        const map: Record<number, string> = { 0: 'Saw', 1: 'Square', 2: 'Triangle', 3: 'Sine', 4: 'Noise' };
        return map[Math.round(v)] || v.toString();
      } : (name === 'moog' && /Wave$/.test(d.label)) ? (v: number) => MOOG_WAVES[Math.round(v)] || v.toString()
        : (name === 'moog' && /Oct$/.test(d.label)) ? (v: number) => MOOG_OCTS[Math.round(v)] || v.toString()
        : (name === 'e8e' && /^Wave\d$/.test(d.label)) ? (v: number) => E8E_WAVES[Math.round(v)] || v.toString()
        : (name === 'wvt' && /^Bank\d$/.test(d.label)) ? (v: number) => WT_BANKS[Math.round(v)]?.name ?? v.toString()
        : (d.label === 'Op Mode' && name === 'dx7') ? (v: number) => {
        return Math.round(v) === 0 ? 'Ratio' : 'Fixed';
      } : (d.label === 'Op Coarse' && name === 'dx7' && pr.ops![this.activeOp].mode === 1) ? (v: number) => {
        const valMap: Record<number, string> = { 0: '1 Hz', 1: '10 Hz', 2: '100 Hz', 3: '1000 Hz' };
        return valMap[Math.round(v)] || (Math.round(v).toString() + ' Hz');
      } : null;

      // bank/op-key come from the data-driven ParamDef table, so these accesses
      // are dynamic; op-scope defs always target a dx7 instance (ops present).
      const initialVal = d.type === 'op'
        ? (pr.ops![this.activeOp] as any)[d.key!]
        : (pr as any)[d.bank!][d.i!];

      let minVal = d.min;
      let maxVal = d.max;
      let stepVal = d.step;
      if (d.key === 'coarse' && name === 'dx7') {
        const isFixed = pr.ops![this.activeOp].mode === 1;
        minVal = isFixed ? 0 : 0.5;
        maxVal = isFixed ? 3 : 31;
        stepVal = isFixed ? 1 : 0.5;
      }

      bindKnob(knob, valSpan, minVal, maxVal, stepVal, initialVal, isPercent, (v) => {
        if (d.type === 'op') {
          (pr.ops![this.activeOp] as any)[d.key!] = v;
          if (d.key === 'mode') {
            // Rebuild params to dynamically update ranges (such as Op Coarse)
            this._buildParams();
          }
        } else {
          (pr as any)[d.bank!][d.i!] = v;
          // Push the edit into any sounding voices so held notes change immediately
          // (not only on the next note-on).
          this.engine.updateInstrumentParam(this.selected, d.bank!, d.i!, v);
          // While recording, also write it to the param's automation track at the
          // playhead (no-op for p2/p3 — those have no automation target).
          if (this.app) recordKnob(this.app, instParamTarget(name, d.bank!, d.i!), this.selected, v);
        }
      }, formatFn,
      // Preset matching scans every cached ROM bank, so run it once on drag-end
      // rather than on every pointer-move; the drag-end is also one undo step.
      () => { this._refreshPresetSelection(); this.app?.markDirty('knob'); if (this.app) disarmRecord(this.app); });

      // Per-operator dx7 knobs have no automation target; p0/p1 knobs do.
      if (d.type !== 'op') this.paramKnobs.push({ el: knob, bank: d.bank, i: d.i });
    }

    // Wavewright: live oscilloscopes showing each oscillator's morphed waveform.
    if (this._wtScopeRaf) { cancelAnimationFrame(this._wtScopeRaf); this._wtScopeRaf = 0; }
    if (name === 'wvt') this._buildWtScopes(pr);
    if (name === 'sampler') this._buildSamplerUI(pr);
    if (name === 'additive') this._buildAdditiveUI(pr);
    this._buildModMatrix(pr);
  }

  // Per-instrument modulation matrix: this instance's OWN sources (2 LFOs + 1 mod
  // envelope) and the routes wiring them to its params (inst banks, fx, or pitch).
  // Distinct from the song-wide global LFOs (Song Editor) — this travels with the
  // instrument into presets/saves. Mutates pr.mod in place; the engine reads it live
  // each block, so no re-push is needed. Native controls, modeled on the LFO panel.
  _buildModMatrix(pr: InstrumentInstance) {
    const name = this._type;
    if (!name) return;
    const mod = pr.mod ?? (pr.mod = normalizeInstMod(undefined));
    const q = <T extends HTMLElement>(root: ParentNode, k: string) => root.querySelector(`[data-k="${k}"]`) as T;
    const dirty = () => this.app?.markDirty('instrument');

    const BEATS: [number, string][] = [[16, '4 bars'], [8, '2 bars'], [4, '1 bar'], [2, '1/2'], [1, '1 beat'], [0.5, '1/2'], [0.25, '1/4'], [0.125, '1/8']];

    const wrap = document.createElement('div');
    wrap.className = 'mod-matrix-ui';
    wrap.style.gridColumn = '1 / -1';
    wrap.appendChild(Object.assign(document.createElement('div'), { className: 'mod-head', textContent: 'Modulation' }));

    // ── Source slots (2 LFOs + 1 env), fixed layout ──
    const beatOpts = BEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const shapeOpts = LFO_SHAPES.map((s, k) => `<option value="${k}">${s}</option>`).join('');
    const bankOpts = WT_BANKS.map((b, k) => `<option value="${k}">${b.name}</option>`).join('');
    mod.sources.forEach((src, si) => {
      const panel = document.createElement('div');
      panel.className = 'mod-source';
      if (src.kind === 'lfo') {
        panel.innerHTML = `
          <div class="mod-src-head">${INST_SOURCE_LABELS[si]}</div>
          <label class="mod-row">Shape <select data-k="shape">${shapeOpts}</select></label>
          <label class="mod-row"><input type="checkbox" data-k="sync"> Sync</label>
          <label class="mod-row" data-when="sync">Rate <select data-k="beats">${beatOpts}</select></label>
          <label class="mod-row" data-when="free">Hz <input type="range" data-k="hz" min="0.05" max="20" step="0.05"><span data-k="hzv" class="mod-val"></span></label>
          <label class="mod-row" data-when="wt">Bank <select data-k="wtbank">${bankOpts}</select></label>
          <label class="mod-row" data-when="wt">Pos <input type="range" data-k="wtpos" min="0" max="1" step="0.01"></label>
          <label class="mod-row" title="master depth on every route from this source (a modulation target)">Amt <input type="range" data-k="amt" min="0" max="2" step="0.01"><span data-k="amtv" class="mod-val"></span></label>
          <label class="mod-row"><input type="checkbox" data-k="retrig"> Retrigger</label>`;
        wrap.appendChild(panel);
        const shape = q<HTMLSelectElement>(panel, 'shape');
        const sync = q<HTMLInputElement>(panel, 'sync');
        const beats = q<HTMLSelectElement>(panel, 'beats');
        const hz = q<HTMLInputElement>(panel, 'hz'); const hzv = q<HTMLSpanElement>(panel, 'hzv');
        const wtbank = q<HTMLSelectElement>(panel, 'wtbank');
        const wtpos = q<HTMLInputElement>(panel, 'wtpos');
        const amt = q<HTMLInputElement>(panel, 'amt'); const amtv = q<HTMLSpanElement>(panel, 'amtv');
        const retrig = q<HTMLInputElement>(panel, 'retrig');
        const refresh = () => {
          shape.value = String(src.lfo.shape); sync.checked = src.lfo.sync;
          beats.value = String(src.lfo.rateBeats);
          hz.value = String(src.lfo.rateHz); hzv.textContent = src.lfo.rateHz.toFixed(2) + 'Hz';
          wtbank.value = String(src.lfo.wtBank); wtpos.value = String(src.lfo.wtPos);
          amt.value = String(src.amount ?? 1); amtv.textContent = (src.amount ?? 1).toFixed(2) + '×';
          retrig.checked = src.retrigger;
          const isWt = src.lfo.shape === LFO_SHAPE_WAVETABLE;
          panel.querySelectorAll<HTMLElement>('[data-when]').forEach((el) => {
            const w = el.dataset.when;
            el.style.display = (w === 'sync' ? src.lfo.sync : w === 'free' ? !src.lfo.sync : w === 'wt' ? isWt : true) ? '' : 'none';
          });
        };
        shape.onchange = () => { src.lfo.shape = +shape.value; refresh(); dirty(); };
        sync.onchange = () => { src.lfo.sync = sync.checked; refresh(); dirty(); };
        beats.onchange = () => { src.lfo.rateBeats = +beats.value; dirty(); };
        hz.oninput = () => { src.lfo.rateHz = +hz.value; hzv.textContent = src.lfo.rateHz.toFixed(2) + 'Hz'; };
        hz.onchange = dirty;
        wtbank.onchange = () => { src.lfo.wtBank = +wtbank.value; dirty(); };
        wtpos.oninput = () => { src.lfo.wtPos = +wtpos.value; };
        wtpos.onchange = dirty;
        amt.oninput = () => { src.amount = +amt.value; amtv.textContent = src.amount.toFixed(2) + '×'; };
        amt.onchange = dirty;
        retrig.onchange = () => { src.retrigger = retrig.checked; dirty(); };
        refresh();
      } else {
        panel.innerHTML = `
          <div class="mod-src-head" style="display: flex; justify-content: space-between; align-items: center;">
            <span>${INST_SOURCE_LABELS[si]} (note-gated)</span>
            <canvas data-k="env-canvas" width="60" height="24" style="background: rgba(255,255,255,0.05); border-radius: 2px; margin-left: 8px; cursor: crosshair;" title="Envelope Shape"></canvas>
          </div>
          <label class="mod-row">A <input type="range" data-k="a" min="0.001" max="2" step="0.001"></label>
          <label class="mod-row">D <input type="range" data-k="d" min="0.001" max="2" step="0.001"></label>
          <label class="mod-row">S <input type="range" data-k="s" min="0" max="1" step="0.01"></label>
          <label class="mod-row">R <input type="range" data-k="r" min="0.001" max="4" step="0.001"></label>
          <label class="mod-row" title="master depth on every route from this source (a modulation target)">Amt <input type="range" data-k="amt" min="0" max="2" step="0.01"><span data-k="amtv" class="mod-val"></span></label>`;
        wrap.appendChild(panel);

        const canvas = q<HTMLCanvasElement>(panel, 'env-canvas');
        const ctx = canvas?.getContext('2d');
        const drawEnv = () => {
          if (!ctx) return;
          const { a, d, s, r } = src.env;
          const w = canvas.width, h = canvas.height;
          ctx.clearRect(0, 0, w, h);
          
          const maxTime = Math.max(1, a + d + r + 0.5);
          const timeToX = (t: number) => (t / maxTime) * w;
          const valToY = (v: number) => h - v * (h - 2) - 1;
          
          ctx.beginPath();
          ctx.strokeStyle = displayAccent(pr.color);
          ctx.lineWidth = 1.5;
          ctx.lineJoin = 'round';
          ctx.moveTo(timeToX(0), valToY(0));
          ctx.lineTo(timeToX(a), valToY(1));
          ctx.lineTo(timeToX(a + d), valToY(s));
          ctx.lineTo(timeToX(a + d + 0.5), valToY(s));
          ctx.lineTo(timeToX(a + d + 0.5 + r), valToY(0));
          ctx.stroke();
        };

        const bind = (k: 'a' | 'd' | 's' | 'r') => {
          const el = q<HTMLInputElement>(panel, k);
          el.value = String(src.env[k]);
          el.oninput = () => { src.env[k] = +el.value; drawEnv(); };
          el.onchange = dirty;
        };
        bind('a'); bind('d'); bind('s'); bind('r');
        const amt = q<HTMLInputElement>(panel, 'amt'); const amtv = q<HTMLSpanElement>(panel, 'amtv');
        amt.value = String(src.amount ?? 1); amtv.textContent = (src.amount ?? 1).toFixed(2) + '×';
        amt.oninput = () => { src.amount = +amt.value; amtv.textContent = src.amount.toFixed(2) + '×'; };
        amt.onchange = dirty;
        drawEnv();
      }
    });

    // ── Routes: source → this instance's target, depth, polarity ──
    const targets = instModTargetsForType(name);
    // Per-row options: hide a modsrc target that addresses the row's OWN source slot
    // (no self-targeting — LFO 1 can drive LFO 2 / the env, but not itself).
    const tgtOptsFor = (sourceSlot: number) => '<option value="-1">— Off —</option>' +
      targets.filter((t) => !(t.scope === 'modsrc' && t.modSlot === sourceSlot))
        .map((t) => `<option value="${t.id}">${t.pitch ? 'Pitch' : t.scope === 'fx' ? 'FX ' + t.label : t.scope === 'modsrc' ? '→ ' + t.label : t.label}</option>`).join('');
    const srcOpts = mod.sources.map((_, i) => `<option value="${i}">${INST_SOURCE_LABELS[i]}</option>`).join('');

    const matrix = document.createElement('div');
    matrix.className = 'mod-routes';
    const addBtn = mod.routes.length < INST_MOD_MAX_ROUTES ? '<button class="mod-add" data-k="add">+ Route</button>' : '';
    matrix.innerHTML = `<div class="mod-head">Routes ${addBtn}</div>`;
    mod.routes.forEach((r, ri) => {
      const row = document.createElement('div');
      row.className = 'mod-route';
      row.innerHTML = `
        <select data-k="src" title="source">${srcOpts}</select>
        <select data-k="tgt" title="destination">${tgtOptsFor(r.source)}</select>
        <input type="range" data-k="depth" min="0" max="1" step="0.01" title="depth">
        <label class="mod-bip" title="bipolar (±swing vs one-sided)"><input type="checkbox" data-k="bip"> ±</label>
        <label class="mod-bip" title="invert (flip the sign — pair with another route for opposite motion)"><input type="checkbox" data-k="inv"> ∓</label>
        <button data-k="del" title="remove route">✕</button>`;
      matrix.appendChild(row);
      const srcSel = q<HTMLSelectElement>(row, 'src');
      const tgt = q<HTMLSelectElement>(row, 'tgt');
      const depth = q<HTMLInputElement>(row, 'depth');
      const bip = q<HTMLInputElement>(row, 'bip');
      const inv = q<HTMLInputElement>(row, 'inv');
      srcSel.value = String(Math.min(r.source, mod.sources.length - 1));
      tgt.value = String(r.targetParamId);
      depth.value = String(r.depth);
      bip.checked = r.bipolar;
      inv.checked = !!r.invert;
      srcSel.onchange = () => {
        r.source = +srcSel.value;
        // The new source can't target its own slot — drop the route if it now would.
        const ct = targets.find((t) => t.id === r.targetParamId);
        if (ct && ct.scope === 'modsrc' && ct.modSlot === r.source) r.targetParamId = -1;
        tgt.innerHTML = tgtOptsFor(r.source);
        tgt.value = String(r.targetParamId);
        dirty();
      };
      tgt.onchange = () => { r.targetParamId = +tgt.value; dirty(); };
      depth.oninput = () => { r.depth = +depth.value; };
      depth.onchange = dirty;
      bip.onchange = () => { r.bipolar = bip.checked; dirty(); };
      inv.onchange = () => { r.invert = inv.checked; dirty(); };
      q<HTMLButtonElement>(row, 'del').onclick = () => { mod.routes.splice(ri, 1); dirty(); this._buildParams(); };
    });
    const add = q<HTMLButtonElement>(matrix, 'add');
    if (add) add.onclick = () => {
      const r: ModRoute = { source: 0, targetParamId: -1, depth: 0.3, bipolar: true, invert: false };
      mod.routes.push(r); dirty(); this._buildParams();
    };
    wrap.appendChild(matrix);
    this.paramEl.appendChild(wrap);
  }

  // Spectra resynthesis: load your own sample for the Morph knob to crossfade into.
  // The sample's harmonic profile is analyzed + uploaded by App._syncRendererFx →
  // SynthRenderer.syncAdditiveSpectra; no sampler-style loop/tune controls needed.
  _buildAdditiveUI(pr: InstrumentInstance) {
    const wrap = document.createElement('div');
    wrap.className = 'additive-resynth-ui';
    wrap.style.gridColumn = '1 / -1';
    wrap.style.marginTop = '4px';
    wrap.style.padding = '8px';
    wrap.style.background = 'rgba(0,0,0,0.2)';
    wrap.style.borderRadius = '4px';
    wrap.style.boxSizing = 'border-box';
    wrap.style.width = '100%';
    wrap.style.minWidth = '0';
    wrap.style.overflow = 'hidden';

    const info = document.createElement('div');
    info.style.marginBottom = '8px';
    info.style.whiteSpace = 'nowrap';
    info.style.overflow = 'hidden';
    info.style.textOverflow = 'ellipsis';
    info.style.fontSize = '12px';
    if (pr.sample && pr.sample.pcm.length > 0) {
      info.textContent = `Resynth: ${pr.sample.name} (${(pr.sample.pcm.length / 48000).toFixed(2)}s) — raise Morph to blend in`;
      info.title = info.textContent;
    } else {
      info.textContent = 'Resynthesis: load a sample, then raise Morph';
    }
    wrap.appendChild(info);

    const btn = document.createElement('button');
    btn.textContent = pr.sample ? 'Replace Sample…' : 'Load Sample…';
    btn.style.width = pr.sample ? '68%' : '100%';
    btn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
          const pcm = await decodeAudioFile(file);
          pr.sample = { name: file.name, pcm, rootNote: 60, loopStart: 0, loopEnd: pcm.length, loopMode: 0 };
          if (pr.p0[3] < 0.01) pr.p0[3] = 0.6;   // dial Morph in so the analyzed spectrum is audible immediately
          this.app?._syncRendererFx();           // → syncAdditiveSpectra analyzes + uploads the profile
          this.app?.markDirty('instrument');
          this._buildParams();
        } catch (err) {
          console.error('Failed to load sample', err);
          alert('Failed to load sample: ' + (err as Error).message);
        }
      };
      input.click();
    };
    wrap.appendChild(btn);

    if (pr.sample) {
      const clr = document.createElement('button');
      clr.textContent = 'Clear';
      clr.style.width = '28%';
      clr.style.marginLeft = '4%';
      clr.onclick = () => {
        pr.sample = undefined;
        this.app?._syncRendererFx();
        this.app?.markDirty('instrument');
        this._buildParams();
      };
      wrap.appendChild(clr);
    }

    this.paramEl.appendChild(wrap);
  }

  _buildSamplerUI(pr: InstrumentInstance) {
    const wrap = document.createElement('div');
    wrap.className = 'sampler-ui';
    wrap.style.gridColumn = '1 / -1';
    wrap.style.marginTop = '4px';
    wrap.style.padding = '8px';
    wrap.style.background = 'rgba(0,0,0,0.2)';
    wrap.style.borderRadius = '4px';
    wrap.style.boxSizing = 'border-box';
    wrap.style.width = '100%';
    wrap.style.minWidth = '0';
    wrap.style.overflow = 'hidden';

    const info = document.createElement('div');
    info.style.marginBottom = '8px';
    info.style.whiteSpace = 'nowrap';
    info.style.overflow = 'hidden';
    info.style.textOverflow = 'ellipsis';
    info.style.fontSize = '12px';
    
    if (pr.sample) {
      const sec = (pr.sample.pcm.length / 48000).toFixed(2);
      info.textContent = `Loaded: ${pr.sample.name} (${sec}s)`;
      info.title = info.textContent;
    } else {
      info.textContent = 'No sample loaded';
    }
    wrap.appendChild(info);

    const btn = document.createElement('button');
    btn.textContent = 'Load Sample...';
    btn.style.width = '100%';
    btn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
          const audio = await ctx.decodeAudioData(buf);
          let pcm = audio.getChannelData(0);
          
          if (audio.sampleRate !== 48000) {
            console.warn(`Browser ignored 48000 Hz context; manually resampling from ${audio.sampleRate} Hz`);
            const ratio = audio.sampleRate / 48000;
            const newLen = Math.floor(pcm.length / ratio);
            const newPcm = new Float32Array(newLen);
            for (let i = 0; i < newLen; i++) {
              const pos = i * ratio;
              const idx = Math.floor(pos);
              const frac = pos - idx;
              if (idx + 1 < pcm.length) {
                newPcm[i] = pcm[idx] * (1 - frac) + pcm[idx + 1] * frac;
              } else {
                newPcm[i] = pcm[idx];
              }
            }
            pcm = newPcm;
          }

          const maxLen = 4096 * (4096 / 16);
          if (pcm.length > maxLen) {
            console.warn(`Sample too long (${pcm.length} frames). Truncating to ${maxLen} frames.`);
            pcm = pcm.slice(0, maxLen);
          }

          pr.sample = {
            name: file.name,
            pcm,
            rootNote: 60,
            loopStart: 0,
            loopEnd: pcm.length,
            loopMode: 0
          };
          this.app?._syncRendererFx();
          this.app?.markDirty('instrument');
          this._buildParams();
        } catch (err) {
          console.error("Failed to load sample", err);
          alert("Failed to load sample: " + (err as Error).message);
        }
      };
      input.click();
    };
    wrap.appendChild(btn);

    if (pr.sample) {
      const controls = document.createElement('div');
      controls.style.marginTop = '8px';
      controls.style.display = 'grid';
      controls.style.gridTemplateColumns = '1fr 1fr';
      controls.style.gap = '8px';

      const addInput = (labelTxt: string, val: number, onChange: (v: number) => void) => {
        const d = document.createElement('div');
        d.style.display = 'flex'; d.style.flexDirection = 'column';
        d.style.minWidth = '0';
        const l = document.createElement('label'); l.textContent = labelTxt;
        l.style.fontSize = '10px'; l.style.color = '#888';
        l.style.whiteSpace = 'nowrap';
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.value = String(val);
        inp.style.background = '#111'; inp.style.color = '#fff';
        inp.style.border = '1px solid #333'; inp.style.padding = '2px 4px';
        inp.style.width = '100%'; inp.style.boxSizing = 'border-box';
        inp.onchange = (e) => {
          onChange(Number((e.target as HTMLInputElement).value));
          this.app?._syncRendererFx();
          this.app?.markDirty('instrument');
        };
        d.append(l, inp);
        controls.appendChild(d);
      };

      addInput('Root Note', pr.sample.rootNote, v => pr.sample!.rootNote = v);
      
      const modeDiv = document.createElement('div');
      modeDiv.style.display = 'flex'; modeDiv.style.flexDirection = 'column';
      modeDiv.style.minWidth = '0';
      const mLabel = document.createElement('label'); mLabel.textContent = 'Loop Mode';
      mLabel.style.fontSize = '10px'; mLabel.style.color = '#888';
      mLabel.style.whiteSpace = 'nowrap';
      const sel = document.createElement('select');
      sel.style.background = '#111'; sel.style.color = '#fff';
      sel.style.border = '1px solid #333'; sel.style.padding = '2px 4px';
      sel.style.width = '100%'; sel.style.boxSizing = 'border-box';
      sel.innerHTML = `<option value="0">One-Shot</option><option value="1">Forward</option><option value="2">Ping-Pong</option>`;
      sel.value = String(pr.sample.loopMode);
      sel.onchange = (e) => {
        pr.sample!.loopMode = Number((e.target as HTMLSelectElement).value);
        this.app?._syncRendererFx();
        this.app?.markDirty('instrument');
      };
      modeDiv.append(mLabel, sel);
      controls.appendChild(modeDiv);

      addInput('Loop Start', pr.sample.loopStart, v => pr.sample!.loopStart = v);
      addInput('Loop End', pr.sample.loopEnd, v => pr.sample!.loopEnd = v);

      wrap.appendChild(controls);
    }

    this.paramEl.appendChild(wrap);
  }

  // Two small canvases under the WVT knobs, each drawing one oscillator's current
  // morphed single cycle (bank + Position) from the shared wavetable arrays. A rAF
  // redraws from the live instance params so turning Bank/Pos animates the scope.
  _buildWtScopes(pr: InstrumentInstance) {
    const wrap = document.createElement('div');
    wrap.className = 'wt-scopes';
    const mk = (title: string) => {
      const box = document.createElement('div'); box.className = 'wt-scope';
      const lab = document.createElement('div'); lab.className = 'wt-scope-label'; lab.textContent = title;
      const c = document.createElement('canvas'); c.width = 240; c.height = 56;
      box.appendChild(lab); box.appendChild(c); wrap.appendChild(box);
      return c.getContext('2d')!;
    };
    const c1 = mk('OSC 1'), c2 = mk('OSC 2');
    this.paramEl.appendChild(wrap);
    const color = pr.color || '#36e0d6';

    const draw = (ctx: CanvasRenderingContext2D, bank: number, pos: number) => {
      const W = ctx.canvas.width, H = ctx.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      const b = Math.max(0, Math.min(WT_TABLES.length - 1, Math.round(bank)));
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let px = 0; px <= W; px++) {
        const v = sampleTable(WT_TABLES[b], WT_FRAMES, WT_SAMPLES, pos, px / W);
        const y = H / 2 - v * (H / 2 - 3);
        px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
      }
      ctx.stroke();
    };
    // Live Position: while a voice of THIS instance is sounding, the engine has
    // written the LFO/automation-modulated value into vd.p1, so the scope animates
    // with the modulation. Idle (no active voice) → the base knob value.
    const livePos = (idx: number, base: number) => {
      const eng = this.engine;
      for (let v = 0; v < eng.voices.length; v++) {
        if (eng.voices[v].active && eng.voices[v].instrument === this.selected) return eng.vd.p1[v * 4 + idx];
      }
      return base;
    };
    const tick = () => {
      // Stop if the panel was rebuilt for another instrument.
      if (this._instr !== pr || !wrap.isConnected) { this._wtScopeRaf = 0; return; }
      const banks = pr.p2 ?? [0, 0];
      draw(c1, banks[0], livePos(0, pr.p1[0]));   // osc1: bank1 / pos1 (live)
      draw(c2, banks[1], livePos(1, pr.p1[1]));   // osc2: bank2 / pos2 (live)
      this._wtScopeRaf = requestAnimationFrame(tick);
    };
    this._wtScopeRaf = requestAnimationFrame(tick);
  }

  // Sync the preset dropdown to whatever preset (if any) the current params match.
  _refreshPresetSelection() {
    const pSel = document.getElementById('instrument-preset') as HTMLSelectElement | null;
    if (!pSel) return;
    const match = this._findMatchingPreset();
    if (this._type === 'dx7') {
      pSel.value = String((match.rom === this.activeRomFile) ? match.index : -1);
    } else {
      pSel.value = String(match.index);
    }
  }
}

export function bindKnob(
  knobEl: KnobEl,
  valEl: HTMLElement,
  min: number,
  max: number,
  step: number,
  initialVal: number,
  isPercent: boolean,
  onChange: (v: number) => void,
  formatFn?: ((v: number) => string) | null,
  onCommit?: (v: number) => void,
  log = false,
  trackEl?: HTMLElement,
) {
  let val = initialVal;

  // Position↔value mapping. Linear by default; logarithmic (equal travel per octave)
  // when `log` and min > 0. Both the rotation and the drag work in this [0,1] ratio
  // space, so linear behaviour is unchanged.
  const lg = log && min > 0;
  const toRatio = (v: number) => lg ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  const fromRatio = (r: number) => lg ? min * Math.pow(max / min, r) : min + r * (max - min);

  const updateUI = (v: number) => {
    const ratio = Math.max(0, Math.min(1, toRatio(v)));
    if (knobEl.classList.contains('eq-slider-handle')) {
      knobEl.style.top = `${(1 - ratio) * 100}%`;
    } else {
      const deg = -135 + ratio * 270;
      knobEl.style.transform = `rotate(${deg}deg)`;
    }
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
  knobEl._extSet = (v: number) => {
    if (v === val || v == null || Number.isNaN(v)) return;
    val = v;
    updateUI(v);
  };

  const eventY = (ev: MouseEvent | TouchEvent): number =>
    'touches' in ev ? (ev.touches[0]?.clientY ?? 0) : ev.clientY;

  const onStart = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    // The handle sits inside the track; both bind onStart. Stop the handle's event
    // bubbling to the track so a handle-grab doesn't spin up two drag sessions.
    if (trackEl && e.currentTarget === knobEl) e.stopPropagation();

    if (trackEl) {
      const rect = trackEl.getBoundingClientRect();
      const updateFromEvent = (ev: MouseEvent | TouchEvent) => {
        const currentY = eventY(ev);
        const relativeY = (currentY - rect.top) / (rect.height || 1);
        const r = Math.max(0, Math.min(1, 1 - relativeY));
        let newVal = fromRatio(r);
        if (step) {
          newVal = Math.round(newVal / step) * step;
        }
        newVal = Math.max(min, Math.min(max, newVal));
        if (newVal !== val) {
          val = newVal;
          updateUI(newVal);
          onChange(newVal);
        }
      };

      updateFromEvent(e);

      const onMove = (moveEv: MouseEvent | TouchEvent) => {
        updateFromEvent(moveEv);
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
    } else {
      const startY = eventY(e);
      const startRatio = toRatio(val);
      const pixelsPerRange = 150;   // full sweep (ratio 0→1) per 150 px

      const onMove = (moveEv: MouseEvent | TouchEvent) => {
        const currentY = eventY(moveEv);
        const deltaY = startY - currentY;
        const r = Math.max(0, Math.min(1, startRatio + deltaY / pixelsPerRange));
        let newVal = fromRatio(r);
        if (step) {
          newVal = Math.round(newVal / step) * step;
        }
        newVal = Math.max(min, Math.min(max, newVal));
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
    }
  };

  knobEl.addEventListener('mousedown', onStart);
  knobEl.addEventListener('touchstart', onStart, { passive: false });
  if (trackEl) {
    trackEl.addEventListener('mousedown', onStart);
    trackEl.addEventListener('touchstart', onStart, { passive: false });
  }
}
