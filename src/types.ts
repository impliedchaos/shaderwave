// Shared domain types for the tracker / synth / automation data model.
//
// These describe the plain-data shapes that flow between the song definitions,
// the engine, the GPU renderer, and the UI. Runtime classes (Pattern, Engine,
// …) declare their own fields; this file is for the structural records those
// classes pass around.
import type { Pattern } from './tracker/pattern.js';
import type { GLProgram } from './gl/program.js';

// A GPU synth engine identifier. Doubles as the synth-shader program key and the
// fxParams bucket key. The set is open (plug-in instruments register at runtime
// via the REGISTRY in src/instruments/); the canonical list is INSTRUMENTS in
// constants.ts (derived from the registry, in registry order).
export type InstrumentType = string;

// One DX7 operator's envelope + ratio config (see the dx7 shader / demo songs).
export interface DX7Op {
  coarse: number;
  fine: number;
  level: number;
  detune: number;
  decay?: number;
  mode: number;
  sustain?: number;
  release?: number;
  r1?: number;
  r2?: number;
  r3?: number;
  r4?: number;
  l1?: number;
  l2?: number;
  l3?: number;
  l4?: number;
}

export interface SampleData {
  name: string;          // original filename, for UI
  pcm: Float32Array;     // mono, at ENGINE sample rate (resample on load — see 4)
  rootNote: number;      // MIDI note the sample plays back at unity rate (default 60)
  loopStart: number;     // sample frames; 0 if none
  loopEnd: number;       // sample frames; pcm.length if none
  loopMode: number;      // 0 = one-shot, 1 = forward loop
  url?: string;          // optional HTTP source; if set with empty pcm, hydrated on load
                         // (lets presets/demo songs ship a sample by reference, not bytes)
}

// A per-engine-type param bank as authored in songs (defaultParams / makeParams).
// p0/p1 are the universal banks; moog adds p2/p3; dx7 carries operator config.
export interface InstrumentParams {
  p0: number[];
  p1: number[];
  p2?: number[];
  p3?: number[];
  ops?: DX7Op[];
  sample?: SampleData;
}

// A concrete instrument *instance* in the engine's instrument table. Patterns
// reference an instance by index (cell `inst`). Built from InstrumentParams by
// instrumentsFromParams(); the UI can append more instances at runtime.
export interface InstrumentInstance extends InstrumentParams {
  name: string;
  type: InstrumentType;
  color: string;
  fx: FxParams;          // this instance's OWN effect chain (per-instrument fx)
  fxOrder?: string[];    // per-instance effect-chain order (effect keys); absent → default
}

// An instrument as *authored* in a song's `params` array: the engine type is
// required but name/color may be filled in with defaults by instrumentsFromParams().
export interface InstrumentSpec extends InstrumentParams {
  type: InstrumentType;
  name?: string;
  color?: string;
  fx?: FxParams;         // optional authored fx (saved songs carry it; demos author per-type)
  fxOrder?: string[];    // optional per-instance effect-chain order
}

// ── Automation ────────────────────────────────────────────────────────────
export type ParamCurve = 'log' | 'lin' | 'enum';
export type ParamScope = 'inst' | 'fx' | 'chan' | 'global';

// One automatable parameter. `scope` selects which fields are meaningful:
//   inst → bank + index (into p0/p1) and a concrete engine `type`
//   fx   → key (a FxParams field), type '*'
//   chan → key (a per-channel mix param, e.g. pan), type '*'
export interface ParamTarget {
  id: number;
  code: string;
  label: string;
  min: number;
  max: number;
  curve: ParamCurve;
  scope: ParamScope;
  type: InstrumentType | '*';
  unit?: string;
  bank?: 'p0' | 'p1';
  index?: number;
  key?: string;
  toggle?: boolean;   // fx on/off "stomp box": byte 0 = off, anything else = on (written as a bool)
}

