// Shared domain types for the tracker / synth / automation data model.
//
// These describe the plain-data shapes that flow between the song definitions,
// the engine, the GPU renderer, and the UI. Runtime classes (Pattern, Engine,
// …) declare their own fields; this file is for the structural records those
// classes pass around.
import type { Pattern } from './tracker/pattern.js';

// The four GPU synth engines. Doubles as the synth-shader program key and the
// fxParams bucket key. See INSTRUMENTS in constants.ts (same order/values).
export type InstrumentType = '303' | 'dx7' | '808' | 'moog';

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

// A per-engine-type param bank as authored in songs (defaultParams / makeParams).
// p0/p1 are the universal banks; moog adds p2/p3; dx7 carries operator config.
export interface InstrumentParams {
  p0: number[];
  p1: number[];
  p2?: number[];
  p3?: number[];
  ops?: DX7Op[];
}

// A concrete instrument *instance* in the engine's instrument table. Patterns
// reference an instance by index (cell `inst`). Built from InstrumentParams by
// instrumentsFromParams(); the UI can append more instances at runtime.
export interface InstrumentInstance extends InstrumentParams {
  name: string;
  type: InstrumentType;
  color: string;
}

// An instrument as *authored* in a song's `params` array: the engine type is
// required but name/color may be filled in with defaults by instrumentsFromParams().
export interface InstrumentSpec extends InstrumentParams {
  type: InstrumentType;
  name?: string;
  color?: string;
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
  /** Legacy authoring field, migrated to `dist` by makeFx. */
  drive?: number;
  [key: string]: number | boolean | undefined;
}

// fxParams as stored per engine type (the table the renderer's chains read).
export type FxParamsByType = Record<InstrumentType, FxParams>;

// ── Voice data ──────────────────────────────────────────────────────────────
// The GPU-facing per-voice buffers the engine fills each block and the renderer
// uploads as uniforms. All arrays are length VOICES (or VOICES*4 for the vec4
// param banks); see Engine constructor for the layout.
export interface VoiceData {
  active: Int32Array;
  inst: Int32Array;
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
}

// A demo-song definition. `params` may be a keyed record (one entry per engine
// type) or an explicit list of instances; instrumentsFromParams handles both.
export interface SongDef {
  name: string;
  bpm: number;
  master?: number;   // global output gain; absent → engine default
  params: Partial<Record<InstrumentType, InstrumentParams>> | InstrumentSpec[];
  fxParams: FxParamsByType;
  data: () => SongData;
}
