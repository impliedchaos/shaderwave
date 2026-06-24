// Tracker engine: turns the BPM clock + pattern grid into per-block voice data
// for the GPU renderer. It is sample-accurate — note-ons are scheduled at exact
// frames within a render block, not quantised to block boundaries.
//
// Mapping: tracker channel index == voice index (8 channels → 8 voices, mono per
// channel). When a new note hits a channel, it overwrites that voice.
import { VOICES, INSTRUMENTS, INSTRUMENT_COLORS, noteToFreq, BLOCK, DEFAULT_MASTER } from '../constants.js';
import { EMPTY, OFF } from './pattern.js';
import { FX_NOTE_DELAY } from './fx.js';
import type { Pattern } from './pattern.js';
import { defaultParams, instrumentsFromParams, DRUM_MAP } from './song.js';
import { neutralFxParams } from '../gl/effects.js';
import { targetById, denorm, normUnit, denormUnit } from './automation.js';
import { defaultLfos, lfoOffset, lfoPeriodSec, LFO_COUNT } from './lfo.js';
import { modEnvValue } from './instmod.js';
import { byType } from '../instruments/index.js';
import type {
  FxParamsByType, InstrumentInstance, InstrumentType, LfoConfig, ModEnv, ModRoute, ModRouting, ModSource, SongData, VoiceData,
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
  // Effect-column pitch continuity for CLOSED-FORM engines (pipi/guitar/tanpura/
  // tabla/e8e/sampler): those compute phase as a function of absolute note-on time,
  // so a mid-note frequency change (slide/porta/vibrato/arp) would jump the phase.
  // We accumulate a per-block correction in fundamental cycles so phase stays
  // continuous; it stays exactly 0 (→ bit-identical render) until pitch is modulated.
  phaseOff: number;      // accumulated fundamental-phase offset, cycles
  freqPrev: number;      // effective freq used last block (to derive the per-block delta)
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
  // While a parameter is being live-recorded (a knob is grabbed / MIDI CC is
  // streaming), its existing automation track is suppressed in _applyAutomation
  // so the live input wins instead of fighting the stored data. The UI loop also
  // erases the stale rows the playhead sweeps over. Matched by (paramId,instIdx).
  _armedTrack: { paramId: number; targetInstIdx: number | null } | null = null;
  playing: boolean;
  paused: boolean;
  _resumeOffset: number;
  startFrame: number | null;
  _rowCursor: number;            // next row index to fire (running; song-global or pattern-local)
  _nextRowFrame: number | null;  // absolute frame that row fires at; null → (re)anchor at next block
  // Deferred note triggers from the note-delay effect (FX_NOTE_DELAY): a note pushed
  // later within its step fires at an absolute frame, possibly in a later block. Fired
  // in frame order from advance(); cleared on play/stop/pause.
  _pending: { frame: number; ch: number; note: number; inst: number; vol: number }[];
  lastBlockStart: number;
  // Fired at the end of a FRESH play() (not resume) so the host can rebase the
  // absolute frame clock to ~0. uBlockStart (= pipeline.writtenFrames) otherwise
  // grows monotonically while audio runs and loses float32 precision over time.
  onPlay: (() => void) | null;
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
  lfos: LfoConfig[];             // song-wide LFO sources (waveform generators)
  modRoutings: ModRouting[];     // modulation matrix: source→target assignments
  _songBeats = 0;                // beats elapsed since play(); integrates BPM so synced-LFO phase stays continuous across tempo changes
  // Snapshot of fx-param values an LFO is transiently overriding, keyed
  // `${instIdx}:${key}`. fx params are read by reference + persist, so the LFO
  // must restore them on play/stop (inst/chan/global overrides self-heal via
  // autoLive/panAuto/vd.master, but fx does not).
  _lfoFxBase: Map<string, number>;
  // What an fx-scope LFO last WROTE to each fx field. Lets us notice when the user
  // (or a preset/automation) edits that field live — if it no longer matches what we
  // wrote, we re-baseline `_lfoFxBase` to the new value so the LFO re-centres on it
  // (otherwise the frozen play-start snapshot clobbers live volume/cutoff edits).
  _lfoFxLast: Map<string, number>;
  // Same base/last-write tracking for the PER-INSTRUMENT mod matrix's fx-scope
  // routes (keyed `${instIdx}:${key}`). Kept SEPARATE from the global-LFO maps so
  // the two systems don't corrupt each other's bookkeeping; restored on play/stop
  // alongside them. (Routing both a global LFO and an instance route at the same
  // instance+fx field is unsupported — they'd fight; last writer per block wins.)
  _instModFxBase: Map<string, number>;
  _instModFxLast: Map<string, number>;
  // Per-instrument mod-SOURCE runtime (transient, reset per run). `_instModPhase`
  // keyed `${instIdx}:${slot}` accumulates an LFO's phase across blocks — used ONLY
  // when that source's rate is being modulated (a modsrc route targets it), so an
  // unmodulated source keeps its closed-form phase and stays bit-identical.
  // `_instModLastVal` holds each source's output value from the PREVIOUS block, so
  // a source→source link (LFO1→LFO2, env→LFO amount, …) reads a stable input and
  // the whole graph stays acyclic (one block ≈ 11 ms latency, inaudible).
  _instModPhase: Map<string, number>;
  _instModLastVal: Map<string, number>;
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
    this._pending = [];
    this.lastBlockStart = 0;
    this.onPlay = null;
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
      phaseOff: 0, freqPrev: 440,
    }));

    this.muted = new Array(VOICES).fill(false);

    // Per-channel stereo pan (0 = hard left, 0.5 = centre, 1 = hard right). The
    // header slider writes `channelPan` (the persistent base, saved with the
    // song); `panAuto` holds a live automation override (NaN = follow the base).
    // Both feed vd.pan each block, with the override winning. Like autoLive, the
    // override is transient — cleared on play/stop so the slider value returns.
    this.channelPan = new Float32Array(VOICES).fill(0.5);
    this.panAuto = new Float32Array(VOICES).fill(NaN);

    // Global LFOs (song-wide sources) + the modulation matrix routing them to
    // targets. loadSong replaces both from the song. _lfoFxBase tracks fx params a
    // routing is transiently driving (so they can be restored).
    this.lfos = defaultLfos();
    this.modRoutings = [];
    this._lfoFxBase = new Map();
    this._lfoFxLast = new Map();
    this._instModFxBase = new Map();
    this._instModFxLast = new Map();
    this._instModPhase = new Map();
    this._instModLastVal = new Map();

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
      // Universal bank E — Spectra stereo spread (uploaded for every engine; ignored
      // by those that don't reference uP4 in their shader).
      p4: new Float32Array(VOICES * 4),
      freqFrom: new Float32Array(VOICES),
      phaseOff: new Float32Array(VOICES),
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
      },
      sampler: {
        slot: new Float32Array(VOICES).fill(-1),
        baseRow: new Float32Array(VOICES),
        loopStart: new Float32Array(VOICES),
        loopEnd: new Float32Array(VOICES),
        len: new Float32Array(VOICES),
        rootFreq: new Float32Array(VOICES),
        loopMode: new Float32Array(VOICES),
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
    // Global LFO sources + matrix saved with the song. Restore any fx the old
    // song's routings were driving before swapping (so we don't leak overrides).
    this._restoreLfoFx();
    // Always expose exactly LFO_COUNT sources: pad a song that defines fewer (older
    // songs / demos predating LFO 2 & 3) with the defaults — so LFO 2 and the
    // dedicated pump (LFO 3) appear even for songs that never set them.
    const lfos = defaultLfos();
    if (song.lfos) for (let i = 0; i < LFO_COUNT; i++) if (song.lfos[i]) lfos[i] = song.lfos[i];
    this.lfos = lfos;
    this.modRoutings = song.modRoutings ?? [];
  }

  // Restore every fx param an LFO transiently overrode back to its snapshot base,
  // then clear the snapshots. Called on play()/stop()/loadSong so fx-scope LFO
  // overrides never persist past a run (inst/chan/global self-heal elsewhere).
  _restoreLfoFx() {
    const restore = (baseMap: Map<string, number>, lastMap: Map<string, number>) => {
      for (const [key, base] of baseMap) {
        const [idxStr, fxKey] = key.split(/:(.+)/);
        const instr = this.instruments[+idxStr];
        if (instr?.fx) instr.fx[fxKey] = base;
      }
      baseMap.clear();
      lastMap.clear();
    };
    if (this._lfoFxBase.size) restore(this._lfoFxBase, this._lfoFxLast);
    if (this._instModFxBase.size) restore(this._instModFxBase, this._instModFxLast);
    // Drop the mod-source runtime too (phase + last-block values) — same lifetime as
    // the fx overrides: a fresh run / song swap starts the source graph clean.
    this._instModPhase.clear();
    this._instModLastVal.clear();
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
    this._pending.length = 0;            // drop any deferred note-delay triggers
    this.autoLive.inst.clear();
    this._armedTrack = null;             // drop any live-record arm
    this.panAuto.fill(NaN);
    this.vd.master = this.songMaster;   // drop any VOL automation override
    this._restoreLfoFx();               // fresh run → drop any prior fx-LFO override
    this._songBeats = 0;                // restart the LFO beat clock
    this.onPlay?.();                    // host rebases the absolute frame clock to ~0
  }
  // Pause: hold the current song position (so resume() continues from here) and
  // silence the voices. The transport clock keeps running while paused; the
  // elapsed offset is re-anchored against the live block in advance() on resume.
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.paused = true;
    this._nextRowFrame = null;   // resume re-anchors the row clock; _rowCursor holds the position
    this._pending.length = 0;    // pending frames are stale once the clock re-anchors on resume
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
    this._pending.length = 0;
    for (const v of this.voices) v.active = false;
    this._armedTrack = null;    // drop any live-record arm
    this.panAuto.fill(NaN);     // drop pan automation overrides; slider base returns
    this.autoLive.inst.clear(); // drop inst automation overrides; base params return
    this.vd.master = this.songMaster; // drop VOL automation override; song base returns
    this._restoreLfoFx();       // restore any fx params the LFOs were driving
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
    v.phaseOff = 0;                                    // fresh note: phase starts from note-on, no correction yet
    if (byType(instr.type)?.drum) {
      v.freq = 220; // unused by drum engines, but keep sane
      v.freqPrev = v.freq;
      this._writeParams(ch, instr, idx, DRUM_MAP[note] ?? 0);
    } else {
      v.freq = noteToFreq(note);
      v.freqPrev = v.freq;
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
    if (instr.p4) for (let k = 0; k < 4; k++) this.vd.p4[o + k] = instr.p4[k];
    if (this.autoLive.inst.size) {
      // Merge inst-scope automation overrides across every universal bank (p0..p4).
      const banks: [string, Float32Array][] = [
        ['p0', this.vd.p0], ['p1', this.vd.p1], ['p2', this.vd.p2], ['p3', this.vd.p3], ['p4', this.vd.p4],
      ];
      for (const [bank, vdArr] of banks) {
        for (let k = 0; k < 4; k++) {
          const a = this.autoLive.inst.get(`${instrIdx}:${bank}:${k}`);
          if (a !== undefined) vdArr[o + k] = a;
        }
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
    const fxDef = byType(type)?.fxDefaults;
    const fx = fxDef ? Object.assign(neutralFxParams(), fxDef) : neutralFxParams();
    const e: InstrumentInstance = { name: byType(type)?.name ?? type.toUpperCase(), type, color, p0: [...dp.p0], p1: [...dp.p1], fx };
    if (dp.ops) e.ops = dp.ops.map((o) => ({ ...o }));
    // defaultParams() already deep-clones the engine's extra banks (p2/p3/p4) when
    // its descriptor declares them, so just carry whatever it produced.
    if (dp.p2) e.p2 = [...dp.p2];
    if (dp.p3) e.p3 = [...dp.p3];
    if (dp.p4) e.p4 = [...dp.p4];
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
        this._firePendingUpTo(this._nextRowFrame);  // deferred note-delay triggers landing before this row
        this._triggerRow(this._rowCursor, Math.round(this._nextRowFrame));
        this._nextRowFrame += this.samplesPerRow;   // uses the bpm in effect AFTER this row's automation
        this._rowCursor++;
      }
      if (!ended) this._firePendingUpTo(blockEnd);   // remaining deferred triggers in this block

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
    this._applyInstMod(blockStart);     // per-instrument matrix (incl. pitch) BEFORE phaseOff
    this._accumPhaseOff(blockStart);    // so closed-form engines stay click-free on vibrato
    this._applyLfos(blockStart);

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

  // Fire deferred note-delay triggers whose frame is < limit, in frame order. Each is
  // a plain note trigger at its (sample-accurate) frame; the voice keeps playing its
  // previous note until then, so a delayed note slots cleanly into the gap.
  _firePendingUpTo(limit: number) {
    if (this._pending.length === 0) return;
    this._pending.sort((a, b) => a.frame - b.frame);
    while (this._pending.length && this._pending[0].frame < limit) {
      const p = this._pending.shift()!;
      this.triggerNote(p.ch, p.note, p.inst, p.vol, Math.round(p.frame));
    }
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
    // Note-trigger delay (for swing / humanized "drunken" timing): push this note's
    // attack later WITHIN its own step by val/255 of one row — 0x00 none, 0x80 half a
    // row, 0xFF ≈ a full row. The voice keeps playing its previous note until the
    // deferred trigger fires (which may be a later render block), so it slots into the gap.
    if (cmd === FX_NOTE_DELAY && hasNote && note !== OFF) {
      const frac = (val & 0xff) / 255;
      if (frac > 0) {
        const row = this.samplesPerRow;
        // Cap a hair under one row so 0xFF stays before the next step's trigger.
        const delay = Math.min(Math.round(frac * row), Math.max(0, Math.round(row) - 1));
        this._pending.push({ frame: frame + delay, ch, note, inst, vol });
      } else {
        this.triggerNote(ch, note, inst, vol, frame);   // 0x00 = trigger immediately
      }
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
      // Suppress the track currently being live-recorded so its stale stored
      // data doesn't fight the knob/CC the user is actively moving.
      if (this._armedTrack && track.targetParamId === this._armedTrack.paramId
          && track.targetInstIdx === this._armedTrack.targetInstIdx) continue;
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
          const vdArr = t.bank === 'p1' ? this.vd.p1 : t.bank === 'p2' ? this.vd.p2 : t.bank === 'p3' ? this.vd.p3 : t.bank === 'p4' ? this.vd.p4 : this.vd.p0;
          for (let v = 0; v < VOICES; v++) {
            if (this.voices[v].active && this.voices[v].instrument === track.targetInstIdx) {
              vdArr[v * 4 + t.index!] = value;
            }
          }
        } else if (t.scope === 'fx') {
          // fx-scope automation targets THIS instance's own effect chain. Toggle
          // targets (effect on/off) write a real boolean (0 = off, else on).
          if (instr.fx) instr.fx[t.key!] = t.toggle ? (value > 0) : value;
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
      const arr = target.bank === 'p1' ? this.vd.p1 : target.bank === 'p2' ? this.vd.p2 : target.bank === 'p3' ? this.vd.p3 : target.bank === 'p4' ? this.vd.p4 : this.vd.p0;
      arr[ch * 4 + target.index!] = value;
      this.autoLive.inst.set(`${instIdx}:${target.bank}:${target.index}`, value);
    } else if (target.scope === 'chan') {
      this.panAuto[ch] = value;
    } else {
      // fx scope → this instance's own chain (toggle → boolean).
      const instr = this.instruments[instIdx];
      if (instr?.fx) instr.fx[target.key!] = target.toggle ? (value > 0) : value;
    }
  }

  // Push a base-param edit (from a sidebar knob) into any currently-sounding voices
  // of an instance, so the change is heard immediately rather than only at the next
  // note-on. The caller updates the pristine base (instr.pN); this writes the
  // GPU-facing per-voice bank, mirroring how inst-automation/LFO update live voices.
  // Any LFO/automation targeting the same param will keep modulating around the new
  // base on subsequent blocks.
  updateInstrumentParam(instrIdx: number, bank: 'p0' | 'p1' | 'p2' | 'p3' | 'p4', index: number, value: number) {
    const arr = bank === 'p1' ? this.vd.p1 : bank === 'p2' ? this.vd.p2 : bank === 'p3' ? this.vd.p3 : bank === 'p4' ? this.vd.p4 : this.vd.p0;
    for (let v = 0; v < VOICES; v++) {
      if (this.voices[v].active && this.voices[v].instrument === instrIdx) arr[v * 4 + index] = value;
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
  // phase-accumulating engines (303, moog). The closed-form engines stay click-free
  // too, via the fundamental-phase correction in _accumPhaseOff (runs right after this).
  // See src/tracker/fx.ts for the codes.
  _modulateVoices(blockStart: number) {
    const vd = this.vd;
    const dt = BLOCK / this.sampleRate;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      if (!vc.active || vc.fxCmd < 0) continue;
      // Clamp at 0: a note (or effect) can START later within THIS block — a
      // sample-accurate trigger lands fxStart > blockStart for any row not aligned to a
      // 512-frame boundary (i.e. almost all of them; row 0 at frame 0 is the exception).
      // Then seconds-since-start goes negative and arpeggio indexes steps[floor(t/sec)%3]
      // at -1 → undefined → Math.pow(2, NaN) → NaN freq, which poisons freqPrev and the
      // phaseOff accumulator for the rest of the note (a permanent click). No modulation
      // applies before the effect starts anyway, so clamp.
      const t = Math.max(0, (blockStart - vc.fxStart) / this.sampleRate);   // seconds since effect start
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

  // Maintain the fundamental-phase correction that lets the CLOSED-FORM engines
  // (pipi/guitar/tanpura/tabla/e8e/sampler) follow an effect-column pitch change
  // without a click. Those shaders compute phase as `f·t` from absolute note-on
  // time, so when the per-block effective freq f changes, the analytic phase jumps
  // by (f_new − f_old)·t at the seam. We accumulate the opposite shift in fundamental
  // cycles — off += (f_prev − f_now)·t — and pass it as uPhaseOff; the shader adds
  // it back (te = t + off/f) so the phase is continuous across the change. While a
  // voice's freq is steady (no slide/porta/vibrato/arp) the delta is 0, so off stays
  // exactly 0 and those engines render bit-identically to before. Runs AFTER
  // _modulateVoices so vd.freq is the final per-block frequency.
  _accumPhaseOff(blockStart: number) {
    const vd = this.vd;
    for (let v = 0; v < VOICES; v++) {
      const vc = this.voices[v];
      if (!vc.active) { vd.phaseOff[v] = 0; continue; }
      const tStart = (blockStart - vc.onFrame) / this.sampleRate;   // seconds since note-on, at this block's first sample
      if (tStart > 0) vc.phaseOff += (vc.freqPrev - vd.freq[v]) * tStart;
      vc.freqPrev = vd.freq[v];
      vd.phaseOff[v] = vc.phaseOff;
    }
  }

  // Apply the modulation matrix once per block, AFTER automation and effect-column
  // modulation so the LFOs are the last writers. Each ROUTING adds a transient
  // offset (in normalized space) around its target's CENTER, recomputed every block
  // by reading a STABLE store and writing a DIFFERENT one — so an LFO never re-reads
  // its own output (no drift) and never touches the instrument base. Many routings
  // can share one source (one LFO → many targets). Phase derives from song time →
  // deterministic for export. When automation + a routing hit the same param,
  // inst-scope stacks (center = autoLive); other scopes modulate the base, last
  // routing wins on a collision.
  // The signed offset a single global routing contributes this block, in normalized
  // param space ([-depth,depth] bipolar / [0,depth] unipolar), or NaN if its source
  // is missing. Factored out of _applyLfos so _applyInstMod can reuse it for global
  // routings that target a per-instrument mod source (modsrc) — both read the SAME
  // this._songBeats (advanced once, at the end of _applyLfos), so there's no double
  // advance and global→source→destination all resolve within one block.
  _globalRoutingOffset(r: ModRouting, songSec: number): number {
    const src = this.lfos[r.source];
    if (!src) return NaN;
    const cyclePos = src.sync
      ? this._songBeats / Math.max(1e-3, src.rateBeats)
      : songSec / lfoPeriodSec(src, this.bpm);
    const cycle = Math.floor(cyclePos);
    const rawOffset = lfoOffset(src, r.depth, r.bipolar, cyclePos - cycle, cycle);
    return r.invert ? -rawOffset : rawOffset;   // invert → one source drives two targets opposite ways
  }

  _applyLfos(blockStart: number) {
    if (!this.playing) return;
    const start = this.startFrame ?? blockStart;
    const songSec = (blockStart - start) / this.sampleRate;
    for (const r of this.modRoutings) {
      if (!r || r.targetParamId < 0 || r.depth <= 0) continue;
      const t = targetById(r.targetParamId);
      if (!t) continue;
      if (t.scope === 'modsrc') continue;   // mod-source knobs are resolved in _applyInstMod (runs earlier this block)
      const offset = this._globalRoutingOffset(r, songSec);
      if (!Number.isFinite(offset)) continue;

      if (t.scope === 'global') {
        if (t.code === 'BPM') continue;            // excluded → keeps export length exact
        if (t.code === 'VOL') this.vd.master = denormUnit(t, normUnit(t, this.songMaster) + offset);
      } else if (t.scope === 'chan' && r.targetInstIdx !== null) {
        const ch = r.targetInstIdx;                // center = channel base (not the pan-auto override)
        this.panAuto[ch] = denormUnit(t, normUnit(t, this.channelPan[ch]) + offset);
      } else if (r.targetInstIdx !== null) {
        const instr = this.instruments[r.targetInstIdx];
        if (!instr) continue;
        if (t.scope === 'inst' && t.bank && t.index != null) {
          const key = `${r.targetInstIdx}:${t.bank}:${t.index}`;
          const auto = this.autoLive.inst.get(key);   // stacks with automation if present
          const baseArr = t.bank === 'p1' ? instr.p1 : t.bank === 'p2' ? instr.p2 : t.bank === 'p3' ? instr.p3 : t.bank === 'p4' ? instr.p4 : instr.p0;
          const base = auto !== undefined ? auto : (baseArr ? baseArr[t.index] : 0);
          const value = denormUnit(t, normUnit(t, base) + offset);
          const vdArr = t.bank === 'p1' ? this.vd.p1 : t.bank === 'p2' ? this.vd.p2 : t.bank === 'p3' ? this.vd.p3 : t.bank === 'p4' ? this.vd.p4 : this.vd.p0;
          for (let v = 0; v < VOICES; v++) {
            if (this.voices[v].active && this.voices[v].instrument === r.targetInstIdx) {
              vdArr[v * 4 + t.index] = value;
            }
          }
        } else if (t.scope === 'fx' && t.key && instr.fx) {
          const sk = `${r.targetInstIdx}:${t.key}`;
          // The LFO writes back into instr.fx[key], so it can't read it as the centre
          // (it'd modulate its own output and drift) — hence a stored base. But that
          // base must track LIVE edits: if the field no longer equals what we last
          // wrote, the user/preset/automation changed it → re-baseline to the new
          // value. (Without this, a frozen play-start snapshot clobbers a volume/
          // cutoff knob dragged during playback, so the LFO stays centred on the old
          // value — see the FX-Level-while-playing bug.)
          const last = this._lfoFxLast.get(sk);
          let base = this._lfoFxBase.get(sk);
          if (base === undefined || last === undefined || (instr.fx[t.key] as number) !== last) {
            base = instr.fx[t.key] as number;
            this._lfoFxBase.set(sk, base);
          }
          const nv = denormUnit(t, normUnit(t, base) + offset);
          const out = t.toggle ? (nv > 0.5) : nv;          // toggle → boolean (rhythmic gating)
          instr.fx[t.key] = out;
          this._lfoFxLast.set(sk, out as number);
        }
      }
    }
    // Advance the beat clock once per block, using the post-automation bpm — so synced
    // LFOs accrue phase smoothly through tempo changes. Deterministic for export.
    this._songBeats += (BLOCK / this.sampleRate) * (this.bpm / 60);
  }

  // Resolved per-block state for one mod-source slot: the EFFECTIVE config after any
  // modsrc routes have modulated it, plus the shared free-running LFO's phase.
  // _modSourceOffset reads this instead of the raw source so source→source mod lands.

  // The signed offset a source CONTRIBUTES when it drives ANOTHER source (a modsrc
  // route), from its raw output value (`rawVal`: an LFO wave in [-1,1] / pump [-1,0],
  // or an env level in [0,1]). Mirrors lfoOffset/_modSourceOffset polarity, then folds
  // in the SOURCE's own amount so its master level scales how hard it modulates.
  _routeContribution(kind: ModSource['kind'], rawVal: number, depth: number, bipolar: boolean, invert: boolean, amount: number): number {
    let off: number;
    if (kind === 'env') off = bipolar ? depth * (2 * rawVal - 1) : depth * rawVal;
    else { let v = rawVal; if (!bipolar) v = v * 0.5 + 0.5; off = v * depth; }
    off *= amount;
    return invert ? -off : off;
  }

  // The normalized offset one mod ROUTE contributes for a given voice, reading a
  // RESOLVED slot (effective cfg/env/phase). v = -1 for the shared free-run value
  // (non-retriggered LFOs). Envelopes + retriggered LFOs derive phase from the
  // voice's own note-on/off frames; free-running LFOs use the resolved shared phase
  // (which already integrates any rate modulation). Like lfoOffset, depth/bipolar/
  // invert are applied here; the per-source AMOUNT is applied by the caller.
  _modSourceOffset(slot: SlotResolved, r: ModRoute, v: number, blockStart: number): number {
    if (slot.kind === 'env') {
      if (v < 0) return 0;                       // env at rest (no voice) → no contribution
      const vc = this.voices[v];
      const t = (blockStart - vc.onFrame) / this.sampleRate;
      const tRel = vc.offFrame === HELD ? -1 : (blockStart - vc.offFrame) / this.sampleRate;
      const e = modEnvValue(slot.env, t, tRel);
      const off = r.bipolar ? r.depth * (2 * e - 1) : r.depth * e;
      return r.invert ? -off : off;
    }
    let phase01 = slot.phase01, cycle = slot.cycle;
    if (slot.retrigger) {
      if (v < 0) return 0;                       // retriggered LFO needs a voice for its phase
      const sec = Math.max(0, (blockStart - this.voices[v].onFrame) / this.sampleRate);
      const beats = sec * (this.bpm / 60);
      const cfg = slot.cfg;
      const cyclePos = (cfg.sync ? beats / Math.max(1e-3, cfg.rateBeats) : sec / lfoPeriodSec(cfg, this.bpm)) * slot.rateMul;
      cycle = Math.floor(cyclePos); phase01 = cyclePos - cycle;
    }
    const off = lfoOffset(slot.cfg, r.depth, r.bipolar, phase01, cycle);
    return r.invert ? -off : off;
  }

  // Apply each instrument INSTANCE's own modulation matrix, once per block, in the
  // same transient-offset-above-centre spirit as _applyLfos but scoped to the
  // instance that owns the matrix. Two phases:
  //   A — RESOLVE each source's effective params: a modsrc route (or a global LFO
  //       routing pointed at this instance) can modulate another source's Rate /
  //       WtPos / Amount / Env-ADSR. Source→source links read the modulator's value
  //       from the PREVIOUS block (_instModLastVal) so the graph is acyclic (mutual
  //       LFO1↔LFO2 just gets one block of latency). A modulated LFO Rate switches
  //       that slot to accumulated phase (_instModPhase, seeded continuously) so the
  //       rate change doesn't make the phase jump; an unmodulated slot keeps the
  //       closed-form phase and stays bit-identical.
  //   B — APPLY destination routes (pitch / inst / fx), as before, scaled by the
  //       resolved source AMOUNT:
  //         pitch → multiplies vd.freq for each active voice (vibrato); runs BEFORE
  //                 _accumPhaseOff so closed-form engines stay click-free.
  //         inst  → writes the param bank per active voice (centre = autoLive/base).
  //         fx    → writes the shared instance fx field (representative source value).
  // A matrix with no routes does nothing → instances render bit-identically.
  _applyInstMod(blockStart: number) {
    if (!this.playing) return;
    const RATE_OCT = 4;                 // ±octaves a full-depth Rate route shifts an LFO
    const start = this.startFrame ?? blockStart;
    const songSec = (blockStart - start) / this.sampleRate;
    const songBeats = this._songBeats;
    const dt = BLOCK / this.sampleRate;
    const dBeats = dt * (this.bpm / 60);
    const clamp = (x: number, lo: number, hi: number) => x < lo ? lo : x > hi ? hi : x;
    const vd = this.vd;
    for (let ii = 0; ii < this.instruments.length; ii++) {
      const instr = this.instruments[ii];
      const mod = instr.mod;
      if (!mod || !mod.routes.length) continue;
      const sources = mod.sources;
      const nSlots = sources.length;
      // The newest active voice of this instance — the representative for shared
      // (fx) targets + per-voice sources used as a modulator (env / retriggered LFO).
      let newestV = -1, newestOn = -Infinity;
      for (let v = 0; v < VOICES; v++) {
        const vc = this.voices[v];
        if (vc.active && vc.instrument === ii && vc.onFrame > newestOn) { newestOn = vc.onFrame; newestV = v; }
      }

      // ── Phase A.1: gather modsrc contributions into per-slot accumulators ──
      const octAdd = new Array(nSlots).fill(0);
      const wtAdd = new Array(nSlots).fill(0);
      const amtAdd = new Array(nSlots).fill(0);
      const envAdd = sources.map(() => ({ a: 0, d: 0, s: 0, r: 0 }));
      const rateRouted = new Array(nSlots).fill(false);
      const addModsrc = (slot: number, field: string, c: number) => {
        switch (field) {
          case 'rate':   octAdd[slot] += c * RATE_OCT; rateRouted[slot] = true; break;
          case 'wtpos':  wtAdd[slot] += c; break;            // span 1
          case 'amount': amtAdd[slot] += c * 2; break;       // span 2
          case 'a':      envAdd[slot].a += c * 2; break;     // span ~2
          case 'd':      envAdd[slot].d += c * 2; break;
          case 's':      envAdd[slot].s += c; break;         // span 1
          case 'r':      envAdd[slot].r += c * 4; break;     // span ~4
        }
      };
      // per-instrument routes whose target is a mod source (self-targeting)
      for (const route of mod.routes) {
        if (route.targetParamId < 0 || route.depth === 0) continue;
        const t = targetById(route.targetParamId);
        if (!t || t.scope !== 'modsrc' || t.modSlot == null || t.modField == null) continue;
        if (t.modSlot === route.source || t.modSlot >= nSlots || route.source >= nSlots) continue;  // no self-targeting
        const ms = sources[route.source];
        const rawVal = this._instModLastVal.get(`${ii}:${route.source}`) ?? 0;
        addModsrc(t.modSlot, t.modField, this._routeContribution(ms.kind, rawVal, route.depth, route.bipolar, !!route.invert, ms.amount ?? 1));
      }
      // global LFO routings pointed at THIS instance's sources
      for (const r of this.modRoutings) {
        if (!r || r.targetParamId < 0 || r.depth <= 0 || r.targetInstIdx !== ii) continue;
        const t = targetById(r.targetParamId);
        if (!t || t.scope !== 'modsrc' || t.modSlot == null || t.modField == null || t.modSlot >= nSlots) continue;
        const off = this._globalRoutingOffset(r, songSec);
        if (Number.isFinite(off)) addModsrc(t.modSlot, t.modField, off);
      }

      // ── Phase A.2: resolve effective slot state + advance/seed shared LFO phase ──
      const resolved: SlotResolved[] = sources.map((s, si) => {
        const amount = clamp((s.amount ?? 1) + amtAdd[si], 0, 2);
        const wtPos = clamp(s.lfo.wtPos + wtAdd[si], 0, 1);
        const cfg: LfoConfig = { ...s.lfo, wtPos };
        const env: ModEnv = {
          a: clamp(s.env.a + envAdd[si].a, 0.001, 2),
          d: clamp(s.env.d + envAdd[si].d, 0.001, 2),
          s: clamp(s.env.s + envAdd[si].s, 0, 1),
          r: clamp(s.env.r + envAdd[si].r, 0.001, 4),
        };
        const rateMul = octAdd[si] === 0 ? 1 : Math.pow(2, octAdd[si]);
        const shared = s.kind === 'lfo' && !s.retrigger;
        let phase01 = 0, cycle = 0;
        if (shared) {
          if (rateRouted[si]) {
            // Accumulate phase so a modulated rate stays continuous (no jump). Seed
            // from the closed-form value the first time, so it picks up seamlessly.
            const key = `${ii}:${si}`;
            let phase = this._instModPhase.get(key);
            if (phase === undefined) phase = cfg.sync ? songBeats / Math.max(1e-3, s.lfo.rateBeats) : songSec / lfoPeriodSec(s.lfo, this.bpm);
            cycle = Math.floor(phase); phase01 = phase - cycle;
            const dPhase = cfg.sync ? dBeats * rateMul / Math.max(1e-3, s.lfo.rateBeats) : dt * Math.max(1e-3, s.lfo.rateHz) * rateMul;
            this._instModPhase.set(key, phase + dPhase);
          } else {
            // Unmodulated rate → closed-form (identical to the pre-modsrc engine).
            const cp = cfg.sync ? songBeats / Math.max(1e-3, s.lfo.rateBeats) : songSec / lfoPeriodSec(s.lfo, this.bpm);
            cycle = Math.floor(cp); phase01 = cp - cycle;
          }
        }
        return { kind: s.kind, retrigger: s.retrigger, amount, cfg, env, rateMul, shared, phase01, cycle };
      });

      // Store each source's THIS-block raw output for next block's source→source links.
      resolved.forEach((slot, si) => {
        let rawVal = 0;
        if (slot.kind === 'env') {
          if (newestV >= 0) {
            const vc = this.voices[newestV];
            const tt = (blockStart - vc.onFrame) / this.sampleRate;
            const tRel = vc.offFrame === HELD ? -1 : (blockStart - vc.offFrame) / this.sampleRate;
            rawVal = modEnvValue(slot.env, tt, tRel);
          }
        } else if (slot.shared) {
          rawVal = lfoOffset(slot.cfg, 1, true, slot.phase01, slot.cycle);   // raw wave in [-1,1]
        } else if (newestV >= 0) {                                            // retriggered LFO → newest voice
          const sec = Math.max(0, (blockStart - this.voices[newestV].onFrame) / this.sampleRate);
          const beats = sec * (this.bpm / 60);
          const cp = (slot.cfg.sync ? beats / Math.max(1e-3, slot.cfg.rateBeats) : sec / lfoPeriodSec(slot.cfg, this.bpm)) * slot.rateMul;
          rawVal = lfoOffset(slot.cfg, 1, true, cp - Math.floor(cp), Math.floor(cp));
        }
        this._instModLastVal.set(`${ii}:${si}`, rawVal);
      });

      // ── Phase B: apply destination routes (pitch / inst / fx) ──
      for (const r of mod.routes) {
        if (r.targetParamId < 0 || r.depth === 0 || r.source >= nSlots) continue;
        const t = targetById(r.targetParamId);
        if (!t || t.scope === 'modsrc') continue;        // source→source handled in Phase A
        const slot = resolved[r.source];
        const amount = slot.amount;
        const shared = slot.shared;

        if (t.pitch) {
          for (let v = 0; v < VOICES; v++) {
            const vc = this.voices[v];
            if (!vc.active || vc.instrument !== ii) continue;
            const off = this._modSourceOffset(slot, r, shared ? -1 : v, blockStart) * amount;
            if (off !== 0) vd.freq[v] *= Math.pow(2, off * t.max / 12);   // off·max = semitones
          }
        } else if (t.scope === 'inst' && t.bank && t.index != null) {
          const key = `${ii}:${t.bank}:${t.index}`;
          const auto = this.autoLive.inst.get(key);                       // stacks with automation if present
          const baseArr = t.bank === 'p1' ? instr.p1 : t.bank === 'p2' ? instr.p2 : t.bank === 'p3' ? instr.p3 : t.bank === 'p4' ? instr.p4 : instr.p0;
          const center = normUnit(t, auto !== undefined ? auto : (baseArr ? baseArr[t.index] : 0));
          const vdArr = t.bank === 'p1' ? vd.p1 : t.bank === 'p2' ? vd.p2 : t.bank === 'p3' ? vd.p3 : t.bank === 'p4' ? vd.p4 : vd.p0;
          for (let v = 0; v < VOICES; v++) {
            const vc = this.voices[v];
            if (!vc.active || vc.instrument !== ii) continue;
            const off = this._modSourceOffset(slot, r, shared ? -1 : v, blockStart) * amount;
            vdArr[v * 4 + t.index] = denormUnit(t, center + off);
          }
        } else if (t.scope === 'fx' && t.key && instr.fx) {
          // One value drives the shared chain: shared free-run LFO, else the newest
          // active voice (env/retrigger). No active voice + per-voice source → skip.
          if (!shared && newestV < 0) continue;
          const off = this._modSourceOffset(slot, r, shared ? -1 : newestV, blockStart) * amount;
          const sk = `${ii}:${t.key}`;
          // Same live-edit re-baselining as the global-LFO fx path (see _applyLfos):
          // if the field no longer matches what we last wrote, the user/preset
          // changed it → re-centre on the new value rather than clobbering it.
          const last = this._instModFxLast.get(sk);
          let base = this._instModFxBase.get(sk);
          if (base === undefined || last === undefined || (instr.fx[t.key] as number) !== last) {
            base = instr.fx[t.key] as number;
            this._instModFxBase.set(sk, base);
          }
          const nv = denormUnit(t, normUnit(t, base) + off);
          const out = t.toggle ? (nv > 0.5) : nv;
          instr.fx[t.key] = out;
          this._instModFxLast.set(sk, out as number);
        }
      }
    }
  }
}

// Resolved per-block state for one mod-source slot (see Engine._applyInstMod Phase A).
interface SlotResolved {
  kind: ModSource['kind'];
  retrigger: boolean;
  amount: number;       // effective master amount (modulatable)
  cfg: LfoConfig;       // effective LFO config (wtPos already resolved)
  env: ModEnv;          // effective envelope (ADSR already resolved)
  rateMul: number;      // phase-rate multiplier from Rate modulation (1 = none)
  shared: boolean;      // free-running LFO (single phase for all voices)
  phase01: number;      // resolved shared phase in [0,1) (valid when shared)
  cycle: number;        // integer cycle index (for S&H), valid when shared
}