// ── Effects ─────────────────────────────────────────────────────────────────
// The per-engine-type effect chain parameters. Toggles are booleans, everything
// else is a scalar. The index signature lets automation write fields by key
// (fxParams[key] = value) and the legacy `drive` migration path in makeFx work.
export interface FxParams {
  enabled: boolean;
  distOn: boolean;
  chorusOn: boolean;
  tremoloOn: boolean;
  delayOn: boolean;
  reverbOn: boolean;
  widthOn: boolean;
  bitcrushOn: boolean;
  dist: number;
  tone: number;
  level: number;
  odOn: boolean;
  odDrive: number;
  odTone: number;
  odLevel: number;
  delayTime: number;
  delayFeedback: number;
  delayMix: number;
  reverbDecay: number;
  reverbDamp: number;
  reverbSend: number;
  reverbMix: number;
  width: number;
  master: number;
  chorusMix: number;
  chorusRate: number;
  chorusDepth: number;
  tremoloMix: number;
  tremoloRate: number;
  bitcrushBits: number;
  bitcrushRate: number;
  bitcrushMix: number;
  filterOn: boolean;
  filterCutoff: number;   // Hz
  filterReso: number;     // 0..1 → Q
  filterMode: number;     // 0 LP · 1 HP · 2 BP
  filterMix: number;      // dry/wet
  compOn: boolean;
  compThresh: number;     // dB
  compRatio: number;      // :1
  compAttack: number;     // ms
  compRelease: number;    // ms
  compMakeup: number;     // dB
  compSource: number;     // sidechain source instrument instance index (-1 = self)
  eqOn: boolean;
  eqLow: number;          // dB
  eqMid: number;          // dB
  eqHigh: number;         // dB
  eqLowFreq: number;      // Hz
  eqHighFreq: number;     // Hz
  limitOn: boolean;
  limitCeil: number;      // dB (output ceiling)
  limitRelease: number;   // ms
  vocoderOn: boolean;
  vocSource: number;      // modulator source instance index (-1 = off / no modulator)
  vocBands: number;       // band count (1..16)
  vocQ: number;           // per-band resonance / selectivity
  vocAttack: number;      // ms (envelope follower)
  vocRelease: number;     // ms (envelope follower)
  vocMix: number;         // dry/wet (1 = fully vocoded)
  vocUnvoiced: number;    // unvoiced/sibilance passthrough amount (0 = off)
  /** Legacy authoring field, migrated to `dist` by makeFx. */
  drive?: number;
  [key: string]: number | boolean | undefined;
}

// fxParams as stored per engine type (the table the renderer's chains read).
export type FxParamsByType = Record<InstrumentType, FxParams>;

// ── Global LFOs (modulation matrix) ─────────────────────────────────────────
// An LFO is now just a SOURCE (a waveform generator). Routings connect a source
// to a target — many routings can reference one source, so a single LFO drives
// multiple params. Each routing adds a transient offset layered above the param's
// center (never the instrument base). See src/tracker/lfo.ts.
export interface LfoConfig {
  shape: number;                 // 0 sine 1 tri 2 square 3 saw 4 S&H 5 ramp 6 wavetable 7 pump
  sync: boolean;                 // true → tempo-synced (rateBeats); false → free Hz (rateHz)
  rateBeats: number;             // cycle length in beats when synced
  rateHz: number;                // cycle frequency in Hz when free-running
  wtBank: number;                // shape 6: which Wavewright wavetable bank
  wtPos: number;                 // shape 6: morph position 0..1
}

// One source→target assignment in the modulation matrix.
export interface ModRouting {
  source: number;                // index into the song's lfos[]
  targetParamId: number;         // -1 = inactive; else an automation TARGETS id
  targetInstIdx: number | null;  // instrument instance (inst/fx) or channel (chan); null otherwise
  depth: number;                 // 0..1 swing in normalized units
  bipolar: boolean;              // ±depth around center vs 0..+depth
}

// ── Voice data ──────────────────────────────────────────────────────────────
// The GPU-facing per-voice buffers the engine fills each block and the renderer
// uploads as uniforms. All arrays are length VOICES (or VOICES*4 for the vec4
// param banks); see Engine constructor for the layout.
export interface VoiceData {
  active: Int32Array;
  inst: Int32Array;       // engine-type id (shader dispatch)
  instId: Int32Array;     // instrument-INSTANCE index (which table entry / fx chain)
  freq: Float32Array;
  vel: Float32Array;
  onRel: Float32Array;
  offRel: Float32Array;
  p0: Float32Array;
  p1: Float32Array;
  p2: Float32Array;       // moog-only banks
  p3: Float32Array;
  freqFrom: Float32Array; // glide source pitch (moog)
  gain: Float32Array;
  pan: Float32Array;
  master: number;
  // Per-voice DX7 operator config, packed [v*6 + op] into vec4 arrays.
  dx7Ops: { A: Float32Array; B: Float32Array; C: Float32Array; D: Float32Array };
  sampler?: {
    slot: Float32Array;
    baseRow: Float32Array;
    loopStart: Float32Array;
    loopEnd: Float32Array;
    len: Float32Array;
    rootFreq: Float32Array;
    loopMode: Float32Array;
  };
}

