// Tracker engine: turns the BPM clock + pattern grid into per-block voice data
// for the GPU renderer. It is sample-accurate — note-ons are scheduled at exact
// frames within a render block, not quantised to block boundaries.
//
// Mapping: tracker channel index == voice index (8 channels → 8 voices, mono per
// channel). When a new note hits a channel, it overwrites that voice.
import { VOICES, INSTRUMENTS, INSTRUMENT_COLORS, noteToFreq, BLOCK } from '../constants.js';
import { EMPTY, OFF, NO_FX } from './pattern.js';
import { defaultParams, instrumentsFromParams, DRUM_MAP } from './song.js';
import { targetById, denorm } from './automation.js';

export const HELD = 1e9; // offRel sentinel: note is still held

export class Engine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.song = null;
    this.rowsPerBeat = 4;
    this.bpm = 174;

    // Per-engine-type fxParams (the same object the renderer's EffectsChains
    // read). Set by the app whenever a song's fx is (re)built; used to apply
    // 'fx'-scope automation commands. Null until wired.
    this.fxParams = null;

    // Live automation read-out for the UI. 'inst'-scope commands write the
    // per-voice slot (not the instance base), so the sidebar knobs can't see
    // them; we record the last applied value here, keyed `${instIdx}:${bank}:${i}`,
    // so the UI can animate the knob during playback and revert on stop. ('fx'
    // scope mutates the real fxParams object, so those knobs just re-read it.)
    this.autoLive = { inst: new Map() };

    this.playing = false;
    this.startFrame = null;   // absolute frame mapped to song row 0
    this.lastBlockStart = 0;
    this.displayRow = 0;
    this.displayOrder = 0;
    this.playMode = 'song';
    this.currentPatternIdx = 0;

    // Instrument table: a list of instances, each { name, type, p0, p1, ops? }.
    // Patterns/voices reference an instance by index. Seeded with one instance per
    // engine type (INSTRUMENTS order); the UI can append more (e.g. two 303s).
    this.instruments = instrumentsFromParams(defaultParams());

    // Per-voice runtime state (absolute frames). `instrument` = index into
    // this.instruments; `inst` = engine-type id (for uInst[v] / shader dispatch).
    this.voices = Array.from({ length: VOICES }, () => ({
      active: false, inst: 0, instrument: 0, freq: 440, vel: 0,
      onFrame: 0, offFrame: HELD,
    }));

    this.muted = new Array(VOICES).fill(false);

    // GPU-facing buffers, updated in place every block.
    this.vd = {
      active: new Int32Array(VOICES),
      inst: new Int32Array(VOICES),
      freq: new Float32Array(VOICES),
      vel: new Float32Array(VOICES),
      onRel: new Float32Array(VOICES),
      offRel: new Float32Array(VOICES),
      p0: new Float32Array(VOICES * 4),
      p1: new Float32Array(VOICES * 4),
      gain: new Float32Array(VOICES).fill(1),
      pan: new Float32Array(VOICES).fill(0.5),
      master: 0.32,
      // Per-voice DX7 operator config, packed into two vec4 arrays (keeps the
      // fragment-uniform count low vs 8 scalar arrays). Indexed [v*6 + op]:
      //   A = (coarse, fine, level, detune)   B = (mode, sustain, release, decay)
      dx7Ops: {
        A: new Float32Array(VOICES * 6 * 4),
        B: new Float32Array(VOICES * 6 * 4),
      }
    };

    this._preview = 0; // round-robin voice cursor for live keyboard preview
  }

  loadSong(song) {
    this.song = song;
    this.rowsPerBeat = song.rowsPerBeat || 4;
  }

  get samplesPerRow() {
    return (this.sampleRate * 60) / (this.bpm * this.rowsPerBeat);
  }
  // Wall-clock seconds per pattern row (sample-rate independent — works before
  // audio has started).
  get secondsPerRow() {
    return 60 / (this.bpm * this.rowsPerBeat);
  }
  // Total rows of the whole arrangement (every order slot), regardless of the
  // current play mode. Used for the track-length display.
  songRowCount() {
    if (!this.song) return 0;
    let sum = 0;
    for (const patIdx of this.song.order) {
      const pat = this.song.patterns[patIdx];
      if (pat) sum += pat.rows;
    }
    return sum;
  }
  get totalRows() {
    if (!this.song) return 0;
    if (this.playMode === 'pattern') {
      const pat = this.song.patterns[this.currentPatternIdx];
      return pat ? pat.rows : 0;
    }
    let sum = 0;
    for (const patIdx of this.song.order) {
      const pat = this.song.patterns[patIdx];
      if (pat) sum += pat.rows;
    }
    return sum;
  }

  play(mode = 'song') { this.playMode = mode; this.playing = true; this.startFrame = null; this.autoLive.inst.clear(); }
  stop() {
    this.playing = false;
    for (const v of this.voices) v.active = false;
  }

  // --- note triggering ----------------------------------------------------

  // `inst` is an index into this.instruments (the instrument table).
  triggerNote(ch, note, inst, vol, frame) {
    const v = this.voices[ch];
    if (note === OFF) { v.offFrame = frame; return; }
    const idx = this.instruments[inst] ? inst : 0;   // clamp stale/out-of-range
    const instr = this.instruments[idx];
    v.active = true;
    v.instrument = idx;
    v.inst = INSTRUMENTS.indexOf(instr.type);         // engine-type id for dispatch
    v.vel = vol;
    v.onFrame = frame;
    v.offFrame = HELD;
    if (instr.type === '808') {
      v.freq = 220; // unused by 808, but keep sane
      this._writeParams(ch, instr, DRUM_MAP[note] ?? 0);
    } else {
      v.freq = noteToFreq(note);
      this._writeParams(ch, instr, null);
    }
  }

  // Copy an instrument instance's param banks into the voice's slots. For 808,
  // override the drum-slot field (p0.x) from the note's drum index.
  _writeParams(ch, instr, drumSlot) {
    const o = ch * 4;
    for (let k = 0; k < 4; k++) { this.vd.p0[o + k] = instr.p0[k]; this.vd.p1[o + k] = instr.p1[k]; }
    if (drumSlot !== null) this.vd.p0[o] = drumSlot;
  }

  // Append a new instrument instance of the given engine type; returns its index.
  addInstrument(type) {
    const dp = defaultParams()[type];
    const used = new Set(this.instruments.map((i) => i.color));
    const color = INSTRUMENT_COLORS.find((c) => !used.has(c))
      || INSTRUMENT_COLORS[this.instruments.length % INSTRUMENT_COLORS.length];
    const e = { name: type.toUpperCase(), type, color, p0: [...dp.p0], p1: [...dp.p1] };
    if (dp.ops) e.ops = dp.ops.map((o) => ({ ...o }));
    this.instruments.push(e);
    return this.instruments.length - 1;
  }

  // Remove an instance (keeps ≥1). Silences voices on it, shifts higher voice/
  // pattern references down, and remaps cells that pointed at it to instance 0.
  removeInstrument(idx) {
    if (this.instruments.length <= 1) return false;
    this.instruments.splice(idx, 1);
    for (const v of this.voices) {
      if (v.instrument === idx) v.active = false;
      else if (v.instrument > idx) v.instrument--;
    }
    if (this.song) {
      for (const pat of this.song.patterns) {
        for (let i = 0; i < pat.inst.length; i++) {
          if (pat.inst[i] === idx) pat.inst[i] = 0;
          else if (pat.inst[i] > idx) pat.inst[i]--;
        }
      }
    }
    return true;
  }

  // Live keyboard preview — round-robins across voices so chords are possible.
  // Returns the voice index so the UI can release it on key-up.
  previewNote(instIndex, note, vol = 0.9) {
    const ch = this._preview;
    this._preview = (this._preview + 1) % VOICES;
    const frame = this.lastBlockStart + BLOCK; // next block
    this.triggerNote(ch, note, instIndex, vol, frame);
    return ch;
  }
  previewOff(ch) {
    if (ch != null) this.voices[ch].offFrame = this.lastBlockStart + BLOCK;
  }

  // --- per-block update ---------------------------------------------------

  resolveSongRow(songRow) {
    if (!this.song) return { orderIdx: 0, patIdx: 0, localRow: 0 };
    let accum = 0;
    for (let i = 0; i < this.song.order.length; i++) {
      const patIdx = this.song.order[i];
      const pat = this.song.patterns[patIdx];
      const rows = pat ? pat.rows : 0;
      if (songRow < accum + rows) {
        return {
          orderIdx: i,
          patIdx: patIdx,
          localRow: songRow - accum
        };
      }
      accum += rows;
    }
    const lastIdx = Math.max(0, this.song.order.length - 1);
    const lastPatIdx = this.song.order[lastIdx] ?? 0;
    return { orderIdx: lastIdx, patIdx: lastPatIdx, localRow: 0 };
  }

  // Called once per render block with the absolute start frame. Schedules any
  // row triggers landing in [blockStart, blockStart+BLOCK) and refreshes vd.
  advance(blockStart) {
    this.lastBlockStart = blockStart;

    if (this.playing && this.song) {
      if (this.startFrame === null) this.startFrame = blockStart;
      const spr = this.samplesPerRow;
      const blockEnd = blockStart + BLOCK;
      let k = Math.ceil((blockStart - this.startFrame) / spr);
      if (k < 0) k = 0;
      
      const total = this.totalRows;
      let ended = false;
      
      for (; ; k++) {
        if (this.playMode === 'song' && k >= total) {
          ended = true;
          break;
        }
        const f = this.startFrame + k * spr;
        if (f >= blockEnd) break;
        this._triggerRow(k, f);
      }
      
      if (ended) {
        this.stop();
      }
      
      // Row shown in the UI = the row covering the end of this block.
      const cur = Math.floor((blockEnd - 1 - this.startFrame) / spr);
      if (this.playMode === 'pattern') {
        const pat = this.song.patterns[this.currentPatternIdx];
        if (pat) {
          const totalPat = pat.rows;
          const r = ((cur % totalPat) + totalPat) % totalPat;
          this.displayOrder = 0;
          this.displayRow = r;
        }
      } else {
        if (total > 0 && !ended) {
          const songRow = ((cur % total) + total) % total;
          const { orderIdx, localRow } = this.resolveSongRow(songRow);
          this.displayOrder = orderIdx;
          this.displayRow = localRow;
        }
      }
    }

    this._refreshVoiceData(blockStart);

    // Refresh each active DX7 voice's operator config from ITS instrument, packed
    // into the per-voice vec4 arrays. Refreshing every block (not just at trigger)
    // keeps knob edits live; per-voice means two DX7 instances can differ.
    const { A, B } = this.vd.dx7Ops;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      if (!vc.active) continue;
      const instr = this.instruments[vc.instrument];
      if (!instr || instr.type !== 'dx7' || !instr.ops) continue;
      for (let i = 0; i < 6; i++) {
        const op = instr.ops[i];
        const o = (v * 6 + i) * 4;
        A[o] = op.coarse; A[o + 1] = op.fine; A[o + 2] = op.level; A[o + 3] = op.detune;
        B[o] = op.mode ?? 0; B[o + 1] = op.sustain ?? 0.7; B[o + 2] = op.release ?? 0.25; B[o + 3] = op.decay;
      }
    }
    return this.vd;
  }

  _triggerRow(k, frame) {
    const fr = Math.round(frame);
    if (this.playMode === 'pattern') {
      const pat = this.song.patterns[this.currentPatternIdx];
      if (!pat) return;
      const row = ((k % pat.rows) + pat.rows) % pat.rows;
      for (let ch = 0; ch < pat.channels; ch++) {
        const note = pat.note(row, ch);
        if (note === EMPTY) continue;
        const i = pat.idx(row, ch);
        this.triggerNote(ch, note, pat.inst[i], pat.vol[i], fr);
      }
      this._applyAutomation(pat, row);
    } else {
      const total = this.totalRows;
      if (total <= 0) return;
      const songRow = ((k % total) + total) % total;
      const { patIdx, localRow } = this.resolveSongRow(songRow);
      const pat = this.song.patterns[patIdx];
      if (!pat) return;
      for (let ch = 0; ch < pat.channels; ch++) {
        const note = pat.note(localRow, ch);
        if (note === EMPTY) continue;
        const i = pat.idx(localRow, ch);
        this.triggerNote(ch, note, pat.inst[i], pat.vol[i], fr);
      }
      this._applyAutomation(pat, localRow);
    }
  }

  // Apply this row's automation commands. Runs AFTER note triggers so a command
  // sharing a cell with a note overrides the note-on param snapshot. 'inst'
  // targets write the live per-voice slot (channel-local, holds until the next
  // note re-snapshots); 'fx' targets write the engine-type's shared fxParams.
  _applyAutomation(pat, row) {
    for (let ch = 0; ch < pat.channels; ch++) {
      const i = pat.idx(row, ch);
      const id = pat.fxCmd[i];
      if (id === NO_FX) continue;
      const t = targetById(id);
      if (!t) continue;
      const value = denorm(t, pat.fxVal[i]);
      if (t.scope === 'inst') {
        const arr = t.bank === 'p1' ? this.vd.p1 : this.vd.p0;
        arr[ch * 4 + t.index] = value;
        const v = this.voices[ch];
        const instrIdx = (v && v.active) ? v.instrument : pat.inst[i];
        this.autoLive.inst.set(`${instrIdx}:${t.bank}:${t.index}`, value);
      } else if (this.fxParams) {
        const fp = this.fxParams[this._channelType(ch, pat, i)];
        if (fp) fp[t.key] = value;
      }
    }
  }

  // Engine type driving a channel right now: the sounding voice's instrument if
  // active, else the cell's own instrument, else the first instance.
  _channelType(ch, pat, i) {
    const v = this.voices[ch];
    let instr = (v && v.active) ? this.instruments[v.instrument] : null;
    if (!instr) instr = this.instruments[pat.inst[i]] || this.instruments[0];
    return instr ? instr.type : '303';
  }

  _refreshVoiceData(blockStart) {
    const vd = this.vd;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      // Reclaim voices whose release tail has long finished.
      if (vc.active && vc.offFrame !== HELD && (blockStart - vc.offFrame) / this.sampleRate > 2.5) {
        vc.active = false;
      }
      vd.active[v] = vc.active ? 1 : 0;
      vd.inst[v] = vc.inst;
      vd.freq[v] = vc.freq;
      vd.vel[v] = vc.vel;
      vd.onRel[v] = vc.onFrame - blockStart;
      vd.offRel[v] = vc.offFrame === HELD ? HELD : vc.offFrame - blockStart;
      vd.gain[v] = this.muted[v] ? 0.0 : 1.0;
    }
  }
}
