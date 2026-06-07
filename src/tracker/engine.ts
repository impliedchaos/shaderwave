// Tracker engine: turns the BPM clock + pattern grid into per-block voice data
// for the GPU renderer. It is sample-accurate — note-ons are scheduled at exact
// frames within a render block, not quantised to block boundaries.
//
// Mapping: tracker channel index == voice index (8 channels → 8 voices, mono per
// channel). When a new note hits a channel, it overwrites that voice.
import { VOICES, INSTRUMENTS, INSTRUMENT_COLORS, noteToFreq, BLOCK, DEFAULT_MASTER } from '../constants.js';
import { EMPTY, OFF } from './pattern.js';
import type { Pattern } from './pattern.js';
import { defaultParams, instrumentsFromParams, DRUM_MAP } from './song.js';
import { defaultFxParams } from '../gl/effects.js';
import { targetById, denorm } from './automation.js';
import { byType } from '../instruments/index.js';
import type {
  FxParamsByType, InstrumentInstance, InstrumentType, SongData, VoiceData,
} from '../types.js';

export const HELD = 1e9; // offRel sentinel: note is still held

// Per-voice runtime state (absolute frames). `instrument` indexes the instrument
// table; `inst` is the engine-type id used for shader dispatch.
interface Voice {
  active: boolean;
  inst: number;
  instrument: number;
  freq: number;          // nominal pitch (slides mutate this; vibrato/arp don't)
  vel: number;
  onFrame: number;
  offFrame: number;
  // Effect-column state (see _modulateVoices). fxCmd < 0 = no active effect.
  fxCmd: number;
  fxVal: number;
  fxStart: number;       // frame the effect last (re)started — vibrato/arp timing
  targetFreq: number;    // tone-portamento (3xx) destination pitch
}

// Effect modulation tuning (block-rate). Rates are per second; nibble/byte come
// from the cell's value (xx = whole byte, x/y = high/low nibble).
const FX_SLIDE = 0.5;    // 1xx/2xx: semitones/sec per value unit
const FX_PORTA = 0.6;    // 3xx: semitones/sec per value unit (meend speed)
const FX_VIB_HZ = 0.55;  // 4xy: vibrato Hz per speed nibble
const FX_VIB_DEPTH = 0.09; // 4xy: vibrato semitones per depth nibble
const FX_ARP_SEC = 0.04; // 0xy: seconds per arpeggio step
const FX_VOLSLIDE = 0.12; // Axy: volume (0..1) per sec per nibble

export class Engine {
  sampleRate: number;
  song: SongData | null;
  rowsPerBeat: number;
  bpm: number;
  fxParams: FxParamsByType | null;
  autoLive: { inst: Map<string, number> };
  playing: boolean;
  paused: boolean;
  _resumeOffset: number;
  startFrame: number | null;
  _rowCursor: number;            // next row index to fire (running; song-global or pattern-local)
  _nextRowFrame: number | null;  // absolute frame that row fires at; null → (re)anchor at next block
  lastBlockStart: number;
  displayRow: number;
  displayOrder: number;
  playMode: string;
  currentPatternIdx: number;
  instruments: InstrumentInstance[];
  voices: Voice[];
  muted: boolean[];
  channelPan: Float32Array;
  panAuto: Float32Array;
  songMaster = DEFAULT_MASTER;   // the loaded song's base global volume; VOL automation overrides vd.master transiently
  vd: VoiceData;
  _preview: number;