// ── Dedicated Automation Tracks ─────────────────────────────────────────────
// An automation track sequences a single parameter over the length of a pattern.
// targetInstIdx is null if the scope is global or chan.
// data is Int16Array: -1 means empty/hold, 0..255 are normalized values.
export interface AutoTrack {
  targetScope: ParamScope;
  targetInstIdx: number | null;
  targetParamId: number;
  data: Int16Array;
}

// ── Songs ─────────────────────────────────────────────────────────────────
// The runtime state a song's data() produces: the patterns, the play order
// (indices into patterns), and timing. `pan` is an optional per-channel base;
// `master` is the song's global output gain (absent → engine default).
export interface SongData {
  patterns: Pattern[];
  order: number[];
  rowsPerBeat: number;
  bpm?: number;
  pan?: number[];
  master?: number;
  lfos?: LfoConfig[];          // song-wide LFO sources (absent → defaults)
  modRoutings?: ModRouting[];  // source→target assignments (absent → none)
}

// A demo-song definition. `params` may be a keyed record (one entry per engine
// type) or an explicit list of instances; instrumentsFromParams handles both.
export interface SongDef {
  name: string;
  author?: string;   // song metadata (shown in the Song Editor, saved with the song)
  note?: string;
  bpm: number;
  master?: number;   // global output gain; absent → engine default
  params: Partial<Record<InstrumentType, InstrumentParams>> | InstrumentSpec[];
  fxParams: FxParamsByType;
  data: () => SongData;
}

// ── Instrument registry (the plug-in system) ───────────────────────────────
// One sidebar knob. p0/p1/p2/p3 knobs use bank+i; dx7 uses type+key (per-op or
// global). Lives here (not in the UI) so instrument descriptors can declare it.
export interface ParamDef {
  label: string;
  min: number;
  max: number;
  step: number;
  type?: 'global' | 'op';
  bank?: 'p0' | 'p1' | 'p2' | 'p3';
  i?: number;
  key?: string;
}

// An automation target as authored in a descriptor — scope/type/id are stamped
// on when the automation table flattens it (see tracker/automation.ts).
export type RawTarget = Omit<ParamTarget, 'id' | 'scope' | 'type'>;

// A built-in preset for an engine: synth param banks + an optional fx snapshot.
export interface Preset {
  name: string;
  p0: number[];
  p1: number[];
  p2?: number[];
  p3?: number[];
  fx?: Partial<FxParams>;
  sample?: any; // SerializedSample to hydrate on load
}

// A self-contained instrument engine — everything the app needs to register one
// new GPU synth. The REGISTRY (src/instruments/) is the single list of these;
// every per-engine table (params, presets, automation, defaults, help) derives
// from it. Adding an engine that fits the universal banks (p0..p3 + freqFrom) is
// a new descriptor + a .glsl shader + one registry entry; nothing else.
export interface InstrumentDef {
  type: string;            // unique id; shader program key; fxParams bucket key
  name: string;            // long display name, e.g. "Moog" (sidebar, + Add menu)
  short: string;           // 3-char label for the pattern editor, e.g. "MŌG"
  label: string;           // help title, e.g. "303 — Acid Bass"
  blurb: string;           // help description
  color?: string;          // optional accent override (else from the palette)
  shader: string;          // GLSL source (?raw), concatenated after common.glsl
  recursive?: boolean;     // per-sample feedback → strip/subBlock rendering (303, moog)
  drum?: boolean;          // keyboard selects drum slots, not pitch (808)
  defaults: InstrumentParams;
  paramDefs: ParamDef[];   // sidebar knobs ([] when customControls)
  autoTargets: RawTarget[];// inst-scope automation targets
  presets?: Preset[];
  customControls?: boolean; // bespoke sidebar UI (dx7 operator/SysEx-ROM editor)
  // Upload any engine-specific per-voice uniforms beyond the universal banks
  // (dx7 operator banks). Called once per block with the synth program bound.
  uploadVoiceUniforms?: (gl: WebGL2RenderingContext, prog: GLProgram, vd: VoiceData) => void;
}
