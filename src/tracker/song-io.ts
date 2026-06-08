// Song save/load — serialize the full runtime song state to a versioned JSON
// document and back. Pure data module (no GL): the App gathers state, this turns
// it into a portable object, and reconstructs Pattern instances on load.
//
// The `format` + `version` header is deliberate: the engine's data model has
// already shifted (universal p2/p3 banks, automation tracks, per-channel pan,
// new engines) and will keep shifting. `deserializeSong` validates the header,
// refuses files from a NEWER format than it understands, and routes older files
// through `migrate()` so we can evolve the schema without breaking saved songs.
//
// What's intentionally portable across versions:
//   - automation `paramId`s are the FROZEN target ids (see automation.ts), so a
//     saved automation track still resolves after new engines are appended.
//   - instruments are stored as specs and rebuilt via instrumentsFromParams on
//     load, which back-fills colours and missing p2/p3 banks from descriptors.
//   - fxParams is re-completed through the App's cloneFx (fills any engine type a
//     file omits, e.g. engines added in a later version).
import { Pattern } from './pattern.js';
import { defaultLfos, normalizeLfo, normalizeRouting, LFO_COUNT, defaultLfo } from './lfo.js';
import type { AutoTrack, DX7Op, FxParams, InstrumentInstance, InstrumentSpec, LfoConfig, ModRouting } from '../types.js';

export const SONG_FORMAT = 'shaderwave-song';
export const SONG_FORMAT_VERSION = 1;   // reset: single current schema (unreleased; no legacy saves)

export interface SerializedPattern {
  rows: number;
  channels: number;
  notes: number[];
  inst: number[];
  vol: number[];
  fxCmd: number[];
  fxVal: number[];
  autoTracks: { scope: AutoTrack['targetScope']; instIdx: number | null; paramId: number; data: number[] }[];
}

export interface SerializedInstrument {
  name: string;
  type: string;
  color?: string;
  p0: number[];
  p1: number[];
  p2?: number[];
  p3?: number[];
  ops?: DX7Op[];
  fx?: FxParams;          // v2+: this instance's own effect chain
}

export interface SerializedSong {
  format: string;
  version: number;
  name: string;
  author?: string;   // additive (optional) — older files simply lack it
  note?: string;
  bpm: number;
  rowsPerBeat: number;
  master: number;
  pan: number[];
  instruments: SerializedInstrument[];   // each carries its own fx (v2+)
  order: number[];
  patterns: SerializedPattern[];
  lfos?: LfoConfig[];          // v3+: LFO sources
  modRoutings?: ModRouting[];  // v4+: modulation matrix
}

// Everything the App must hand over to capture a song.
export interface SongIOInput {
  name: string;
  author: string;
  note: string;
  bpm: number;
  rowsPerBeat: number;
  master: number;
  pan: number[];
  instruments: InstrumentInstance[];   // fx lives on each instance
  order: number[];
  patterns: Pattern[];
  lfos: LfoConfig[];
  modRoutings: ModRouting[];
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;   // tidy float (vol) for JSON

function serializePattern(p: Pattern): SerializedPattern {
  return {
    rows: p.rows,
    channels: p.channels,
    notes: Array.from(p.notes),
    inst: Array.from(p.inst),
    vol: Array.from(p.vol, r4),
    fxCmd: Array.from(p.fxCmd),
    fxVal: Array.from(p.fxVal),
    autoTracks: p.autoTracks.map((t) => ({
      scope: t.targetScope,
      instIdx: t.targetInstIdx,
      paramId: t.targetParamId,
      data: Array.from(t.data),
    })),
  };
}

export function serializeSong(s: SongIOInput): SerializedSong {
  return {
    format: SONG_FORMAT,
    version: SONG_FORMAT_VERSION,
    name: s.name,
    author: s.author,
    note: s.note,
    bpm: s.bpm,
    rowsPerBeat: s.rowsPerBeat,
    master: r4(s.master),
    pan: s.pan.map(r4),
    instruments: s.instruments.map((i) => ({
      name: i.name,
      type: i.type,
      color: i.color,
      p0: [...i.p0],
      p1: [...i.p1],
      ...(i.p2 ? { p2: [...i.p2] } : {}),
      ...(i.p3 ? { p3: [...i.p3] } : {}),
      ...(i.ops ? { ops: i.ops.map((o) => ({ ...o })) } : {}),
      fx: { ...i.fx },                     // v2+: per-instance effect chain
    })),
    order: [...s.order],
    patterns: s.patterns.map(serializePattern),
    lfos: s.lfos.map((l) => ({ ...l })),
    modRoutings: s.modRoutings.map((r) => ({ ...r })),
  };
}

// No legacy migration ladder: this is an unreleased project and no songs were ever
// saved at an older format, so the current schema simply IS v1 (the version was
// reset). We still normalise the LFO sources + routing matrix so a hand-edited or
// partial file can't throw downstream.
function migrate(d: SerializedSong): SerializedSong {
  const rawL = Array.isArray(d.lfos) ? d.lfos : [];
  const lfos = defaultLfos();
  for (let i = 0; i < LFO_COUNT; i++) lfos[i] = normalizeLfo(rawL[i] ?? defaultLfo());
  d.lfos = lfos;
  d.modRoutings = (Array.isArray(d.modRoutings) ? d.modRoutings : []).map(normalizeRouting);
  return d;
}

// Validate the header and shape, run migrations, and return a current-version
// document. Throws a user-facing Error on anything it can't safely open.
export function deserializeSong(raw: unknown): SerializedSong {
  if (!raw || typeof raw !== 'object') throw new Error('Not a valid song file.');
  const d = raw as Partial<SerializedSong>;
  if (d.format !== SONG_FORMAT) throw new Error('This file is not a ShaderWave song.');
  if (typeof d.version !== 'number') throw new Error('Song file is missing its version.');
  if (d.version > SONG_FORMAT_VERSION) {
    throw new Error(`This song was saved by a newer version (format v${d.version}). Update ShaderWave to open it.`);
  }
  if (!Array.isArray(d.patterns) || !Array.isArray(d.order) || !Array.isArray(d.instruments)) {
    throw new Error('Song file is missing required fields (patterns/order/instruments).');
  }
  return migrate(d as SerializedSong);
}

// Rebuild a Pattern from its serialized form. Lengths are clamped to the pattern's
// own rows×channels so a slightly malformed/hand-edited file can't throw.
export function patternFromSerialized(sp: SerializedPattern): Pattern {
  const p = new Pattern(sp.rows, sp.channels);
  const n = sp.rows * sp.channels;
  const fill = (dst: Int16Array | Float32Array, src: number[] | undefined) => {
    if (!src) return;
    dst.set(src.slice(0, Math.min(src.length, n)));
  };
  fill(p.notes, sp.notes);
  fill(p.inst, sp.inst);
  fill(p.vol, sp.vol);
  fill(p.fxCmd, sp.fxCmd);
  fill(p.fxVal, sp.fxVal);
  p.autoTracks = (sp.autoTracks || []).map((t) => {
    const data = new Int16Array(sp.rows).fill(-1);
    data.set(t.data.slice(0, Math.min(t.data.length, sp.rows)));
    return { targetScope: t.scope, targetInstIdx: t.instIdx, targetParamId: t.paramId, data };
  });
  return p;
}

// The serialized instruments are exactly InstrumentSpec[] (type/name/color/p0/p1
// /p2?/p3?/ops?), so the App can rebuild the live table via instrumentsFromParams.
export function instrumentSpecs(d: SerializedSong): InstrumentSpec[] {
  return d.instruments as InstrumentSpec[];
}