  constructor(sampleRate: number) {
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
    this.paused = false;       // stopped-but-holding-position (Pause vs Stop)
    this._resumeOffset = 0;     // frames into the song timeline to resume from
    this.startFrame = null;   // absolute frame mapped to song row 0
    this._rowCursor = 0;
    this._nextRowFrame = null;
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
      fxCmd: -1, fxVal: 0, fxStart: 0, targetFreq: 440,
    }));

    this.muted = new Array(VOICES).fill(false);

    // Per-channel stereo pan (0 = hard left, 0.5 = centre, 1 = hard right). The
    // header slider writes `channelPan` (the persistent base, saved with the
    // song); `panAuto` holds a live automation override (NaN = follow the base).
    // Both feed vd.pan each block, with the override winning. Like autoLive, the
    // override is transient — cleared on play/stop so the slider value returns.
    this.channelPan = new Float32Array(VOICES).fill(0.5);
    this.panAuto = new Float32Array(VOICES).fill(NaN);

    // GPU-facing buffers, updated in place every block.
    this.vd = {
      active: new Int32Array(VOICES),
      inst: new Int32Array(VOICES),
      instId: new Int32Array(VOICES),
      freq: new Float32Array(VOICES),
      vel: new Float32Array(VOICES),
      onRel: new Float32Array(VOICES),
      offRel: new Float32Array(VOICES),
      p0: new Float32Array(VOICES * 4),
      p1: new Float32Array(VOICES * 4),
      // Extra Moog-only banks (osc waveforms/octaves, glide, noise) + the pitch
      // each voice glides from. Other engines ignore these.
      p2: new Float32Array(VOICES * 4),
      p3: new Float32Array(VOICES * 4),
      freqFrom: new Float32Array(VOICES),
      gain: new Float32Array(VOICES).fill(1),
      pan: new Float32Array(VOICES).fill(0.5),
      master: DEFAULT_MASTER,
      // Per-voice DX7 operator config, packed into vec4 arrays (keeps the
      // fragment-uniform count low vs 8 scalar arrays). Indexed [v*6 + op]:
      //   A = (coarse, fine, level, detune)   B = (mode, sustain, release, decay)
      //   C = (r1, r2, r3, r4)                D = (l1, l2, l3, l4)
      dx7Ops: {
        A: new Float32Array(VOICES * 6 * 4),
        B: new Float32Array(VOICES * 6 * 4),
        C: new Float32Array(VOICES * 6 * 4),
        D: new Float32Array(VOICES * 6 * 4),
      }
    };

    this._preview = 0; // round-robin voice cursor for live keyboard preview
  }

  loadSong(song: SongData) {
    this.song = song;
    this.rowsPerBeat = song.rowsPerBeat || 4;
    // Global output gain saved with the song; absent → engine default (so a new
    // blank song resets it). This is the render-level master baked into the audio
    // (it affects recording), distinct from the monitor-only playback slider.
    this.songMaster = song.master ?? DEFAULT_MASTER;
    this.vd.master = this.songMaster;
    // Per-channel pan saved with the song; absent → centre. Clears any live
    // automation override so the loaded base shows immediately.
    const pan = song.pan;
    for (let v = 0; v < VOICES; v++) {
      this.channelPan[v] = (pan && pan[v] != null) ? pan[v] : 0.5;
      this.panAuto[v] = NaN;
    }
    // Clear any channel mutes — they belong to the previous song, not this one.
    this.muted.fill(false);
  }

  // Set the song's base global volume from the UI (the Song Editor's Volume knob).
  // Updates the live render gain and persists onto the song so it survives play/
  // stop (which reset vd.master to songMaster) and is saved with the song.
  setMaster(v: number) {
    this.songMaster = v;
    this.vd.master = v;
    if (this.song) this.song.master = v;
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

  // Total render length in frames for the full song, accounting for per-row BPM
  // automation (so an accelerando/ritardando exports at the correct length rather
  // than a constant-tempo estimate). Walks every song row in order, tracking bpm as
  // global BPM-automation rows change it, summing each row's duration.
  estimateSongFrames() {
    if (!this.song) return 0;
    const total = this.songRowCount();
    let bpm = this.bpm, frames = 0;
    for (let k = 0; k < total; k++) {
      const { patIdx, localRow } = this.resolveSongRow(k);
      const pat = this.song.patterns[patIdx];
      if (pat) {
        for (const tr of pat.autoTracks) {
          const t = targetById(tr.targetParamId);
          if (t && t.scope === 'global' && t.code === 'BPM') {
            const b = tr.data[localRow];
            if (b >= 0) bpm = denorm(t, b);
          }
        }
      }
      frames += (this.sampleRate * 60) / (Math.max(1, bpm) * this.rowsPerBeat);
    }
    return Math.ceil(frames);
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

  play(mode: string = 'song') {
    this.playMode = mode; this.playing = true; this.startFrame = null;
    this.paused = false; this._resumeOffset = 0; // fresh start → row 0
    this._rowCursor = 0; this._nextRowFrame = null;
    this.autoLive.inst.clear();
    this.panAuto.fill(NaN);
    this.vd.master = this.songMaster;   // drop any VOL automation override
  }
  // Pause: hold the current song position (so resume() continues from here) and
  // silence the voices. The transport clock keeps running while paused; the
  // elapsed offset is re-anchored against the live block in advance() on resume.
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.paused = true;
    this._nextRowFrame = null;   // resume re-anchors the row clock; _rowCursor holds the position
    for (const v of this.voices) v.active = false;
  }
  resume() {
    if (!this.paused) return;
    this.playing = true;
    this.paused = false;
    this.startFrame = null;
    this._nextRowFrame = null;   // continue from _rowCursor, re-anchored at the resume block
  }
  stop() {
    this.playing = false;
    this.paused = false; this._resumeOffset = 0;
    this._rowCursor = 0; this._nextRowFrame = null; this.startFrame = null;
    for (const v of this.voices) v.active = false;
    this.panAuto.fill(NaN);     // drop pan automation overrides; slider base returns
    this.autoLive.inst.clear(); // drop inst automation overrides; base params return
    this.vd.master = this.songMaster; // drop VOL automation override; song base returns
  }

  // --- note triggering ----------------------------------------------------

  // `inst` is an index into this.instruments (the instrument table).
  triggerNote(ch: number, note: number, inst: number, vol: number, frame: number) {
    const v = this.voices[ch];
    if (note === OFF) { v.offFrame = frame; return; }
    const wasActive = v.active, prevFreq = v.freq;    // for glide (capture before overwrite)
    const idx = this.instruments[inst] ? inst : 0;   // clamp stale/out-of-range
    const instr = this.instruments[idx];
    v.active = true;
    v.instrument = idx;
    v.inst = INSTRUMENTS.indexOf(instr.type);         // engine-type id for dispatch
    v.vel = vol;
    v.onFrame = frame;
    v.offFrame = HELD;
    v.fxCmd = -1;                                      // a fresh note clears any prior effect
    v.fxStart = frame;
    if (byType(instr.type)?.drum) {
      v.freq = 220; // unused by drum engines, but keep sane
      this._writeParams(ch, instr, idx, DRUM_MAP[note] ?? 0);
    } else {
      v.freq = noteToFreq(note);
      // Glide starts from the voice's previous pitch (Moog reads uFreqFrom);
      // a fresh voice glides from its own target = no glide.
      this.vd.freqFrom[ch] = wasActive ? prevFreq : v.freq;
      this._writeParams(ch, instr, idx, null);
    }
  }

  // Copy an instrument instance's param banks into the voice's slots, then layer
  // any active inst-automation overrides for that instance on top (so a note
  // triggered mid-automation snapshots the current automated value, not the
  // pristine base). For 808, override the drum-slot field (p0.x) from the note's
  // drum index. p2/p3 are Moog-only and copied when the instance has them.
  _writeParams(ch: number, instr: InstrumentInstance, instrIdx: number, drumSlot: number | null) {
    const o = ch * 4;
    for (let k = 0; k < 4; k++) { this.vd.p0[o + k] = instr.p0[k]; this.vd.p1[o + k] = instr.p1[k]; }
    if (instr.p2) for (let k = 0; k < 4; k++) this.vd.p2[o + k] = instr.p2[k];
    if (instr.p3) for (let k = 0; k < 4; k++) this.vd.p3[o + k] = instr.p3[k];
    if (this.autoLive.inst.size) {
      for (let k = 0; k < 4; k++) {
        const a0 = this.autoLive.inst.get(`${instrIdx}:p0:${k}`);
        if (a0 !== undefined) this.vd.p0[o + k] = a0;
        const a1 = this.autoLive.inst.get(`${instrIdx}:p1:${k}`);
        if (a1 !== undefined) this.vd.p1[o + k] = a1;
      }
    }
    if (drumSlot !== null) this.vd.p0[o] = drumSlot;
  }

  // Append a new instrument instance of the given engine type; returns its index.
  addInstrument(type: InstrumentType): number {
    const dp = defaultParams()[type] as InstrumentInstance;
    const used = new Set(this.instruments.map((i) => i.color));
    const color = INSTRUMENT_COLORS.find((c) => !used.has(c))
      || INSTRUMENT_COLORS[this.instruments.length % INSTRUMENT_COLORS.length];
    const e: InstrumentInstance = { name: byType(type)?.name ?? type.toUpperCase(), type, color, p0: [...dp.p0], p1: [...dp.p1], fx: defaultFxParams() };
    if (dp.ops) e.ops = dp.ops.map((o) => ({ ...o }));
    // defaultParams() already deep-clones the engine's extra banks (p2/p3) when
    // its descriptor declares them, so just carry whatever it produced.
    if (dp.p2) e.p2 = [...dp.p2];
    if (dp.p3) e.p3 = [...dp.p3];
    this.instruments.push(e);
    return this.instruments.length - 1;
  }

  // Remove an instance (keeps ≥1). Silences voices on it, shifts higher voice/
  // pattern references down, and remaps cells that pointed at it to instance 0.
  removeInstrument(idx: number): boolean {
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
        // Same shift for inst/fx automation tracks (their targetInstIdx is an
        // instrument index). chan tracks key on a channel and global tracks are
        // null, so both are left alone.
        for (const track of pat.autoTracks) {
          if ((track.targetScope === 'inst' || track.targetScope === 'fx') && track.targetInstIdx !== null) {
            if (track.targetInstIdx === idx) track.targetInstIdx = 0;
            else if (track.targetInstIdx > idx) track.targetInstIdx--;
          }
        }
      }
    }
    return true;
  }

  // Live keyboard preview — round-robins across voices so chords are possible.
  // Returns the voice index so the UI can release it on key-up.
  previewNote(instIndex: number, note: number, vol = 0.9): number {
    const ch = this._preview;
    this._preview = (this._preview + 1) % VOICES;
    const frame = this.lastBlockStart + BLOCK; // next block
    this.triggerNote(ch, note, instIndex, vol, frame);
    return ch;
  }
  previewOff(ch: number) {
    if (ch != null) this.voices[ch].offFrame = this.lastBlockStart + BLOCK;
  }

  // --- per-block update ---------------------------------------------------

  resolveSongRow(songRow: number) {
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
  advance(blockStart: number): VoiceData {
    this.lastBlockStart = blockStart;

    if (this.playing && this.song) {
      const blockEnd = blockStart + BLOCK;
      // (Re)anchor the row clock to the start of this block on a fresh play/resume.
      // We track the NEXT row's absolute frame and step it forward row-by-row by the
      // CURRENT samplesPerRow. A BPM change applied by one row therefore only widens/
      // narrows the gap to the FOLLOWING row — it never retroactively rescales the
      // elapsed timeline (which is what made the playhead skip when BPM automation
      // fired against a fixed row-0 anchor).
      if (this._nextRowFrame === null) { this._nextRowFrame = blockStart; this.startFrame = blockStart; }

      const total = this.totalRows;
      let ended = false;
      while (this._nextRowFrame < blockEnd) {
        if (this.playMode === 'song' && this._rowCursor >= total) { ended = true; break; }
        this._triggerRow(this._rowCursor, Math.round(this._nextRowFrame));
        this._nextRowFrame += this.samplesPerRow;   // uses the bpm in effect AFTER this row's automation
        this._rowCursor++;
      }

      if (ended) {
        this.stop();
      } else {
        // Row shown in the UI = the last one fired (covers the end of this block).
        const cur = this._rowCursor - 1;
        if (cur >= 0) {
          if (this.playMode === 'pattern') {
            const pat = this.song!.patterns[this.currentPatternIdx];
            if (pat) {
              const totalPat = pat.rows;
              this.displayOrder = 0;
              this.displayRow = ((cur % totalPat) + totalPat) % totalPat;
            }
          } else if (total > 0) {
            const songRow = ((cur % total) + total) % total;
            const { orderIdx, localRow } = this.resolveSongRow(songRow);
            this.displayOrder = orderIdx;
            this.displayRow = localRow;
          }
        }
      }
    }

    this._refreshVoiceData(blockStart);
    this._modulateVoices(blockStart);

    // Refresh each active DX7 voice's operator config from ITS instrument, packed
    // into the per-voice vec4 arrays. Refreshing every block (not just at trigger)
    // keeps knob edits live; per-voice means two DX7 instances can differ.
    const { A, B, C, D } = this.vd.dx7Ops;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      if (!vc.active) continue;
      const instr = this.instruments[vc.instrument];
      if (!instr || instr.type !== 'dx7' || !instr.ops) continue;
      for (let i = 0; i < 6; i++) {
        const op = instr.ops[i];
        const o = (v * 6 + i) * 4;
        A[o] = op.coarse; A[o + 1] = op.fine; A[o + 2] = op.level; A[o + 3] = op.detune;
        B[o] = op.mode ?? 0; B[o + 1] = op.sustain ?? 0.7; B[o + 2] = op.release ?? 0.25; B[o + 3] = op.decay ?? 0.5;
        
        // 4-stage envelope: fallback to legacy ADSR parameters if r1 is missing
        C[o] = op.r1 ?? 0.002;
        C[o + 1] = op.r2 ?? (op.decay ?? 0.5);
        C[o + 2] = op.r3 ?? 0.0;
        C[o + 3] = op.r4 ?? (op.release ?? 0.25);
        
        D[o] = op.l1 ?? 1.0;
        D[o + 1] = op.l2 ?? (op.sustain ?? 0.7);
        D[o + 2] = op.l3 ?? (op.sustain ?? 0.7);
        D[o + 3] = op.l4 ?? 0.0;
      }
    }
    return this.vd;
  }

  _triggerRow(k: number, frame: number) {
    const fr = Math.round(frame);
    const song = this.song;
    if (!song) return;
    if (this.playMode === 'pattern') {
      const pat = song.patterns[this.currentPatternIdx];
      if (!pat) return;
      const row = ((k % pat.rows) + pat.rows) % pat.rows;
      this._triggerCells(pat, row, fr);
      this._applyAutomation(pat, row);
    } else {
      const total = this.totalRows;
      if (total <= 0) return;
      const songRow = ((k % total) + total) % total;
      const { patIdx, localRow } = this.resolveSongRow(songRow);
      const pat = song.patterns[patIdx];
      if (!pat) return;
      this._triggerCells(pat, localRow, fr);
      this._applyAutomation(pat, localRow);
    }
  }

  // Trigger every non-empty cell of a pattern row: a real note, an effect command,
  // or both. Cells that are entirely empty (no note AND no effect) are skipped.
  _triggerCells(pat: Pattern, row: number, fr: number) {
    for (let ch = 0; ch < pat.channels; ch++) {
      const i = pat.idx(row, ch);
      const note = pat.notes[i];
      const cmd = pat.fxCmd[i];
      if (note === EMPTY && cmd < 0) continue;
      this._applyCell(ch, note, pat.inst[i], pat.vol[i], cmd, pat.fxVal[i], fr);
    }
  }

  // Resolve one cell into voice actions. A note retriggers the voice (and latches
  // the cell's effect); an effect on a cell WITHOUT a note continues/changes the
  // running effect on that channel's voice. Tone portamento (3) with a note is the
  // exception: it slides the existing voice to the new pitch WITHOUT re-attacking.
  _applyCell(ch: number, note: number, inst: number, vol: number, cmd: number, val: number, frame: number) {
    const v = this.voices[ch];
    const hasNote = note !== EMPTY;

    if (cmd === 3 && hasNote && note !== OFF && v.active) {
      v.targetFreq = noteToFreq(note);          // meend: glide to the note, no re-attack
      v.fxCmd = 3; v.fxVal = val; v.fxStart = frame;
      return;
    }
    if (hasNote) {
      this.triggerNote(ch, note, inst, vol, frame);   // resets fxCmd to -1
      if (note !== OFF) {
        v.fxCmd = cmd; v.fxVal = val; v.fxStart = frame; v.targetFreq = v.freq;
      }
      return;
    }
    // Effect-only cell: update the continuing effect on the live voice.
    if (cmd >= 0 && v.active) {
      if (cmd !== v.fxCmd) v.fxStart = frame;   // re-anchor timing when the effect changes
      v.fxCmd = cmd; v.fxVal = val;
    }
  }

  // Apply this row's automation commands. Runs AFTER note triggers so a command
  // sharing a cell with a note overrides the note-on param snapshot. 'inst'
  // targets write the live per-voice slot (channel-local, holds until the next
  // note re-snapshots); 'fx' targets write the engine-type's shared fxParams.
  _applyAutomation(pat: Pattern, row: number) {
    for (const track of pat.autoTracks) {
      const val255 = track.data[row];
      if (val255 < 0) continue;
      const t = targetById(track.targetParamId);
      if (!t) continue;
      const value = denorm(t, val255);
      
      if (t.scope === 'global') {
        if (t.code === 'BPM') this.bpm = value;
        else if (t.code === 'VOL') this.vd.master = value;
      } else if (t.scope === 'chan' && track.targetInstIdx !== null) {
        // chan-scope tracks have no engine; targetInstIdx is reused as the channel
        // index the command pans (channel index == voice index). Cleared on play/stop.
        this.panAuto[track.targetInstIdx] = value;
      } else if (track.targetInstIdx !== null) {
        const instr = this.instruments[track.targetInstIdx];
        if (!instr) continue;
        if (t.scope === 'inst') {
          // inst-scope automation targets an instrument *instance*. Push the value
          // into every live voice playing it (so a held note hears it mid-note), and
          // record it in autoLive so the next note of that instance snapshots it too
          // (_writeParams merges these). NEVER write instr.p0/p1 — those are the
          // pristine base params; mutating them would persist past stop().
          this.autoLive.inst.set(`${track.targetInstIdx}:${t.bank}:${t.index}`, value);
          for (let v = 0; v < VOICES; v++) {
            if (this.voices[v].active && this.voices[v].instrument === track.targetInstIdx) {
              const vdArr = t.bank === 'p1' ? this.vd.p1 : this.vd.p0;
              vdArr[v * 4 + t.index!] = value;
            }
          }
        } else if (t.scope === 'fx') {
          // fx-scope automation targets THIS instance's own effect chain.
          if (instr.fx) instr.fx[t.key!] = value;
        }
      }
    }
  }

  applyAutomationLive(target: any, instIdx: number, ch: number, val255: number) {
    const value = denorm(target, val255);
    if (target.scope === 'global') {
      if (target.code === 'BPM') this.bpm = value;
      else if (target.code === 'VOL') this.vd.master = value;
    } else if (target.scope === 'inst') {
      const arr = target.bank === 'p1' ? this.vd.p1 : this.vd.p0;
      arr[ch * 4 + target.index!] = value;
      this.autoLive.inst.set(`${instIdx}:${target.bank}:${target.index}`, value);
    } else if (target.scope === 'chan') {
      this.panAuto[ch] = value;
    } else {
      // fx scope → this instance's own chain.
      const instr = this.instruments[instIdx];
      if (instr?.fx) instr.fx[target.key!] = value;
    }
  }

  _refreshVoiceData(blockStart: number) {
    const vd = this.vd;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      // Reclaim voices whose release tail has long finished.
      if (vc.active && vc.offFrame !== HELD && (blockStart - vc.offFrame) / this.sampleRate > 2.5) {
        vc.active = false;
      }
      vd.active[v] = vc.active ? 1 : 0;
      vd.inst[v] = vc.inst;
      vd.instId[v] = vc.instrument;   // which instrument-instance → which fx chain
      vd.freq[v] = vc.freq;
      vd.vel[v] = vc.vel;
      vd.onRel[v] = vc.onFrame - blockStart;
      vd.offRel[v] = vc.offFrame === HELD ? HELD : vc.offFrame - blockStart;
      vd.gain[v] = this.muted[v] ? 0.0 : 1.0;
      // Live pan = automation override if set this run, else the channel base.
      vd.pan[v] = Number.isNaN(this.panAuto[v]) ? this.channelPan[v] : this.panAuto[v];
    }
  }

  // Apply per-cell effect-column modulation to the GPU-facing freq/vel, once per
  // block (~93 Hz update rate). Pitch slides/tone-porta permanently move vc.freq;
  // vibrato/arpeggio are transient multipliers on top of it; volume slide ramps
  // vc.vel. Block-rate is finer than a classic tick and keeps freq constant within
  // a block, so the recursive strip renderer + phase carry stay smooth on the
  // phase-accumulating engines (303, moog). See src/tracker/fx.ts for the codes.
  _modulateVoices(blockStart: number) {
    const vd = this.vd;
    const dt = BLOCK / this.sampleRate;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      if (!vc.active || vc.fxCmd < 0) continue;
      const t = (blockStart - vc.fxStart) / this.sampleRate;   // seconds since effect start
      const xx = vc.fxVal & 0xff, x = (vc.fxVal >> 4) & 0xf, y = vc.fxVal & 0xf;
      let pitchMult = 1;
      switch (vc.fxCmd) {
        case 0x1: vc.freq *= Math.pow(2, (xx * FX_SLIDE * dt) / 12); break;   // slide up
        case 0x2: vc.freq *= Math.pow(2, -(xx * FX_SLIDE * dt) / 12); break;  // slide down
        case 0x3: {                                                           // tone porta (meend)
          const cents = Math.log2(vc.targetFreq / Math.max(vc.freq, 1e-6)) * 12;
          const stepC = xx * FX_PORTA * dt;
          if (Math.abs(cents) <= stepC) vc.freq = vc.targetFreq;
          else vc.freq *= Math.pow(2, (Math.sign(cents) * stepC) / 12);
          break;
        }
        case 0x0: {                                                           // arpeggio
          const steps = [0, x, y];
          pitchMult = Math.pow(2, steps[Math.floor(t / FX_ARP_SEC) % 3] / 12);
          break;
        }
        case 0x4:                                                            // vibrato
          pitchMult = Math.pow(2, (y * FX_VIB_DEPTH * Math.sin(2 * Math.PI * (x * FX_VIB_HZ) * t)) / 12);
          break;
        case 0xA:                                                            // volume slide
          vc.vel = Math.max(0, Math.min(1, vc.vel + (x - y) * FX_VOLSLIDE * dt));
          break;
      }
      vd.freq[v] = vc.freq * pitchMult;
      vd.vel[v] = vc.vel;
    }
  }
}
