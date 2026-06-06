// Song = ordered list of patterns + the default instrument parameter banks, plus
// a built-in demo so the app makes sound on first load.
import { EMPTY } from './pattern.js';
import { INSTRUMENTS, INSTRUMENT_COLORS } from '../constants.js';
import { byType } from '../instruments/index.js';
import { DEMO_SONGS, defaultParams, makeParams, makeFx } from './demo-songs.js';
import type { InstrumentInstance, InstrumentParams, InstrumentSpec, InstrumentType, SongData, SongDef } from '../types.js';

// MIDI note → 808 drum slot (GM-ish drum map). The 808 shader reads the slot
// from uP0.x; the note itself only selects which drum, not a pitch.
export const DRUM_MAP: Record<number, number> = { 36: 0, 38: 1, 42: 2, 46: 3, 39: 4, 41: 5, 45: 6, 48: 7, 56: 8 };

// Build the instrument table from a song's per-engine-type param banks. Produces
// one instance per engine in INSTRUMENTS order, so existing pattern `inst` values
// (0=303, 1=dx7, 2=808, 3=moog) keep resolving to the right engine + params. The
// UI can append more instances (e.g. a second 303) on top at runtime.
// Some engines carry the extra universal banks (p2/p3) — e.g. the Moog's osc
// waveforms/octaves, glide, noise. Copy them from the song's params, falling back
// to the engine descriptor's defaults when a song predates them (old Moog songs
// get the classic Model-D defaults: three saws at 8', no glide/noise). Engines
// that don't declare p2/p3 defaults (303, 808, dx7) are left untouched.
function addExtraBanks(e: InstrumentInstance, pr: InstrumentParams): InstrumentInstance {
  const def = byType(e.type);
  if (def?.defaults.p2) e.p2 = pr.p2 ? [...pr.p2] : [...def.defaults.p2];
  if (def?.defaults.p3) e.p3 = pr.p3 ? [...pr.p3] : [...def.defaults.p3];
  return e;
}

export function instrumentsFromParams(
  params: InstrumentSpec[] | Partial<Record<InstrumentType, InstrumentParams>>,
): InstrumentInstance[] {
  if (Array.isArray(params)) {
    return params.map((pr, i) => {
      const e: InstrumentInstance = {
        name: pr.name || byType(pr.type)?.name || pr.type.toUpperCase(),
        type: pr.type,
        color: pr.color || INSTRUMENT_COLORS[i % INSTRUMENT_COLORS.length],
        p0: [...pr.p0],
        p1: [...pr.p1]
      };
      if (pr.ops) e.ops = pr.ops.map((o) => ({ ...o }));
      return addExtraBanks(e, pr);
    });
  }
  return INSTRUMENTS.map((type, i) => {
    const pr = params[type];
    if (!pr) throw new Error(`Song params missing engine type "${type}"`);
    const e: InstrumentInstance = { name: byType(type)?.name ?? type.toUpperCase(), type, color: INSTRUMENT_COLORS[i % INSTRUMENT_COLORS.length], p0: [...pr.p0], p1: [...pr.p1] };
    if (pr.ops) e.ops = pr.ops.map((o) => ({ ...o }));
    return addExtraBanks(e, pr);
  });
}

// Load a song's runtime state with its instrument table pruned to only the
// engines its patterns actually play, remapping pattern instrument-indices to
// the compact table. Returns { instruments, data } for the engine. (Demo
// data()/params keep referencing all four engines by INSTRUMENTS order; the
// prune happens here so the sidebar never shows instruments a song doesn't use.)
export function loadSongInstruments(songDef: SongDef): { instruments: InstrumentInstance[]; data: SongData } {
  const full = instrumentsFromParams(songDef.params);   // 4, in INSTRUMENTS order
  const data = songDef.data();
  if (data.master === undefined) data.master = songDef.master;   // top-level → runtime (data() may override)

  const used = new Set<number>();
  for (const pat of data.patterns) {
    for (let i = 0; i < pat.inst.length; i++) {
      if (pat.notes[i] !== EMPTY) used.add(pat.inst[i]);
    }
    for (const track of pat.autoTracks) {
      // Only count in-range instance targets; an out-of-range index (e.g. a song
      // authored with a stale channel/instance number) must not enlarge `keep`
      // into a hole — it falls through to instance 0 in the remap below.
      if ((track.targetScope === 'inst' || track.targetScope === 'fx')
          && track.targetInstIdx !== null
          && track.targetInstIdx >= 0 && track.targetInstIdx < full.length) {
        used.add(track.targetInstIdx);
      }
    }
  }
  if (used.size === 0) used.add(0);                      // always keep ≥1

  const keep = [...used].sort((a, b) => a - b);          // preserve engine order
  const remap = new Map(keep.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  const instruments = keep.map((oldIdx) => full[oldIdx]);

  for (const pat of data.patterns) {
    for (let i = 0; i < pat.inst.length; i++) {
      const m = remap.get(pat.inst[i]);
      pat.inst[i] = m === undefined ? 0 : m;             // unused cells → instance 0
    }
    for (const track of pat.autoTracks) {
      if ((track.targetScope === 'inst' || track.targetScope === 'fx') && track.targetInstIdx !== null) {
        const m = remap.get(track.targetInstIdx);
        track.targetInstIdx = m === undefined ? 0 : m;
      }
    }
  }
  return { instruments, data };
}

export { DEMO_SONGS, defaultParams, makeParams, makeFx };

export function demoSong(): SongData {
  return DEMO_SONGS[0].data();
}
