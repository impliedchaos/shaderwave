// @ts-nocheck
// Song = ordered list of patterns + the default instrument parameter banks, plus
// a built-in demo so the app makes sound on first load.
import { Pattern, OFF, EMPTY } from './pattern.js';
import { INSTRUMENTS, INSTRUMENT_COLORS } from '../constants.js';
import { defaultFxParams } from '../gl/effects.js';
import { DEMO_SONGS, defaultParams, makeParams, makeFx } from './demo-songs.js';

// MIDI note → 808 drum slot (GM-ish drum map). The 808 shader reads the slot
// from uP0.x; the note itself only selects which drum, not a pitch.
export const DRUM_MAP = { 36: 0, 38: 1, 42: 2, 46: 3, 39: 4, 41: 5, 45: 6, 48: 7, 56: 8 };

// Build the instrument table from a song's per-engine-type param banks. Produces
// one instance per engine in INSTRUMENTS order, so existing pattern `inst` values
// (0=303, 1=dx7, 2=808, 3=moog) keep resolving to the right engine + params. The
// UI can append more instances (e.g. a second 303) on top at runtime.
// Moog instances carry two extra param banks (osc waveforms/octaves, glide,
// noise). Songs predating them just get the classic-Model-D defaults: three
// saws at 8', no glide/noise.
function addMoogBanks(e, pr) {
  if (e.type !== 'moog') return e;
  e.p2 = pr.p2 ? [...pr.p2] : [1, 1, 1, 0];
  e.p3 = pr.p3 ? [...pr.p3] : [2, 2, 2, 0];
  return e;
}

export function instrumentsFromParams(params) {
  if (Array.isArray(params)) {
    return params.map((pr, i) => {
      const e = {
        name: pr.name || pr.type.toUpperCase(),
        type: pr.type,
        color: pr.color || INSTRUMENT_COLORS[i % INSTRUMENT_COLORS.length],
        p0: [...pr.p0],
        p1: [...pr.p1]
      };
      if (pr.ops) e.ops = pr.ops.map((o) => ({ ...o }));
      return addMoogBanks(e, pr);
    });
  }
  return INSTRUMENTS.map((type, i) => {
    const pr = params[type];
    const e = { name: type.toUpperCase(), type, color: INSTRUMENT_COLORS[i % INSTRUMENT_COLORS.length], p0: [...pr.p0], p1: [...pr.p1] };
    if (pr.ops) e.ops = pr.ops.map((o) => ({ ...o }));
    return addMoogBanks(e, pr);
  });
}

// Load a song's runtime state with its instrument table pruned to only the
// engines its patterns actually play, remapping pattern instrument-indices to
// the compact table. Returns { instruments, data } for the engine. (Demo
// data()/params keep referencing all four engines by INSTRUMENTS order; the
// prune happens here so the sidebar never shows instruments a song doesn't use.)
export function loadSongInstruments(songDef) {
  const full = instrumentsFromParams(songDef.params);   // 4, in INSTRUMENTS order
  const data = songDef.data();

  const used = new Set();
  for (const pat of data.patterns) {
    for (let i = 0; i < pat.inst.length; i++) {
      if (pat.notes[i] !== EMPTY) used.add(pat.inst[i]);
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
  }
  return { instruments, data };
}

export { DEMO_SONGS, defaultParams, makeParams, makeFx };

export function demoSong() {
  return DEMO_SONGS[0].data();
}
