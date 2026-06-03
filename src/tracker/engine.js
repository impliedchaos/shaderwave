// Tracker engine: turns the BPM clock + pattern grid into per-block voice data
// for the GPU renderer. It is sample-accurate — note-ons are scheduled at exact
// frames within a render block, not quantised to block boundaries.
//
// Mapping: tracker channel index == voice index (8 channels → 8 voices, mono per
// channel). When a new note hits a channel, it overwrites that voice.
import { VOICES, INSTRUMENTS, noteToFreq, BLOCK } from '../constants.js';
import { EMPTY, OFF } from './pattern.js';
import { defaultParams, DRUM_MAP } from './song.js';

const HELD = 1e9; // offRel sentinel: note is still held

export class Engine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.song = null;
    this.rowsPerBeat = 4;
    this.bpm = 174;

    this.playing = false;
    this.startFrame = null;   // absolute frame mapped to song row 0
    this.lastBlockStart = 0;
    this.displayRow = 0;
    this.displayOrder = 0;

    this.params = defaultParams();

    // Per-voice runtime state (absolute frames).
    this.voices = Array.from({ length: VOICES }, () => ({
      active: false, inst: 0, freq: 440, vel: 0,
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
      dx7Ops: {
        coarse: new Float32Array(6),
        fine: new Float32Array(6),
        level: new Float32Array(6),
        detune: new Float32Array(6),
        decay: new Float32Array(6),
        mode: new Float32Array(6)
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
  get totalRows() {
    return this.song.order.length * this.song.patterns[0].rows;
  }

  play() { this.playing = true; this.startFrame = null; }
  stop() {
    this.playing = false;
    for (const v of this.voices) v.active = false;
  }

  // --- note triggering ----------------------------------------------------

  triggerNote(ch, note, inst, vol, frame) {
    const v = this.voices[ch];
    if (note === OFF) { v.offFrame = frame; return; }
    v.active = true;
    v.inst = inst;
    v.vel = vol;
    v.onFrame = frame;
    v.offFrame = HELD;
    if (INSTRUMENTS[inst] === '808') {
      v.freq = 220; // unused by 808, but keep sane
      this._writeParams(ch, '808', DRUM_MAP[note] ?? 0);
    } else {
      v.freq = noteToFreq(note);
      this._writeParams(ch, INSTRUMENTS[inst], null);
    }
  }

  // Copy an instrument's param banks into the voice's slots. For 808, override
  // the drum-slot field (p0.x) from the note's drum index.
  _writeParams(ch, instName, drumSlot) {
    const pr = this.params[instName];
    const o = ch * 4;
    for (let k = 0; k < 4; k++) { this.vd.p0[o + k] = pr.p0[k]; this.vd.p1[o + k] = pr.p1[k]; }
    if (drumSlot !== null) this.vd.p0[o] = drumSlot;
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
      for (; ; k++) {
        const f = this.startFrame + k * spr;
        if (f >= blockEnd) break;
        this._triggerRow(k, f);
      }
      // Row shown in the UI = the row covering the end of this block.
      const cur = Math.floor((blockEnd - 1 - this.startFrame) / spr);
      const total = this.totalRows;
      const songRow = ((cur % total) + total) % total;
      const rows = this.song.patterns[0].rows;
      this.displayOrder = Math.floor(songRow / rows);
      this.displayRow = songRow % rows;
    }

    this._refreshVoiceData(blockStart);
    const dxOps = this.params['dx7']?.ops;
    if (dxOps) {
      for (let i = 0; i < 6; i++) {
        this.vd.dx7Ops.coarse[i] = dxOps[i].coarse;
        this.vd.dx7Ops.fine[i] = dxOps[i].fine;
        this.vd.dx7Ops.level[i] = dxOps[i].level;
        this.vd.dx7Ops.detune[i] = dxOps[i].detune;
        this.vd.dx7Ops.decay[i] = dxOps[i].decay;
        this.vd.dx7Ops.mode[i] = dxOps[i].mode !== undefined ? dxOps[i].mode : 0;
      }
    }
    return this.vd;
  }

  _triggerRow(k, frame) {
    const total = this.totalRows;
    const songRow = ((k % total) + total) % total;
    const rows = this.song.patterns[0].rows;
    const orderIdx = Math.floor(songRow / rows);
    const row = songRow % rows;
    const pat = this.song.patterns[this.song.order[orderIdx]];
    const fr = Math.round(frame);
    for (let ch = 0; ch < pat.channels; ch++) {
      const note = pat.note(row, ch);
      if (note === EMPTY) continue;
      const i = pat.idx(row, ch);
      this.triggerNote(ch, note, pat.inst[i], pat.vol[i], fr);
    }
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
