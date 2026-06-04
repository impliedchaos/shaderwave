// Song = ordered list of patterns + the default instrument parameter banks, plus
// a built-in demo so the app makes sound on first load.
import { Pattern, OFF, EMPTY } from './pattern.js';
import { INSTRUMENTS, INSTRUMENT_COLORS } from '../constants.js';
import { defaultFxParams } from '../gl/effects.js';

// MIDI note → 808 drum slot (GM-ish drum map). The 808 shader reads the slot
// from uP0.x; the note itself only selects which drum, not a pitch.
export const DRUM_MAP = { 36: 0, 38: 1, 42: 2, 46: 3, 39: 4, 41: 5, 45: 6, 48: 7, 56: 8 };

function makeDemoPatterns(p) {
  // Pattern 0: Intro (Drums muted)
  const pIntro = new Pattern(p.rows, p.channels);
  pIntro.notes.set(p.notes);
  pIntro.inst.set(p.inst);
  pIntro.vol.set(p.vol);
  
  // Clear channel 0 (Kick), 1 (Snare), and 2 (Hats/Clap) in pIntro
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < 3; c++) {
      const idx = r * p.channels + c;
      pIntro.notes[idx] = EMPTY;
      pIntro.inst[idx] = 0;
      pIntro.vol[idx] = 0;
    }
  }

  // Pattern 2: Modulated Variation (Bass/Leads transposed up by a perfect fourth)
  const pBridge = new Pattern(p.rows, p.channels);
  pBridge.notes.set(p.notes);
  pBridge.inst.set(p.inst);
  pBridge.vol.set(p.vol);

  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.channels; c++) {
      const idx = r * p.channels + c;
      const note = pBridge.notes[idx];
      if (note !== EMPTY && note !== OFF) {
        if (c === 3 || c === 4 || c === 5 || c === 6) {
          pBridge.notes[idx] = note + 5;
        }
      }
    }
  }

  return { patterns: [pIntro, p, pBridge], order: [0, 1, 2], rowsPerBeat: 4 };
}

// Build the instrument table from a song's per-engine-type param banks. Produces
// one instance per engine in INSTRUMENTS order, so existing pattern `inst` values
// (0=303, 1=dx7, 2=808, 3=moog) keep resolving to the right engine + params. The
// UI can append more instances (e.g. a second 303) on top at runtime.
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
      return e;
    });
  }
  return INSTRUMENTS.map((type, i) => {
    const pr = params[type];
    const e = { name: type.toUpperCase(), type, color: INSTRUMENT_COLORS[i % INSTRUMENT_COLORS.length], p0: [...pr.p0], p1: [...pr.p1] };
    if (pr.ops) e.ops = pr.ops.map((o) => ({ ...o }));
    return e;
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

// Default per-instrument param banks (p0, p1). See each shader for the layout.
export function defaultParams() {
  return {
    '303':  { p0: [400, 0.72, 0.6, 0.4], p1: [0, 0.3, 0.4, 0] },
    'dx7':  {
      p0: [1, 2, 3.0, 0.3],
      p1: [1, 0.6, 0.9, 3],
      ops: [
        { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.25 },
        { coarse: 2.0, fine: 0, level: 99, detune: 0, decay: 0.6, mode: 0, sustain: 0.7, release: 0.25 },
        { coarse: 3.0, fine: 0, level: 60, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.25 },
        { coarse: 4.0, fine: 0, level: 80, detune: 0, decay: 0.4, mode: 0, sustain: 0.7, release: 0.25 },
        { coarse: 5.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.7, release: 0.25 },
        { coarse: 6.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.7, release: 0.25 }
      ]
    },
    '808':  { p0: [0, 0.6, 0.5, 0.6],    p1: [0, 0, 0, 0] },
    'moog': { p0: [800, 0.45, 0.5, 0],   p1: [8, 0.8, 0.6, 0.9] },
  };
}

export function makeParams(overrides) {
  const p = defaultParams();
  for (const k in overrides) {
    if (overrides[k].p0) p[k].p0 = [...overrides[k].p0];
    if (overrides[k].p1) p[k].p1 = [...overrides[k].p1];
    if (overrides[k].ops) p[k].ops = overrides[k].ops.map(o => ({ ...o }));
  }
  return p;
}

export function makeFx(overrides) {
  const mapInst = (instName) => {
    const res = Object.assign(defaultFxParams(), overrides[instName] || {});
    if (res.drive !== undefined) {
      // Map old drive range (1.0 - 6.0) to DS-1 dist range (0.001 - 20.0)
      res.dist = Math.max(0.001, res.drive * 3.5 - 2.5);
      delete res.drive;
    }
    return res;
  };
  return {
    '303': mapInst('303'),
    'dx7': mapInst('dx7'),
    '808': mapInst('808'),
    'moog': mapInst('moog'),
  };
}

const I = Object.fromEntries(INSTRUMENTS.map((n, i) => [n, i])); // name → index

export const DEMO_SONGS = [
  {
    name: "Gooner Prolapse",
    bpm: 135,
    params: [
      { name: "808 Kick", type: "808", p0: [0, 0.5, 0.8, 0.8], p1: [0, 0, 0, 0] },
      { name: "303 Bass A", type: "303", p0: [300, 0.8, 0.7, 0.5], p1: [1, 0.3, 0.4, 0] },
      { name: "303 Bass B", type: "303", p0: [200, 0.9, 0.8, 0.6], p1: [0, 0.2, 0.35, 0] },
      { name: "303 Lead A", type: "303", p0: [1200, 0.85, 0.6, 0.4], p1: [1, 0.4, 0.4, 0] },
      { name: "303 Lead B", type: "303", p0: [1500, 0.9, 0.5, 0.3], p1: [0, 0.3, 0.3, 0] },
      { name: "Moog Bass A", type: "moog", p0: [150, 0.7, 0.8, 0], p1: [4, 0.9, 0.5, 0.8] },
      { name: "Moog Bass B", type: "moog", p0: [120, 0.8, 0.9, 0], p1: [6, 0.95, 0.6, 0.9] },
      { name: "Moog Lead A", type: "moog", p0: [900, 0.3, 0.4, 0], p1: [12, 0.5, 0.7, 0.4] },
      { name: "Moog Lead B", type: "moog", p0: [1400, 0.2, 0.3, 0], p1: [16, 0.4, 0.8, 0.3] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { dist: 12.0, tone: 0.6, level: 1.0, master: 0.85, delayMix: 0.3, delayFeedback: 0.45 }),
      'dx7': defaultFxParams(),
      '808': Object.assign(defaultFxParams(), { dist: 6.0, tone: 0.5, level: 1.0, master: 0.9 }),
      'moog': Object.assign(defaultFxParams(), { dist: 10.0, tone: 0.5, level: 1.0, master: 0.8, reverbMix: 0.4, reverbDecay: 0.9 }),
    },
    data: () => {
      const p0 = new Pattern(128, 8);
      const p1 = new Pattern(128, 8);
      const p2 = new Pattern(128, 8);
      const p3 = new Pattern(128, 8);
      const p4 = new Pattern(128, 8);
      const p5 = new Pattern(128, 8);
      const p6 = new Pattern(128, 8);
      const p7 = new Pattern(128, 8);
      const p8 = new Pattern(128, 8);
      const p9 = new Pattern(128, 8);
      const p10 = new Pattern(128, 8);
      const p11 = new Pattern(128, 8);
      const p12 = new Pattern(128, 8);
      const p13 = new Pattern(128, 8);

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_808 = 0;
      const I_303_1 = 1, I_303_2 = 2, I_303_3 = 3, I_303_4 = 4;
      const I_moogBass1 = 5, I_moogBass2 = 6, I_moogLead1 = 7, I_moogLead2 = 8;

      const getDarkRoot = (row) => {
        const progression = [38, 38, 37, 37, 36, 36, 35, 35, 38, 38, 41, 41, 44, 44, 43, 43];
        const bar = Math.floor(row / 16);
        return progression[bar % progression.length];
      };

      const setGoonDrums = (pat, hasKick, hasSnare, hasHats) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (hasKick) {
            if (step === 0 || step === 6 || step === 10) pat.set(r, 0, BD, I_808, 0.95);
          }
          if (hasSnare) {
            if (step === 4 || step === 12) pat.set(r, 1, SD, I_808, 0.85);
            if (r >= 112 && r % 4 === 2) pat.set(r, 1, SD, I_808, 0.7);
          }
          if (hasHats) {
            if (step % 2 === 1) pat.set(r, 2, HH, I_808, 0.45);
            if (step === 6 || step === 14) pat.set(r, 2, OH, I_808, 0.55);
          }
        }
      };

      const setGoonMoogBass = (pat, ch, inst, vol = 0.85) => {
        for (let r = 0; r < 128; r += 2) {
          const root = getDarkRoot(r);
          pat.set(r, ch, root, inst, vol);
          pat.set(r + 1, ch, OFF, inst);
        }
      };

      const setGoon303Bass = (pat, ch, inst, vol = 0.8) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (step === 0 || step === 3 || step === 6 || step === 8 || step === 11 || step === 14) {
            const root = getDarkRoot(r);
            const note = root + 12 + (step === 3 ? 1 : step === 6 ? 3 : step === 8 ? 6 : 0);
            pat.set(r, ch, note, inst, vol);
            pat.set(r + 1, ch, OFF, inst);
          }
        }
      };

      const setGoon303Lead = (pat, ch, inst, vol = 0.75, offset = 12) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 8;
          if (step === 0 || step === 3 || step === 5) {
            const root = getDarkRoot(r);
            pat.set(r, ch, root + offset + 12, inst, vol);
            pat.set(r + 1, ch, OFF, inst);
          }
        }
      };

      const setGoonMoogLead = (pat, ch, inst, vol = 0.8, offset = 24) => {
        for (let r = 0; r < 128; r += 4) {
          const root = getDarkRoot(r);
          const notes = [0, 1, 3, 4, 3, 1, 0, -1];
          const note = root + offset + notes[Math.floor(r / 4) % notes.length];
          pat.set(r, ch, note, inst, vol);
          pat.set(r + 3, ch, OFF, inst);
        }
      };

      setGoonMoogBass(p0, 3, I_moogBass1, 0.75);

      setGoonMoogBass(p1, 3, I_moogBass1, 0.75);
      setGoonMoogBass(p1, 7, I_moogBass2, 0.75);

      setGoonDrums(p2, true, false, false);
      setGoonMoogBass(p2, 3, I_moogBass1, 0.8);
      setGoonMoogBass(p2, 7, I_moogBass2, 0.8);

      setGoonDrums(p3, true, false, false);
      setGoonMoogBass(p3, 3, I_moogBass1, 0.8);
      setGoon303Bass(p3, 4, I_303_1, 0.75);

      setGoonDrums(p4, true, false, false);
      setGoonMoogBass(p4, 3, I_moogBass1, 0.8);
      setGoon303Bass(p4, 4, I_303_1, 0.75);
      setGoon303Bass(p4, 5, I_303_2, 0.75);

      setGoonDrums(p5, true, true, true);
      setGoonMoogBass(p5, 3, I_moogBass1, 0.8);
      setGoon303Bass(p5, 4, I_303_1, 0.8);
      setGoon303Bass(p5, 5, I_303_2, 0.8);

      setGoonDrums(p6, true, true, true);
      setGoonMoogBass(p6, 3, I_moogBass1, 0.8);
      setGoon303Bass(p6, 4, I_303_1, 0.8);
      setGoonMoogLead(p6, 6, I_moogLead1, 0.8);

      setGoonDrums(p7, true, true, true);
      setGoonMoogBass(p7, 3, I_moogBass1, 0.8);
      setGoon303Bass(p7, 4, I_303_1, 0.8);
      setGoonMoogLead(p7, 6, I_moogLead1, 0.8);
      setGoonMoogLead(p7, 7, I_moogLead2, 0.8, 36);

      setGoonDrums(p8, true, true, true);
      setGoonMoogBass(p8, 3, I_moogBass1, 0.85);
      setGoon303Bass(p8, 4, I_303_1, 0.85);
      setGoon303Lead(p8, 5, I_303_3, 0.75);

      setGoonDrums(p9, true, true, true);
      setGoonMoogBass(p9, 3, I_moogBass1, 0.85);
      setGoon303Bass(p9, 4, I_303_1, 0.85);
      setGoon303Lead(p9, 5, I_303_3, 0.75);
      setGoon303Lead(p9, 6, I_303_4, 0.75, 24);

      setGoonDrums(p10, false, false, true);
      setGoonMoogBass(p10, 3, I_moogBass1, 0.6);
      setGoonMoogLead(p10, 6, I_moogLead1, 0.6);

      setGoonMoogBass(p11, 3, I_moogBass1, 0.8);
      setGoon303Bass(p11, 4, I_303_1, 0.8);
      for (let r = 0; r < 128; r++) {
        if (r >= 64) {
          const step = r - 64;
          if (step % 2 === 0 || step >= 32) {
            p11.set(r, 1, SD, I_808, 0.5 + (step / 64) * 0.45);
          }
        }
      }

      setGoonDrums(p12, true, true, true);
      setGoonMoogBass(p12, 3, I_moogBass1, 0.9);
      setGoonMoogBass(p12, 7, I_moogBass2, 0.9);
      setGoon303Bass(p12, 4, I_303_1, 0.9);
      setGoon303Lead(p12, 5, I_303_3, 0.8);
      setGoonMoogLead(p12, 6, I_moogLead1, 0.85);

      setGoonDrums(p13, true, false, false);
      setGoonMoogBass(p13, 3, I_moogBass1, 0.75);

      return {
        patterns: [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13],
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 12, 13],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Darkwave Electro",
    bpm: 112,
    params: makeParams({
      '303': { p0: [600, 0.8, 0.7, 0.4], p1: [1, 0.25, 0.3, 0] }
    }),
    fxParams: makeFx({
      '808': { drive: 1.8, reverbMix: 0.2 },
      '303': { drive: 2.0, delayMix: 0.2 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 16) {
        p.set(r, 0, 36, I['808'], 1.0);
        p.set(r + 3, 0, 36, I['808'], 0.8);
        p.set(r + 8, 0, 36, I['808'], 0.9);
        p.set(r + 11, 0, 36, I['808'], 0.75);
        p.set(r + 4, 1, 38, I['808'], 0.95);
        p.set(r + 12, 1, 38, I['808'], 0.95);
      }
      const bass = [40, 40, 43, 40, 45, 40, 43, 40];
      for (let r = 0; r < 128; r += 2) {
        const step = Math.floor(r / 2) % bass.length;
        p.set(r, 4, bass[step], I['moog'], 0.85);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Perky Wombat Tits",
    bpm: 160,
    params: [
      {
        name: "Lately Bass",
        type: "dx7",
        p0: [1, 2, 3.0, 1.5],
        p1: [14, 0.6, 0.9, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 0, detune: 0, decay: 0.05, mode: 0, sustain: 1.0, release: 0.05 },
          { coarse: 1.0, fine: 0, level: 0, detune: 0, decay: 0.05, mode: 0, sustain: 1.0, release: 0.05 },
          { coarse: 0.5, fine: 0, level: 99, detune: 0, decay: 2.505, mode: 0, sustain: 0.0, release: 1.657 },
          { coarse: 0.5, fine: 0, level: 82, detune: 0, decay: 2.505, mode: 0, sustain: 0.0, release: 1.657 },
          { coarse: 1.0, fine: 0, level: 79, detune: -3, decay: 1.535, mode: 0, sustain: 0.0, release: 1.657 },
          { coarse: 1.0, fine: 0, level: 87, detune: 0, decay: 1.657, mode: 0, sustain: 0.0, release: 2.869 }
        ]
      },
      { name: "808 Dance Kit", type: "808", p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
      { name: "Happy Square A", type: "303", p0: [600, 0.5, 0.7, 0.3], p1: [1.0, 0.15, 0.25, 0] },
      { name: "Happy Square B", type: "303", p0: [800, 0.6, 0.6, 0.4], p1: [1.0, 0.2, 0.3, 0] },
      { name: "Fat Moog Lead", type: "moog", p0: [1200, 0.4, 0.5, 0], p1: [8, 0.8, 0.6, 0.9] },
      { name: "FM Bell Chords", type: "dx7",
        p0: [1, 3, 2.5, 0.4], p1: [1, 0.6, 0.9, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.3 },
          { coarse: 2.0, fine: 0, level: 85, detune: 1, decay: 0.6, mode: 0, sustain: 0.6, release: 0.3 },
          { coarse: 3.0, fine: 0, level: 75, detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.3 },
          { coarse: 4.0, fine: 0, level: 65, detune: 0, decay: 0.4, mode: 0, sustain: 0.4, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.3 }
        ]
      }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { chorusMix: 0.4, delayMix: 0.35, delayTime: 0.375, delayFeedback: 0.5 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.3, delayMix: 0.25, reverbMix: 0.25 }),
      '808': Object.assign(defaultFxParams(), { dist: 1.0, tone: 0.5, level: 1.0, master: 0.95 }),
      'moog': Object.assign(defaultFxParams(), { chorusMix: 0.5, delayMix: 0.3, delayTime: 0.5, reverbMix: 0.4 }),
    },
    data: () => {
      const p0 = new Pattern(128, 8);
      const p1 = new Pattern(128, 8);
      const p2 = new Pattern(128, 8);
      const p3 = new Pattern(128, 8);
      const p4 = new Pattern(128, 8);
      const p5 = new Pattern(128, 8);
      const p6 = new Pattern(128, 8);
      const p7 = new Pattern(128, 8);

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_lately = 0, I_808 = 1, I_sqA = 2, I_sqB = 3, I_moog = 4, I_chords = 5;

      const getHappyRoot = (row) => {
        const progression = [36, 36, 36, 36, 43, 43, 43, 43, 45, 45, 45, 45, 41, 41, 41, 41];
        const bar = Math.floor(row / 16);
        return progression[bar % progression.length];
      };

      const setHappyDrums = (pat, hasKick, hasSnare, hasHats, hasClap) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (hasKick) {
            if (step === 0 || step === 4 || step === 8 || step === 12) {
              pat.set(r, 0, BD, I_808, 0.95);
            }
          }
          if (hasSnare) {
            if (step === 4 || step === 12) {
              pat.set(r, 1, SD, I_808, 0.85);
            }
          }
          if (hasClap) {
            if (step === 12) {
              pat.set(r, 1, CLAP, I_808, 0.8);
            }
          }
          if (hasHats) {
            if (step === 2 || step === 6 || step === 10 || step === 14) {
              pat.set(r, 2, OH, I_808, 0.55);
            } else if (step % 2 === 0) {
              pat.set(r, 2, HH, I_808, 0.3);
            }
          }
        }
      };

      const setLatelyBass = (pat, ch, inst, vol = 0.85) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          const root = getHappyRoot(r);
          if (step === 0 || step === 4 || step === 8 || step === 12) {
            pat.set(r, ch, root, inst, vol);
          } else if (step === 2 || step === 6 || step === 10 || step === 14) {
            pat.set(r, ch, root + 12, inst, vol * 0.9);
          } else if (step === 3 || step === 7 || step === 11 || step === 15) {
            pat.set(r, ch, OFF, inst);
          }
        }
      };

      const happyMelody = [
        72, 76, 79, 84, 81, 79, 76, 79,
        74, 77, 79, 83, 79, 77, 74, 77,
        76, 79, 81, 84, 81, 79, 76, 79,
        79, 81, 83, 84, 86, 84, 83, 84
      ];

      const setSquareLead = (pat, ch, inst, vol = 0.8) => {
        for (let r = 0; r < 128; r += 2) {
          const step = Math.floor(r / 2) % happyMelody.length;
          const note = happyMelody[step];
          pat.set(r, ch, note, inst, vol);
          pat.set(r + 1, ch, OFF, inst);
        }
      };

      const setSquareHarmony = (pat, ch, inst, vol = 0.7) => {
        for (let r = 0; r < 128; r += 2) {
          const step = Math.floor(r / 2) % happyMelody.length;
          const note = happyMelody[step] + 12; // octave harmony
          pat.set(r, ch, note, inst, vol);
          pat.set(r + 1, ch, OFF, inst);
        }
      };

      const setBellChords = (pat, ch, inst, vol = 0.6) => {
        for (let r = 0; r < 128; r += 8) {
          const root = getHappyRoot(r);
          let notes = [];
          if (root === 36) notes = [60, 64, 67];
          else if (root === 43) notes = [55, 59, 62];
          else if (root === 45) notes = [57, 60, 64];
          else if (root === 41) notes = [53, 57, 60];
          
          notes.forEach(note => {
            pat.set(r, ch, note, inst, vol);
          });
          pat.set(r + 6, ch, OFF, inst);
        }
      };

      const setMoogLead = (pat, ch, inst, vol = 0.75) => {
        const solo = [
          79, 81, 84, 86, 88, 86, 84, 81,
          83, 84, 86, 88, 91, 88, 86, 84,
          84, 86, 88, 91, 93, 91, 88, 86,
          88, 91, 93, 95, 96, 95, 93, 95
        ];
        for (let r = 0; r < 128; r += 4) {
          const step = Math.floor(r / 4) % solo.length;
          const note = solo[step];
          pat.set(r, ch, note, inst, vol);
          pat.set(r + 3, ch, OFF, inst);
        }
      };

      // Pattern 0: Intro (Bass & Chords only)
      setLatelyBass(p0, 3, I_lately, 0.85);
      setBellChords(p0, 7, I_chords, 0.6);

      // Pattern 1: Intro Build (Add Hats, Snare Roll, Happy Square Lead A)
      setHappyDrums(p1, false, false, true, false);
      setLatelyBass(p1, 3, I_lately, 0.85);
      setSquareLead(p1, 4, I_sqA, 0.75);
      setBellChords(p1, 7, I_chords, 0.6);
      // Snare roll at the end of build
      for (let r = 112; r < 128; r++) {
        if (r % 2 === 0 || r >= 120) {
          p1.set(r, 1, SD, I_808, 0.4 + ((r - 112) / 16) * 0.55);
        }
      }

      // Pattern 2: Main Happy Drop
      setHappyDrums(p2, true, true, true, true);
      setLatelyBass(p2, 3, I_lately, 0.9);
      setSquareLead(p2, 4, I_sqA, 0.8);
      setSquareHarmony(p2, 5, I_sqB, 0.7);
      setBellChords(p2, 7, I_chords, 0.6);

      // Pattern 3: Happy Drop with Moog Solo
      setHappyDrums(p3, true, true, true, true);
      setLatelyBass(p3, 3, I_lately, 0.9);
      setSquareLead(p3, 4, I_sqA, 0.7);
      setMoogLead(p3, 6, I_moog, 0.8);
      setBellChords(p3, 7, I_chords, 0.5);

      // Pattern 4: Breakdown (No kick/snare, chords, bass, quiet lead)
      setHappyDrums(p4, false, false, true, false);
      setLatelyBass(p4, 3, I_lately, 0.75);
      setSquareLead(p4, 4, I_sqA, 0.65);
      setBellChords(p4, 7, I_chords, 0.7);

      // Pattern 5: Build-up
      setHappyDrums(p5, true, false, true, false);
      setLatelyBass(p5, 3, I_lately, 0.85);
      setSquareLead(p5, 4, I_sqA, 0.8);
      setSquareHarmony(p5, 5, I_sqB, 0.7);
      for (let r = 96; r < 128; r++) {
        if (r % 2 === 0 || r >= 112) {
          p5.set(r, 1, SD, I_808, 0.4 + ((r - 96) / 32) * 0.55);
        }
      }

      // Pattern 6: Climax Drop! (All elements play)
      setHappyDrums(p6, true, true, true, true);
      setLatelyBass(p6, 3, I_lately, 0.95);
      setSquareLead(p6, 4, I_sqA, 0.85);
      setSquareHarmony(p6, 5, I_sqB, 0.75);
      setMoogLead(p6, 6, I_moog, 0.85);
      setBellChords(p6, 7, I_chords, 0.65);

      // Pattern 7: Outro
      setHappyDrums(p7, true, false, false, false);
      setLatelyBass(p7, 3, I_lately, 0.75);
      setBellChords(p7, 7, I_chords, 0.6);

      return {
        patterns: [p0, p1, p2, p3, p4, p5, p6, p7],
        order: [0, 1, 2, 3, 4, 5, 6, 2, 3, 4, 5, 6, 6, 7, 7, 0], // 16 steps order -> 3.2 minutes!
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Fake My Breath Away",
    bpm: 116,
    params: [
      {
        name: "BASS 2",
        type: "dx7",
        p0: [1, 2, 3.0, 1.5],
        p1: [17, 0.6, 0.9, 3],
        ops: [
          { coarse: 0.5, fine: 1, level: 99, detune: 0, decay: 2.505, mode: 0, sustain: 0.0, release: 1.455 },
          { coarse: 0.5, fine: 3, level: 80, detune: 0, decay: 2.505, mode: 0, sustain: 0.0, release: 1.980 },
          { coarse: 1.0, fine: 0, level: 68, detune: 7, decay: 2.990, mode: 0, sustain: 0.0, release: 2.788 },
          { coarse: 0.5, fine: 0, level: 99, detune: 0, decay: 2.424, mode: 0, sustain: 0.0, release: 1.859 },
          { coarse: 1.0, fine: 1, level: 75, detune: 0, decay: 1.939, mode: 0, sustain: 0.0, release: 4.0 },
          { coarse: 0.5, fine: 0, level: 87, detune: 1, decay: 1.980, mode: 0, sustain: 0.0, release: 1.778 }
        ]
      },
      { name: "808 Gated Kit", type: "808", p0: [0, 0.5, 0.8, 0.6], p1: [0, 0, 0, 0] },
      { name: "Warm Pad", type: "moog", p0: [400, 0.2, 0.3, 0], p1: [15.0, 0.8, 1.5, 1.2] },
      { name: "FM Chime Hook", type: "dx7",
        p0: [1, 3.5, 4.0, 0.6], p1: [1, 0.5, 0.8, 4],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.25 },
          { coarse: 3.5, fine: 0, level: 85, detune: 1, decay: 0.6, mode: 0, sustain: 0.6, release: 0.25 },
          { coarse: 5.0, fine: 0, level: 70, detune: -1, decay: 0.5, mode: 0, sustain: 0.5, release: 0.25 },
          { coarse: 7.0, fine: 0, level: 60, detune: 0, decay: 0.4, mode: 0, sustain: 0.4, release: 0.25 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.25 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.25 }
        ]
      },
      { name: "Soaring Moog Lead", type: "moog", p0: [900, 0.4, 0.6, 0], p1: [6.0, 0.9, 0.8, 0.6] }
    ],
    fxParams: {
      '303': defaultFxParams(),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.45, chorusRate: 1.2, delayMix: 0.35, delayTime: 0.375, reverbMix: 0.35, reverbDecay: 0.85 }),
      '808': Object.assign(defaultFxParams(), { dist: 2.0, master: 0.9, reverbMix: 0.45, reverbDecay: 0.8 }),
      'moog': Object.assign(defaultFxParams(), { chorusMix: 0.55, chorusRate: 0.8, chorusDepth: 4.0, delayMix: 0.3, reverbMix: 0.55, reverbDecay: 0.92 }),
    },
    data: () => {
      const p0 = new Pattern(128, 8);
      const p1 = new Pattern(128, 8);
      const p2 = new Pattern(128, 8);
      const p3 = new Pattern(128, 8);
      const p4 = new Pattern(128, 8);
      const p5 = new Pattern(128, 8);
      const p6 = new Pattern(128, 8);
      const p7 = new Pattern(128, 8);
      const p8 = new Pattern(128, 8);
      const p9 = new Pattern(128, 8);

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_bass = 0, I_808 = 1, I_pad = 2, I_chime = 3, I_moog = 4;

      // Bass tab notation: Ab=44, G=43, Db=37, F=41, Eb=39, Bb=46, C=48, C_low=36, Bb_low=34, Eb_high=51
      const v1Bass = [
        [[0, 44], [14, 39]], // Bar 0: Ab -> Eb
        [[0, 43], [14, 37]], // Bar 1: G -> Db
        [[0, 41], [14, 39]], // Bar 2: F -> Eb
        [[0, 43], [8, 39], [10, 41], [12, 44], [14, 46]], // Bar 3: G -> Eb, F, Ab, Bb fill
        [[0, 44], [14, 39]], // Bar 4: Ab -> Eb
        [[0, 43], [14, 37]], // Bar 5: G -> Db
        [[0, 41], [14, 39]], // Bar 6: F -> Eb
        [[0, 43], [8, 39], [10, 41], [12, 44], [14, 48]], // Bar 7: G -> Eb, F, Ab, C fill
      ];

      const v2Bass = [
        [[0, 46], [14, 41]], // Bar 8: Bb -> F
        [[0, 44], [14, 37]], // Bar 9: Ab -> Db
        [[0, 39], [14, 37]], // Bar 10: Eb -> Db
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]], // Bar 11: Eb -> Eb, F, Ab, Bb fill
        [[0, 44], [14, 39]], // Bar 12: Ab -> Eb
        [[0, 43], [14, 36]], // Bar 13: G -> C (C-2=36)
        [[0, 37], [14, 34]], // Bar 14: Db -> Bb (Bb-1=34)
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]], // Bar 15: Eb -> Eb, F, Ab, Bb fill
      ];

      const chorusBass = [
        [[0, 44], [14, 39]], // Bar 0: Ab -> Eb
        [[0, 43], [14, 36]], // Bar 1: G -> C
        [[0, 37], [14, 34]], // Bar 2: Db -> Bb
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]], // Bar 3: Eb -> Eb, F, Ab, Bb fill
        [[0, 44], [14, 39]], // Bar 4: Ab -> Eb
        [[0, 43], [14, 36]], // Bar 5: G -> C
        [[0, 37], [14, 34]], // Bar 6: Db -> Bb
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]], // Bar 7: Eb -> Eb, F, Ab, Bb fill
      ];

      const bridgeBass = [
        [[0, 44], [14, 39]], // Bar 0: Ab -> Eb
        [[0, 43], [14, 37]], // Bar 1: G -> Db
        [[0, 41], [14, 39]], // Bar 2: F -> Eb
        [[0, 43], [8, 43], [12, 44]], // Bar 3: G -> G -> Ab
        [[0, 46], [14, 44]], // Bar 4: Bb -> Ab
        [[0, 43], [14, 39]], // Bar 5: G -> Eb
        [[0, 37], [14, 37]], // Bar 6: Db -> Db
        [[0, 44], [14, 44]], // Bar 7: Ab -> Ab
        [[0, 46], [14, 44]], // Bar 8: Bb -> Ab
        [[0, 43], [14, 39]], // Bar 9: G -> Eb
        [[0, 37], [14, 37]], // Bar 10: Db -> Db
        [[0, 44], [14, 44]], // Bar 11: Ab -> Ab
        [[0, 46], [4, 41], [14, 34]], // Bar 12: Bb -> F -> Bb_low
        [], // Bar 13: Silent/Sustain
        [[0, 51], [4, 46], [14, 39]], // Bar 14: Eb_high -> Bb -> Eb
        [[8, 39], [10, 41], [12, 44], [14, 46]], // Bar 15: Eb, F, Ab, Bb fill
      ];

      // Chord voicings for pads (root, third, fifth)
      const v1Chords = [
        [56, 60, 63], // Ab major
        [55, 58, 62], // G minor
        [53, 56, 60], // F minor
        [55, 58, 62], // G minor
        [56, 60, 63], // Ab major
        [55, 58, 62], // G minor
        [53, 56, 60], // F minor
        [55, 58, 62], // G minor
      ];

      const v2Chords = [
        [58, 62, 65], // Bb major
        [56, 60, 63], // Ab major
        [51, 55, 58], // Eb major
        [51, 55, 58], // Eb major
        [56, 60, 63], // Ab major
        [51, 55, 60], // C minor
        [49, 53, 56], // Db major
        [51, 55, 58], // Eb major
      ];

      const chorusChords = [
        [56, 60, 63], // Ab major
        [51, 55, 60], // C minor
        [49, 53, 56], // Db major
        [51, 55, 58], // Eb major
        [56, 60, 63], // Ab major
        [51, 55, 60], // C minor
        [49, 53, 56], // Db major
        [51, 55, 58], // Eb major
      ];

      const bridgeChords = [
        [56, 60, 63], // Ab major
        [55, 58, 62], // G minor
        [53, 56, 60], // F minor
        [55, 58, 62], // G minor
        [58, 62, 65], // Bb major
        [55, 58, 62], // G minor
        [49, 53, 56], // Db major
        [56, 60, 63], // Ab major
        [58, 62, 65], // Bb major
        [55, 58, 62], // G minor
        [49, 53, 56], // Db major
        [56, 60, 63], // Ab major
        [58, 62, 65], // Bb major
        [58, 62, 65], // Bb major
        [51, 55, 58], // Eb major
        [51, 55, 58], // Eb major
      ];

      const writeBass = (pat, barsArray, transpose = 0) => {
        barsArray.forEach((bar, barIdx) => {
          const startRow = barIdx * 16;
          bar.forEach(([offset, note]) => {
            pat.set(startRow + offset, 3, note + transpose + 12, I_bass, 0.88);
          });
        });
      };

      const writePads = (pat, chordsArray, transpose = 0) => {
        chordsArray.forEach((chord, barIdx) => {
          const startRow = barIdx * 16;
          chord.forEach(note => {
            pat.set(startRow, 4, note + transpose, I_pad, 0.58);
          });
          pat.set(startRow + 14, 4, OFF, I_pad);
        });
      };

      const setGatedDrums = (pat, hasKick, hasSnare, hasHats) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (hasKick) {
            if (step === 0 || step === 10) {
              pat.set(r, 0, BD, I_808, 0.95);
            }
          }
          if (hasSnare) {
            if (step === 4 || step === 12) {
              pat.set(r, 1, SD, I_808, 0.85);
            }
          }
          if (hasHats) {
            if (step === 2 || step === 6 || step === 10 || step === 14) {
              pat.set(r, 2, OH, I_808, 0.45);
            } else if (step % 4 === 0) {
              pat.set(r, 2, HH, I_808, 0.3);
            }
          }
        }
      };

      const setChimeMelody = (pat, ch, inst, vol = 0.7, transpose = 0) => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          const bar = Math.floor(r / 16);
          
          if (step === 2 || step === 10) {
            let note = 74; // D-5
            if (bar === 3 || bar === 7) note = 72; // C-5
            pat.set(r, ch, note + transpose, inst, vol);
          } else if (step === 4 || step === 8 || step === 12) {
            let note = 77; // F-5
            if (bar === 6) note = 75; // Eb-5
            pat.set(r, ch, note + transpose, inst, vol);
          } else if (step === 6 || step === 14) {
            let note = 82; // Bb-5
            if (bar === 1 || bar === 7) note = 81; // A-5
            else if (bar === 2) note = 79; // G-5
            else if (bar === 4) note = 77; // F-5
            else if (bar === 5) note = 82; // Bb-5
            else if (bar === 6) note = 79; // G-5
            pat.set(r, ch, note + transpose, inst, vol);
          } else if (step === 3 || step === 5 || step === 7 || step === 9 || step === 11 || step === 13 || step === 15) {
            pat.set(r, ch, OFF, inst);
          }
        }
      };

      const setSoaringMoog = (pat, ch, inst, vol = 0.7, transpose = 0) => {
        const lead = [
          82, 82, 81, 81, 79, 79, 77, 77,
          75, 75, 77, 77, 79, 79, 81, 81
        ];
        for (let r = 0; r < 128; r += 8) {
          const step = Math.floor(r / 8) % lead.length;
          pat.set(r, ch, lead[step] + 12 + transpose, inst, vol);
          pat.set(r + 6, ch, OFF, inst);
        }
      };

      // p0: Intro Part 1 (Bass + Pads only)
      writeBass(p0, v1Bass);
      writePads(p0, v1Chords);

      // p1: Intro Part 2 (Add Chime Lead Hook)
      writeBass(p1, v1Bass);
      writePads(p1, v1Chords);
      setChimeMelody(p1, 5, I_chime, 0.7);

      // p2: Verse 1 (Add kick/hats)
      setGatedDrums(p2, true, false, true);
      writeBass(p2, v1Bass);
      writePads(p2, v1Chords);
      setChimeMelody(p2, 5, I_chime, 0.7);

      // p3: Verse 2 (Full Gated Drums + Bass Part 2)
      setGatedDrums(p3, true, true, true);
      writeBass(p3, v2Bass);
      writePads(p3, v2Chords);
      setChimeMelody(p3, 5, I_chime, 0.65);

      // p4: Chorus (Melody up 1 octave)
      setGatedDrums(p4, true, true, true);
      writeBass(p4, chorusBass);
      writePads(p4, chorusChords);
      setChimeMelody(p4, 5, I_chime, 0.75, 12);

      // p5: Bridge Part 1
      writeBass(p5, bridgeBass.slice(0, 8));
      writePads(p5, bridgeChords.slice(0, 8));

      // p6: Bridge Part 2 (Drum build-up at the end)
      setGatedDrums(p6, false, false, true);
      writeBass(p6, bridgeBass.slice(8, 16));
      writePads(p6, bridgeChords.slice(8, 16));
      for (let r = 96; r < 128; r++) {
        if (r % 2 === 0 || r >= 112) {
          p6.set(r, 1, SD, I_808, 0.4 + ((r - 96) / 32) * 0.55);
        }
      }

      // p7: Key Change Verse (Ab Major -> B Major, +3 transposition)
      setGatedDrums(p7, true, true, true);
      writeBass(p7, v1Bass, 3);
      writePads(p7, v1Chords, 3);
      setChimeMelody(p7, 5, I_chime, 0.7, 3);

      // p8: Key Change Climax (B Major Drop, Moog soaring solo)
      setGatedDrums(p8, true, true, true);
      writeBass(p8, v2Bass, 3);
      writePads(p8, v2Chords, 3);
      setChimeMelody(p8, 5, I_chime, 0.75, 15); // +12 octave + 3 transposition = +15!
      setSoaringMoog(p8, 6, I_moog, 0.75, 3);

      // p9: Key Change Outro (Decay)
      setGatedDrums(p9, true, false, false);
      writeBass(p9, chorusBass.slice(0, 4), 3);
      writePads(p9, chorusChords.slice(0, 4), 3);

      return {
        patterns: [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9],
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Nonconsensual Assisted Suicide",
    bpm: 78,
    params: [
      // 0: DX7 Lush Pad — wide ethereal FM pad with long release
      {
        name: "DX7 Lush Pad",
        type: "dx7",
        p0: [1, 1.5, 2.0, 0.35],
        p1: [1, 0.7, 0.95, 2],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 3,  decay: 3.5,  mode: 0, sustain: 0.85, release: 2.5 },
          { coarse: 2.0, fine: 1, level: 75, detune: -3, decay: 3.8,  mode: 0, sustain: 0.80, release: 2.8 },
          { coarse: 1.0, fine: 0, level: 60, detune: 7,  decay: 4.0,  mode: 0, sustain: 0.75, release: 3.0 },
          { coarse: 3.0, fine: 0, level: 45, detune: 0,  decay: 2.5,  mode: 0, sustain: 0.60, release: 2.0 },
          { coarse: 5.0, fine: 0, level: 30, detune: -1, decay: 1.5,  mode: 0, sustain: 0.40, release: 1.5 },
          { coarse: 4.0, fine: 0, level: 20, detune: 2,  decay: 1.0,  mode: 0, sustain: 0.30, release: 1.0 }
        ]
      },
      // 1: Moog Warm Bass — deep, rounded, slow filter
      { name: "Moog Warm Bass", type: "moog", p0: [180, 0.15, 0.7, 0], p1: [2.0, 0.95, 0.8, 1.2] },
      // 2: 303 Shimmer — high cutoff, low res, airy texture
      { name: "303 Shimmer", type: "303", p0: [1800, 0.25, 0.3, 0.15], p1: [1.0, 0.1, 0.6, 0] },
      // 3: DX7 Bell Arp — glassy FM bells for arpeggiated sparkle
      {
        name: "DX7 Glass Bell",
        type: "dx7",
        p0: [1, 4.0, 5.0, 0.5],
        p1: [1, 0.5, 0.7, 5],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0,  decay: 1.2,  mode: 0, sustain: 0.20, release: 1.8 },
          { coarse: 4.0, fine: 0, level: 70, detune: 1,  decay: 0.8,  mode: 0, sustain: 0.10, release: 1.5 },
          { coarse: 7.0, fine: 0, level: 50, detune: -1, decay: 0.5,  mode: 0, sustain: 0.05, release: 1.0 },
          { coarse: 11.0,fine: 0, level: 35, detune: 2,  decay: 0.3,  mode: 0, sustain: 0.0,  release: 0.8 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5,  mode: 0, sustain: 0.5,  release: 0.25 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5,  mode: 0, sustain: 0.5,  release: 0.25 }
        ]
      },
      // 4: Moog Ethereal Sub — very low cutoff sub-pad drone
      { name: "Moog Ethereal Sub", type: "moog", p0: [120, 0.08, 0.85, 0], p1: [1.0, 0.98, 1.2, 1.5] },
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { chorusMix: 0.6, chorusRate: 0.5, chorusDepth: 3.5, delayMix: 0.45, delayTime: 0.6, delayFeedback: 0.55, reverbMix: 0.7, reverbDecay: 0.95 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.5, chorusRate: 0.4, chorusDepth: 3.0, delayMix: 0.4, delayTime: 0.5, delayFeedback: 0.45, reverbMix: 0.75, reverbDecay: 0.95 }),
      '808': defaultFxParams(),
      'moog': Object.assign(defaultFxParams(), { chorusMix: 0.35, chorusRate: 0.3, chorusDepth: 2.5, delayMix: 0.3, delayTime: 0.45, delayFeedback: 0.4, reverbMix: 0.65, reverbDecay: 0.93 }),
    },
    data: () => {
      // 8 patterns × 128 rows × 8 channels = ~5:15 at 78 BPM
      // No drums. Dreamy, atmospheric, warm, uplifting.
      //
      // Key: D major
      // Chord progressions:
      //   Verse:   D  - Bm  - G  - A      (I  - vi - IV - V)
      //   Bridge:  Em - G   - A  - F#m    (ii - IV - V  - iii)
      //   Climax:  D  - A   - Bm - G      (I  - V  - vi - IV)
      //   Outro:   G  - A   - D  - D      (IV - V  - I  - I)

      const CH = 8;
      const I_pad = 0, I_bass = 1, I_shimmer = 2, I_bell = 3, I_sub = 4;

      const p = [];
      for (let i = 0; i < 8; i++) p.push(new Pattern(128, CH));

      // --- MIDI note references ---
      // D2=38, E2=40, F#2=42, G2=43, A2=45, B2=47
      // D3=50, E3=52, F#3=54, G3=55, A3=57, B3=59
      // D4=62, E4=64, F#4=66, G4=67, A4=69, B4=71
      // D5=74, E5=76, F#5=78, G5=79, A5=81, B5=83

      // Chord voicings (mid register, 3 notes)
      const chords = {
        D:   [62, 66, 69],  // D4, F#4, A4
        Bm:  [59, 62, 66],  // B3, D4, F#4
        G:   [55, 59, 62],  // G3, B3, D4
        A:   [57, 61, 64],  // A3, C#4, E4
        Em:  [52, 55, 59],  // E3, G3, B3
        Fm:  [54, 57, 61],  // F#3, A3, C#4
      };

      // High voicings for shimmer layer (octave up)
      const highChords = {
        D:   [74, 78, 81],  // D5, F#5, A5
        Bm:  [71, 74, 78],  // B4, D5, F#5
        G:   [67, 71, 74],  // G4, B4, D5
        A:   [69, 73, 76],  // A4, C#5, E5
        Em:  [64, 67, 71],  // E4, G4, B4
        Fm:  [66, 69, 73],  // F#4, A4, C#5
      };

      // Bass notes (octave 2-3)
      const bassNotes = {
        D: 38, Bm: 47, G: 43, A: 45, Em: 40, Fm: 42,
      };

      // Sub-bass drone notes (octave 1-2)
      const subNotes = {
        D: 38, Bm: 35, G: 31, A: 33, Em: 28, Fm: 30,
      };

      // --- Helper: write sustained pad chords across a pattern ---
      const writePadChords = (pat, progression, vol = 0.5) => {
        progression.forEach((chordName, barIdx) => {
          const startRow = barIdx * 16;
          const chord = chords[chordName];
          // Sustain for full bar, release on last row
          chord.forEach((note, ni) => {
            pat.set(startRow, 0 + ni, note, I_pad, vol);  // spread across ch 0,1,2
          });
          // Note-off just before next chord
          if (barIdx < progression.length - 1) {
            chord.forEach((_, ni) => {
              pat.set(startRow + 15, 0 + ni, OFF, I_pad);
            });
          } else {
            // Last bar: let ring to end
            chord.forEach((_, ni) => {
              pat.set(127, 0 + ni, OFF, I_pad);
            });
          }
        });
      };

      // --- Helper: write bass line (whole notes with gentle movement) ---
      const writeBassLine = (pat, progression, vol = 0.65) => {
        progression.forEach((chordName, barIdx) => {
          const startRow = barIdx * 16;
          const rootNote = bassNotes[chordName];
          // Root on beat 1
          pat.set(startRow, 3, rootNote, I_bass, vol);
          // Gentle octave movement on beat 3
          pat.set(startRow + 8, 3, rootNote + 12, I_bass, vol * 0.8);
          // Walk to next note on beat 4.5
          if (barIdx < progression.length - 1) {
            const nextRoot = bassNotes[progression[barIdx + 1]];
            // approach note: chromatic step below next root
            pat.set(startRow + 14, 3, nextRoot - 1, I_bass, vol * 0.5);
          }
        });
      };

      // --- Helper: write sub-bass drone (one per 2 bars, very slow) ---
      const writeSubDrone = (pat, progression, vol = 0.4) => {
        for (let barIdx = 0; barIdx < progression.length; barIdx += 2) {
          const startRow = barIdx * 16;
          const note = subNotes[progression[barIdx]];
          pat.set(startRow, 7, note, I_sub, vol);
          // Release after 2 bars
          pat.set(startRow + 31, 7, OFF, I_sub);
        }
      };

      // --- Helper: write shimmer arpeggios ---
      const writeShimmerArp = (pat, progression, vol = 0.3) => {
        progression.forEach((chordName, barIdx) => {
          const startRow = barIdx * 16;
          const notes = highChords[chordName];
          // Gentle arpeggio: hit every 4th row, cycling through chord tones
          for (let step = 0; step < 16; step += 4) {
            const noteIdx = (step / 4) % notes.length;
            pat.set(startRow + step, 4, notes[noteIdx], I_shimmer, vol);
            pat.set(startRow + step + 3, 4, OFF, I_shimmer);
          }
        });
      };

      // --- Helper: write bell melody (sparse, dreamy) ---
      const writeBellMelody = (pat, melody, vol = 0.35) => {
        // melody: array of [row, note, duration]
        melody.forEach(([row, note, dur]) => {
          pat.set(row, 5, note, I_bell, vol);
          if (dur) pat.set(row + dur, 5, OFF, I_bell);
        });
      };

      // --- Progressions per section ---
      const verse =  ['D', 'Bm', 'G', 'A',  'D', 'Bm', 'G', 'A'];
      const bridge = ['Em', 'G', 'A', 'Fm', 'Em', 'G', 'A', 'Fm'];
      const climax = ['D', 'A', 'Bm', 'G',  'D', 'A', 'Bm', 'G'];
      const outro =  ['G', 'A', 'D', 'D',   'G', 'A', 'D', 'D'];

      // --- Bell melodies (sparse, pentatonic, yearning) ---
      // Notes from D major pentatonic: D4=62, E4=64, F#4=66, A4=69, B4=71
      //                                 D5=74, E5=76, F#5=78, A5=81
      const bellMelody1 = [
        [4,  78, 6],   // F#5
        [16, 81, 8],   // A5
        [32, 74, 6],   // D5
        [48, 76, 10],  // E5
        [68, 78, 6],   // F#5
        [80, 81, 10],  // A5
        [100, 74, 6],  // D5
        [112, 78, 10], // F#5
      ];

      const bellMelody2 = [
        [0,  81, 10],  // A5
        [20, 78, 6],   // F#5
        [32, 83, 8],   // B5
        [48, 81, 10],  // A5
        [64, 74, 8],   // D5
        [80, 76, 6],   // E5
        [96, 78, 10],  // F#5
        [112, 81, 12], // A5
      ];

      const bellMelody3 = [
        [8,  74, 8],   // D5
        [24, 78, 6],   // F#5
        [40, 81, 10],  // A5
        [56, 83, 8],   // B5
        [72, 86, 12],  // D6
        [96, 83, 8],   // B5
        [112, 81, 12], // A5
      ];

      const bellMelodyOutro = [
        [0,  78, 12],  // F#5
        [24, 74, 12],  // D5
        [48, 69, 16],  // A4 — lower, fading
        [80, 66, 16],  // F#4
        [112, 62, 16], // D4 — final settling note
      ];

      // ===== Pattern 0: Awakening — sub drone + very quiet pads =====
      writeSubDrone(p[0], verse, 0.35);
      writePadChords(p[0], verse, 0.2);

      // ===== Pattern 1: Breathing — pads swell, bass enters gently =====
      writePadChords(p[1], verse, 0.4);
      writeBassLine(p[1], verse, 0.45);
      writeSubDrone(p[1], verse, 0.35);

      // ===== Pattern 2: Unfolding — shimmer arps + first bell notes =====
      writePadChords(p[2], verse, 0.5);
      writeBassLine(p[2], verse, 0.6);
      writeSubDrone(p[2], verse, 0.35);
      writeShimmerArp(p[2], verse, 0.2);
      writeBellMelody(p[2], bellMelody1, 0.3);

      // ===== Pattern 3: Yearning — bridge chords, fuller texture =====
      writePadChords(p[3], bridge, 0.55);
      writeBassLine(p[3], bridge, 0.65);
      writeSubDrone(p[3], bridge, 0.4);
      writeShimmerArp(p[3], bridge, 0.28);
      writeBellMelody(p[3], bellMelody2, 0.35);

      // ===== Pattern 4: Ardor — climax chords, everything full =====
      writePadChords(p[4], climax, 0.6);
      writeBassLine(p[4], climax, 0.7);
      writeSubDrone(p[4], climax, 0.45);
      writeShimmerArp(p[4], climax, 0.35);
      writeBellMelody(p[4], bellMelody3, 0.4);

      // ===== Pattern 5: Rapture — repeat climax, higher bell melody =====
      writePadChords(p[5], climax, 0.6);
      writeBassLine(p[5], climax, 0.7);
      writeSubDrone(p[5], climax, 0.45);
      writeShimmerArp(p[5], climax, 0.35);
      // Transpose bell melody up a 4th for soaring effect
      writeBellMelody(p[5], bellMelody3.map(([r, n, d]) => [r, n + 5, d]), 0.4);

      // ===== Pattern 6: Afterglow — return to verse, gentle descent =====
      writePadChords(p[6], verse, 0.45);
      writeBassLine(p[6], verse, 0.5);
      writeSubDrone(p[6], verse, 0.35);
      writeShimmerArp(p[6], verse, 0.22);
      writeBellMelody(p[6], bellMelody1, 0.28);

      // ===== Pattern 7: Dissolution — outro, fade to sub drone =====
      writePadChords(p[7], outro, 0.3);
      writeBassLine(p[7], outro, 0.35);
      writeSubDrone(p[7], outro, 0.3);
      writeBellMelody(p[7], bellMelodyOutro, 0.25);

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Antiseptik USA",
    bpm: 120,
    params: [
      // 0: DX7 Glass String — bright, swelling digital string pad
      {
        name: "DX7 Glass String",
        type: "dx7",
        p0: [1, 2.5, 3.0, 0.5],
        p1: [5, 0.6, 0.85, 3], // Algorithm 5, feedback 3
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 2,  decay: 2.5,  mode: 0, sustain: 0.8,  release: 1.8 },
          { coarse: 1.0, fine: 2, level: 78, detune: -2, decay: 2.0,  mode: 0, sustain: 0.7,  release: 1.5 },
          { coarse: 2.0, fine: 0, level: 90, detune: 4,  decay: 1.8,  mode: 0, sustain: 0.75, release: 1.6 },
          { coarse: 3.0, fine: 0, level: 55, detune: -3, decay: 1.2,  mode: 0, sustain: 0.5,  release: 1.0 },
          { coarse: 0.5, fine: 0, level: 95, detune: 5,  decay: 3.0,  mode: 0, sustain: 0.9,  release: 2.0 },
          { coarse: 1.0, fine: 0, level: 65, detune: 0,  decay: 2.2,  mode: 0, sustain: 0.6,  release: 1.4 }
        ]
      },
      // 1: 303 Liquid Pluck — clean, warm resonant pluck
      { name: "303 Liquid Pluck", type: "303", p0: [650, 0.45, 0.5, 0.2], p1: [1.0, 0.35, 0.45, 0] },
      // 2: 808 Clean Kit — punchy, tight TR-808
      { name: "808 Clean Kit", type: "808", p0: [0, 0.5, 0.45, 0.6], p1: [0, 0, 0, 0] },
      // 3: Moog Warm Bass — deep, rounded analog bass
      { name: "Moog Warm Bass", type: "moog", p0: [150, 0.1, 0.75, 0], p1: [2.0, 0.95, 0.7, 1.0] },
      // 4: Moog Soaring Lead — expressive lead synth with sliding feel
      { name: "Moog Soaring Lead", type: "moog", p0: [900, 0.35, 0.45, 0], p1: [15.0, 0.6, 0.8, 0.6] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, delayMix: 0.4, chorusMix: 0.4 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.55, chorusRate: 1.2, delayMix: 0.35, reverbMix: 0.6, reverbDecay: 0.93 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false }),
      'moog': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, chorusMix: 0.3, delayMix: 0.3, reverbMix: 0.35 }),
    },
    data: () => {
      // 12 patterns * 128 rows * 8 channels = 1536 rows.
      // At 120 BPM and 4 rows per beat, 1 pattern is 16.0 seconds.
      // 12 patterns total is 192.0 seconds (exactly 3 minutes and 0 seconds).
      const p = [];
      for (let i = 0; i < 12; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39, RIM = 37;
      const I_pad = 0, I_303 = 1, I_808 = 2, I_bass = 3, I_lead = 4;

      // progression:
      // Dreamy (Minor): Am7 -> Fmaj7 -> D7 -> Esus4 (patterns 0-4, and 10)
      // Climax (Major): Amaj7 -> B7 -> C#m7 -> F#m7 (patterns 5-9)
      const minorProg = ['Am7', 'Fmaj7', 'D7', 'Esus4', 'Am7', 'Fmaj7', 'D7', 'Esus4'];
      const majorProg = ['Amaj7', 'B7', 'C#m7', 'F#m7', 'Amaj7', 'B7', 'C#m7', 'F#m7'];

      const minorVoicings = {
        Am7: [57, 60, 64],
        Fmaj7: [53, 57, 60],
        D7: [54, 57, 60],
        Esus4: [52, 57, 59]
      };
      const majorVoicings = {
        Amaj7: [57, 61, 64, 68],
        B7: [59, 63, 66, 69],
        "C#m7": [56, 59, 64],
        "F#m7": [54, 57, 61]
      };

      const minorBass = { Am7: 45, Fmaj7: 41, D7: 38, Esus4: 40 };
      const majorBass = { Amaj7: 45, B7: 47, "C#m7": 37, "F#m7": 42 };

      // Helper to write ambient pads and bass drones
      const writePadsAndBass = (pat, isMajor = false, volP = 0.45, volB = 0.65) => {
        const prog = isMajor ? majorProg : minorProg;
        const voicings = isMajor ? majorVoicings : minorVoicings;
        const bass = isMajor ? majorBass : minorBass;
        const padChannels = [0, 3, 4, 7];

        prog.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];

          // Clear any pad channels for this bar first to ensure clean state
          padChannels.forEach(ch => {
            for (let step = 0; step < 16; step++) {
              pat.clear(start + step, ch);
            }
          });

          // Arpeggiate the pad voicing on channels 0, 3, 4, 7
          for (let step = 0; step < 16; step += 2) {
            const i = step / 2;
            const noteIndex = i % voicing.length;
            // Introduce a subtle 2-octave climbing arpeggiation for richness
            const isHighOctave = Math.floor(i / voicing.length) % 2 === 1;
            const note = voicing[noteIndex] + 12 + (isHighOctave ? 12 : 0);
            const channel = padChannels[i % padChannels.length];

            pat.set(start + step, channel, note, I_pad, volP);
            // Let each note ring for 3 steps (so it overlaps slightly with the next 8th note)
            const offRow = start + step + 3;
            if (offRow < pat.rows) {
              pat.set(offRow, channel, OFF, I_pad);
            }
          }

          // Bass drone on channel 5
          pat.set(start, 5, bass[chordName], I_bass, volB);
          pat.set(start + 15, 5, OFF, I_bass);
        });
      };

      // Helper to write driving, rhythmic bass for Climax
      const writeDrivingBass = (pat, isMajor = false, vol = 0.7) => {
        const prog = isMajor ? majorProg : minorProg;
        const bass = isMajor ? majorBass : minorBass;

        prog.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const root = bass[chordName];
          for (let step = 0; step < 16; step += 2) {
            const isOctave = (step % 4 === 2);
            pat.set(start + step, 5, isOctave ? root + 12 : root, I_bass, vol);
            pat.set(start + step + 1, 5, OFF, I_bass);
          }
        });
      };

      // Helper to write smooth 303 arpeggiated lines
      const write303Pluck = (pat, isMajor = false, density = 0.5, vol = 0.65) => {
        const prog = isMajor ? majorProg : minorProg;
        const voicings = isMajor ? majorVoicings : minorVoicings;

        prog.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];
          const notes = voicing.map(n => n + 24); // High register arpeggios
          const threshold = Math.round(density * 10);
          for (let step = 0; step < 16; step += 2) {
            if (((step * 7 + barIdx * 3) % 10) < threshold) {
              const note = notes[step % notes.length];
              pat.set(start + step, 1, note, I_303, vol);
              pat.set(start + step + 1, 1, OFF, I_303);
            }
          }
        });
      };

      // Helper to write clean 808 drum patterns
      const writeDrums = (pat, style = 'dreamy') => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (style === 'dreamy') {
            // Gentle rhythmic groove (rimshot, hats, light kick)
            if (step === 0 || (step === 10 && r % 32 === 16)) {
              pat.set(r, 2, BD, I_808, 0.85);
            }
            if (step === 4 || step === 12) {
              pat.set(r, 2, RIM, I_808, 0.6);
            }
            if (step % 4 === 2) {
              pat.set(r, 2, HH, I_808, 0.45);
            }
          } else if (style === 'climax') {
            // Heavy driving 4-on-the-floor kick, double-time hats, clean clap
            if (step === 0 || step === 4 || step === 8 || step === 12) {
              pat.set(r, 2, BD, I_808, 0.95);
            }
            if (step === 4 || step === 12) {
              pat.set(r, 2, CLAP, I_808, 0.85);
            }
            if (step % 2 === 0) {
              pat.set(r, 2, HH, I_808, 0.55);
            }
          } else if (style === 'half-time') {
            // Half-time pop/trap groove for bipolar drop (kick on 1, snare on 3)
            if (step === 0 || step === 6 || step === 14) {
              pat.set(r, 2, BD, I_808, 0.95);
            }
            if (step === 8) {
              pat.set(r, 2, SD, I_808, 0.85);
            }
            if (step % 2 === 0) {
              pat.set(r, 2, HH, I_808, 0.55);
            }
            if (step === 10 || step === 14) {
              pat.set(r, 2, OH, I_808, 0.4);
            }
          }
        }
      };

      // Helper to write expressive lead melodies on the Moog
      const writeLead = (pat, melody, vol = 0.72) => {
        melody.forEach(([row, note, dur]) => {
          pat.set(row, 6, note, I_lead, vol);
          if (dur) pat.set(row + dur, 6, OFF, I_lead);
        });
      };

      // ===== Pattern 0: Awakening (Intro) =====
      writePadsAndBass(p[0], false, 0.35, 0.5);

      // ===== Pattern 1: Blue Mist =====
      writePadsAndBass(p[1], false, 0.4, 0.55);
      writeDrums(p[1], 'dreamy');

      // ===== Pattern 2: Bathtub Crystal =====
      writePadsAndBass(p[2], false, 0.4, 0.6);
      writeDrums(p[2], 'dreamy');
      write303Pluck(p[2], false, 0.4, 0.6); // smooth arpeggio

      // ===== Pattern 3: The Weigh Scales =====
      writePadsAndBass(p[3], false, 0.45, 0.6);
      writeDrums(p[3], 'dreamy');
      write303Pluck(p[3], false, 0.6, 0.6);
      // Soaring lead introduction (dreamy, slow melody in A minor)
      writeLead(p[3], [
        [0, 57, 12], [16, 60, 12], [32, 64, 16], [64, 57, 12], [80, 60, 12], [96, 62, 24]
      ], 0.65);

      // ===== Pattern 4: Unplugged Ports =====
      writePadsAndBass(p[4], false, 0.45, 0.65);
      writeDrums(p[4], 'dreamy');
      write303Pluck(p[4], false, 0.5, 0.6);
      writeLead(p[4], [
        [0, 57, 12], [16, 60, 12], [32, 64, 16], [64, 69, 12], [80, 67, 12], [96, 64, 24]
      ], 0.65);

      // ===== Pattern 5: Adrenaline Pulse (Transition / Climax Entry) =====
      // Stark bipolar transition! Chords become Major, bass drives, drums go 4-on-the-floor
      writePadsAndBass(p[5], true, 0.45, 0.7);
      writeDrivingBass(p[5], true, 0.7);
      writeDrums(p[5], 'climax');
      write303Pluck(p[5], true, 0.7, 0.65);

      // ===== Pattern 6: Saline & Silicone Climax =====
      writePadsAndBass(p[6], true, 0.5, 0.7);
      writeDrivingBass(p[6], true, 0.7);
      writeDrums(p[6], 'climax');
      write303Pluck(p[6], true, 0.8, 0.65);
      // Energetic high melody in A Lydian
      writeLead(p[6], [
        [0, 61, 4], [8, 64, 4], [16, 68, 8], [32, 63, 4], [40, 66, 4], [48, 69, 8],
        [64, 64, 4], [72, 68, 4], [80, 71, 8], [96, 73, 4], [104, 71, 4], [112, 69, 12]
      ], 0.72);

      // ===== Pattern 7: Sexbot Climax =====
      writePadsAndBass(p[7], true, 0.5, 0.7);
      writeDrivingBass(p[7], true, 0.7);
      writeDrums(p[7], 'climax');
      write303Pluck(p[7], true, 0.75, 0.65);
      // Soaring Moog melody octave up in A Lydian
      writeLead(p[7], [
        [0, 73, 4], [8, 76, 4], [16, 80, 8], [32, 75, 4], [40, 78, 4], [48, 81, 8],
        [64, 76, 4], [72, 80, 4], [80, 83, 8], [96, 85, 4], [104, 83, 4], [112, 81, 12]
      ], 0.75);

      // ===== Pattern 8: Born Pregnant Drop =====
      // Drums switch to half-time pop/trap groove, bass keeps driving, keeping tension "hot"
      writePadsAndBass(p[8], true, 0.5, 0.7);
      writeDrivingBass(p[8], true, 0.7);
      writeDrums(p[8], 'half-time');
      write303Pluck(p[8], true, 0.6, 0.65);
      writeLead(p[8], [
        [0, 61, 12], [16, 64, 12], [32, 68, 16], [64, 61, 12], [80, 64, 12], [96, 69, 24]
      ], 0.72);

      // ===== Pattern 9: Climax Clatter =====
      writePadsAndBass(p[9], true, 0.5, 0.7);
      writeDrivingBass(p[9], true, 0.7);
      writeDrums(p[9], 'climax');
      write303Pluck(p[9], true, 0.8, 0.65);
      writeLead(p[9], [
        [0, 73, 4], [8, 76, 4], [16, 80, 8], [32, 75, 4], [40, 78, 4], [48, 81, 8],
        [64, 76, 4], [72, 80, 4], [80, 83, 8], [96, 85, 4], [104, 83, 4], [112, 81, 12]
      ], 0.75);

      // ===== Pattern 10: The Posthuman Kiss =====
      // Return to quiet, dreamy minor progression (A minor)
      writePadsAndBass(p[10], false, 0.45, 0.6);
      writeDrums(p[10], 'dreamy');
      write303Pluck(p[10], false, 0.4, 0.6);
      // Melancholic final melody in A minor
      writeLead(p[10], [
        [0, 57, 12], [16, 52, 12], [32, 53, 12], [48, 45, 16],
        [64, 57, 12], [80, 60, 12], [96, 55, 12], [112, 52, 16]
      ], 0.7);

      // ===== Pattern 11: Sunset (Outro) =====
      writePadsAndBass(p[11], false, 0.35, 0.45);
      writeLead(p[11], [[0, 57, 32]], 0.5); // final A note decaying away

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Lance's Left Nut",
    bpm: 125,
    params: [
      // 0: DX7 Retro Brass — lush, detuned analog brass pad
      {
        name: "DX7 Retro Brass",
        type: "dx7",
        p0: [1.0, 1.0, 2.5, 0.4],
        p1: [12, 0.4, 0.6, 0], // Algorithm 12
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 4,  decay: 1.5, mode: 0, sustain: 0.85, release: 1.5 },
          { coarse: 1.0, fine: 1, level: 90, detune: -4, decay: 1.2, mode: 0, sustain: 0.8,  release: 1.2 },
          { coarse: 2.0, fine: 0, level: 85, detune: 5,  decay: 1.0, mode: 0, sustain: 0.75, release: 1.0 },
          { coarse: 2.0, fine: 2, level: 75, detune: -5, decay: 0.8, mode: 0, sustain: 0.7,  release: 0.8 },
          { coarse: 0.5, fine: 0, level: 95, detune: 2,  decay: 2.0, mode: 0, sustain: 0.9,  release: 1.8 },
          { coarse: 1.0, fine: 0, level: 65, detune: 0,  decay: 1.5, mode: 0, sustain: 0.6,  release: 1.0 }
        ]
      },
      // 1: 303 Bouncy Pluck — bubbly Vince Clarke / Erasure style pluck
      { name: "303 Bouncy Pluck", type: "303", p0: [800, 0.6, 0.4, 0.3], p1: [1.0, 0.2, 0.3, 0] },
      // 2: 808 Synthpop Kit — punchy Linn-style synthpop kit
      { name: "808 Synthpop Kit", type: "808", p0: [0, 0.55, 0.4, 0.5], p1: [0, 0, 0, 0] },
      // 3: Moog Funky Bass — John Taylor style active bass
      { name: "Moog Funky Bass", type: "moog", p0: [300, 0.25, 0.6, 0], p1: [4.0, 0.9, 0.65, 0.9] },
      // 4: Moog Britpop Lead — quirky Pulp/Blur style lead
      { name: "Moog Britpop Lead", type: "moog", p0: [1200, 0.4, 0.5, 0], p1: [12.0, 0.55, 0.75, 0.5] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, chorusMix: 0.45, delayMix: 0.35, delayFeedback: 0.45 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.65, chorusRate: 1.4, delayMix: 0.3, reverbMix: 0.55, reverbDecay: 0.92 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false }),
      'moog': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, chorusMix: 0.4, delayMix: 0.3, reverbMix: 0.35 }),
    },
    data: () => {
      const p = [];
      for (let i = 0; i < 12; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39, RIM = 37;
      const I_pad = 0, I_303 = 1, I_808 = 2, I_bass = 3, I_lead = 4;

      // Chord progressions:
      // Verse (Bm -> G -> Em -> F#)
      const verseProg = ['Bm', 'G', 'Em', 'F#', 'Bm', 'G', 'Em', 'F#'];
      // Chorus (D -> Bb -> C -> A)
      const chorusProg = ['D', 'Bb', 'C', 'A', 'D', 'Bb', 'C', 'A'];
      // Pre-Chorus / Bridge (G -> A -> G -> A)
      const bridgeProg = ['G', 'A', 'G', 'A', 'G', 'A', 'G', 'A'];

      const voicings = {
        Bm: [59, 62, 66, 71],
        G: [55, 59, 62, 67],
        Em: [52, 55, 59, 64],
        "F#": [54, 58, 61, 66],
        D: [50, 54, 57, 62, 66],
        Bb: [58, 62, 65, 70],
        C: [48, 52, 55, 60, 64],
        A: [57, 61, 64, 69]
      };

      const chordIntervals = {
        Bm: { root: 47, third: 50, fifth: 54, seventh: 57 },
        G: { root: 43, third: 47, fifth: 50, seventh: 54 },
        Em: { root: 40, third: 43, fifth: 47, seventh: 50 },
        "F#": { root: 42, third: 46, fifth: 49, seventh: 52 },
        D: { root: 50, third: 54, fifth: 57, seventh: 61 },
        Bb: { root: 46, third: 50, fifth: 53, seventh: 57 },
        C: { root: 48, third: 52, fifth: 55, seventh: 58 },
        A: { root: 45, third: 49, fifth: 52, seventh: 55 }
      };

      // 1. Pads: Lush DX7 chords.
      const writePads = (pat, progression, style = 'sustained', vol = 0.4) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];
          if (style === 'sustained') {
            voicing.forEach((note, ni) => {
              const ch = [0, 3, 4][ni % 3];
              pat.set(start, ch, note + 12, I_pad, vol);
              pat.set(start + 15, ch, OFF, I_pad);
            });
          } else {
            voicing.forEach((note, ni) => {
              const ch = [0, 3, 4][ni % 3];
              [0, 3, 6, 8, 11, 14].forEach(step => {
                pat.set(start + step, ch, note + 12, I_pad, vol);
                pat.set(start + step + 2, ch, OFF, I_pad);
              });
            });
          }
        });
      };

      // 2. Bass: Funky Moog analog bass with scale-degree awareness.
      const writeBass = (pat, progression, style = 'driving', vol = 0.7) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const chords = chordIntervals[chordName];
          if (style === 'driving') {
            const verseBassPattern = [
              [0, chords.root],
              [2, chords.root],
              [4, chords.fifth],
              [6, chords.fifth],
              [8, chords.root + 12],
              [10, chords.root + 12],
              [12, chords.root],
              [14, chords.seventh]
            ];
            verseBassPattern.forEach(([step, note]) => {
              pat.set(start + step, 5, note, I_bass, vol);
              pat.set(start + step + 1, 5, OFF, I_bass);
            });
          } else if (style === 'funky') {
            const funkyBassPattern = [
              [0, chords.root],
              [2, chords.root],
              [3, chords.root + 12],
              [6, chords.third],
              [8, chords.root],
              [10, chords.fifth],
              [12, chords.root + 12],
              [14, chords.seventh]
            ];
            funkyBassPattern.forEach(([step, note]) => {
              pat.set(start + step, 5, note, I_bass, vol);
              pat.set(start + step + 1, 5, OFF, I_bass);
            });
          } else {
            pat.set(start, 5, chords.root, I_bass, vol);
            pat.set(start + 15, 5, OFF, I_bass);
          }
        });
      };

      // 3. 303: bouncy 16th-note Erasure arpeggiation (Vince Clarke rhythmic skip)
      const writeErasureArp = (pat, progression, vol = 0.58) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];
          for (let step = 0; step < 16; step++) {
            if (step % 4 !== 3) {
              const noteIdx = step % voicing.length;
              const octave = (step % 8 >= 4) ? 12 : 0;
              const note = voicing[noteIdx] + 12 + octave;
              pat.set(start + step, 1, note, I_303, vol);
              pat.set(start + step + 1, 1, OFF, I_303);
            }
          }
        });
      };

      // 4. Drums: punchy synthpop drums.
      const writeDrums = (pat, style = 'synthpop') => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (style === 'basic') {
            if (step === 0 || step === 8) pat.set(r, 2, BD, I_808, 0.9);
            if (step === 4 || step === 12) pat.set(r, 2, SD, I_808, 0.75);
            if (step % 4 === 2) pat.set(r, 2, HH, I_808, 0.4);
          } else if (style === 'synthpop') {
            if (step === 0 || step === 8 || step === 10 || step === 13) pat.set(r, 2, BD, I_808, 0.95);
            if (step === 4 || step === 12) pat.set(r, 2, SD, I_808, 0.85);
            if (step === 12 && r % 32 >= 16) pat.set(r, 2, CLAP, I_808, 0.8);
            if (step % 2 === 0) pat.set(r, 2, HH, I_808, step % 4 === 2 ? 0.45 : 0.3);
            if (step === 6 || step === 14) pat.set(r, 2, OH, I_808, 0.5);
          } else if (style === 'duran') {
            if (step % 4 === 0) pat.set(r, 2, BD, I_808, 0.95);
            if (step === 4 || step === 12) {
              pat.set(r, 2, SD, I_808, 0.85);
              pat.set(r, 2, CLAP, I_808, 0.88);
            }
            if (step % 2 === 1) pat.set(r, 2, HH, I_808, 0.5);
            if (step === 2 || step === 6 || step === 10 || step === 14) {
              pat.set(r, 2, OH, I_808, 0.55);
            }
            if (step === 15) pat.set(r, 2, HH, I_808, 0.6);
          }
        }
      };

      const writeLead = (pat, melody, vol = 0.7) => {
        melody.forEach(([row, note, dur]) => {
          if (row < pat.rows) {
            pat.set(row, 6, note, I_lead, vol);
            if (dur && row + dur < pat.rows) {
              pat.set(row + dur, 6, OFF, I_lead);
            }
          }
        });
      };

      // Riffs & Melodies
      const verseMelody = [
        // Bar 0 (Bm)
        [0, 71, 4], [4, 69, 4], [8, 66, 6], [14, 62, 2],
        // Bar 1 (G)
        [16, 67, 8], [24, 69, 4], [28, 71, 4],
        // Bar 2 (Em)
        [32, 64, 4], [36, 67, 4], [40, 71, 8],
        // Bar 3 (F#)
        [48, 66, 8], [56, 69, 8],
        // Bar 4 (Bm)
        [64, 71, 4], [68, 69, 4], [72, 66, 6], [78, 62, 2],
        // Bar 5 (G)
        [80, 67, 8], [88, 69, 4], [92, 71, 4],
        // Bar 6 (Em)
        [96, 76, 8], [104, 74, 8],
        // Bar 7 (F#)
        [112, 73, 8], [120, 71, 8]
      ];

      const chorusMelody = [
        // Bar 0 (D)
        [0, 74, 6], [6, 76, 2], [8, 78, 6], [14, 81, 2],
        // Bar 1 (Bb)
        [16, 82, 8], [24, 80, 4], [28, 78, 4],
        // Bar 2 (C)
        [32, 80, 6], [38, 78, 2], [40, 76, 6], [46, 74, 2],
        // Bar 3 (A)
        [48, 73, 8], [56, 76, 8],
        // Bar 4 (D)
        [64, 86, 6], [70, 88, 2], [72, 90, 6], [78, 93, 2],
        // Bar 5 (Bb)
        [80, 94, 8], [88, 93, 4], [92, 90, 4],
        // Bar 6 (C)
        [96, 91, 6], [102, 90, 2], [104, 88, 6], [110, 86, 2],
        // Bar 7 (A)
        [112, 85, 8], [120, 88, 8]
      ];

      // ===== Pattern 0: Intro (Duran Duran Atmospheric Prelude) =====
      writePads(p[0], chorusProg, 'sustained', 0.4);
      writeBass(p[0], chorusProg, 'drone', 0.6);
      writeDrums(p[0], 'basic');
      writeLead(p[0], [
        [0, 62, 12], [16, 66, 12], [32, 69, 16], [64, 62, 12], [80, 66, 12], [96, 67, 24]
      ], 0.6);

      // ===== Pattern 1: Verse 1 (Pulp Quirky Entry) =====
      writePads(p[1], verseProg, 'sustained', 0.38);
      writeBass(p[1], verseProg, 'driving', 0.65);
      writeDrums(p[1], 'synthpop');
      writeLead(p[1], verseMelody, 0.7);

      // ===== Pattern 2: Verse 1 Cont. (Blur Guitars as Synths) =====
      writePads(p[2], verseProg, 'sustained', 0.4);
      writeBass(p[2], verseProg, 'driving', 0.68);
      writeDrums(p[2], 'synthpop');
      writeErasureArp(p[2], verseProg, 0.48);
      writeLead(p[2], verseMelody, 0.72);

      // ===== Pattern 3: Pre-Chorus (Erasure Gay Club Bounce) =====
      writePads(p[3], bridgeProg, 'sustained', 0.45);
      writeBass(p[3], bridgeProg, 'driving', 0.7);
      writeDrums(p[3], 'synthpop');
      writeErasureArp(p[3], bridgeProg, 0.58);

      // ===== Pattern 4: Chorus 1 (Duran Duran Rewrite) =====
      writePads(p[4], chorusProg, 'stabs', 0.48);
      writeBass(p[4], chorusProg, 'funky', 0.72);
      writeDrums(p[4], 'duran');
      writeErasureArp(p[4], chorusProg, 0.5);
      writeLead(p[4], chorusMelody, 0.75);

      // ===== Pattern 5: Chorus 1 Cont. =====
      writePads(p[5], chorusProg, 'stabs', 0.48);
      writeBass(p[5], chorusProg, 'funky', 0.72);
      writeDrums(p[5], 'duran');
      writeErasureArp(p[5], chorusProg, 0.5);
      writeLead(p[5], chorusMelody.map(([r, n, d]) => [r, n + 12, d]), 0.75);

      // ===== Pattern 6: Verse 2 (The Pulp & Blur Love Scene) =====
      writePads(p[6], verseProg, 'sustained', 0.4);
      writeBass(p[6], verseProg, 'driving', 0.68);
      writeDrums(p[6], 'synthpop');
      writeErasureArp(p[6], verseProg, 0.45);
      writeLead(p[6], verseMelody, 0.7);

      // ===== Pattern 7: Pre-Chorus 2 (The Erasure Warning) =====
      writePads(p[7], bridgeProg, 'sustained', 0.45);
      writeBass(p[7], bridgeProg, 'driving', 0.7);
      writeDrums(p[7], 'synthpop');
      writeErasureArp(p[7], bridgeProg, 0.58);

      // ===== Pattern 8: Chorus 2 =====
      writePads(p[8], chorusProg, 'stabs', 0.5);
      writeBass(p[8], chorusProg, 'funky', 0.74);
      writeDrums(p[8], 'duran');
      writeErasureArp(p[8], chorusProg, 0.55);
      writeLead(p[8], chorusMelody, 0.76);

      // ===== Pattern 9: Chorus 2 Cont. (Peak Climax) =====
      writePads(p[9], chorusProg, 'stabs', 0.5);
      writeBass(p[9], chorusProg, 'funky', 0.74);
      writeDrums(p[9], 'duran');
      writeErasureArp(p[9], chorusProg, 0.55);
      writeLead(p[9], chorusMelody.map(([r, n, d]) => [r, n + 12, d]), 0.78);

      // ===== Pattern 10: Bridge (Duran Duran Epic Build, Oasis Watching) =====
      writePads(p[10], bridgeProg, 'sustained', 0.52);
      writeBass(p[10], bridgeProg, 'drone', 0.75);
      writeDrums(p[10], 'duran');
      writeLead(p[10], [
        [0, 67, 24], [32, 69, 24], [64, 71, 24], [96, 73, 24]
      ], 0.78);

      // ===== Pattern 11: Outro (Fade Out) =====
      writePads(p[11], chorusProg, 'sustained', 0.4);
      writeBass(p[11], chorusProg, 'drone', 0.55);
      writeLead(p[11], [[0, 74, 32]], 0.6);

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Myfanwy Murder Party",
    bpm: 96,
    params: [
      // 0: DX7 Clean Pluck — acoustic guitar simulator
      {
        name: "DX7 Clean Pluck",
        type: "dx7",
        p0: [1.0, 1.0, 1.2, 0.2],
        p1: [5, 0.35, 0.4, 1], // Algorithm 5, feedback 1
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 2,  decay: 1.5, mode: 0, sustain: 0.0, release: 0.8 },
          { coarse: 1.0, fine: 1, level: 75, detune: -2, decay: 1.0, mode: 0, sustain: 0.0, release: 0.6 },
          { coarse: 2.0, fine: 0, level: 85, detune: 3,  decay: 0.8, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 3.0, fine: 0, level: 60, detune: -3, decay: 0.5, mode: 0, sustain: 0.0, release: 0.4 },
          { coarse: 0.5, fine: 0, level: 90, detune: 4,  decay: 2.0, mode: 0, sustain: 0.0, release: 1.0 },
          { coarse: 1.0, fine: 0, level: 50, detune: 0,  decay: 1.2, mode: 0, sustain: 0.0, release: 0.7 }
        ]
      },
      // 1: 303 Heavy Chug — distorted palm-mute synth simulating overdriven metal guitar
      { name: "303 Heavy Chug", type: "303", p0: [400, 0.85, 0.3, 0.45], p1: [1.0, 0.1, 0.25, 0] },
      // 2: 808 Bonham Kit — booming TR-808 rock kit
      { name: "808 Bonham Kit", type: "808", p0: [0, 0.6, 0.8, 0.4], p1: [0, 0, 0, 0] },
      // 3: Moog Growl Bass — deep, heavy grinding bass
      { name: "Moog Growl Bass", type: "moog", p0: [180, 0.15, 0.8, 0], p1: [2.0, 0.95, 0.8, 1.2] },
      // 4: Moog Rock Lead — screaming solo lead
      { name: "Moog Rock Lead", type: "moog", p0: [950, 0.3, 0.5, 0], p1: [15.0, 0.7, 0.75, 0.5] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: true, dist: 15.0, tone: 0.4, bitcrushOn: false, delayMix: 0.2, delayFeedback: 0.3, reverbMix: 0.3 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.5, chorusRate: 1.0, delayMix: 0.3, reverbMix: 0.45, reverbDecay: 0.88 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, reverbMix: 0.4, reverbDecay: 0.85 }),
      'moog': Object.assign(defaultFxParams(), { distOn: true, dist: 6.0, tone: 0.5, chorusMix: 0.35, delayMix: 0.3, reverbMix: 0.35 }),
    },
    data: () => {
      const p = [];
      for (let i = 0; i < 15; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39, RIM = 37;
      const I_pad = 0, I_303 = 1, I_808 = 2, I_bass = 3, I_lead = 4;

      // Descending folk progression
      const folkProg = ['Dm', 'C', 'Bb', 'A', 'Dm', 'C', 'Bb', 'A'];

      const cleanVoicings = {
        Dm: [50, 57, 62, 65],
        C: [48, 55, 60, 64],
        Bb: [46, 53, 58, 62],
        A: [45, 52, 57, 61]
      };

      const chordIntervals = {
        Dm: { root: 50, third: 53, fifth: 57, seventh: 60 },
        C: { root: 48, third: 52, fifth: 55, seventh: 58 },
        Bb: { root: 46, third: 50, fifth: 53, seventh: 56 },
        A: { root: 45, third: 49, fifth: 52, seventh: 55 }
      };

      // 1. Acoustic fingerpicking simulator (DX7 clean pluck on channels 0, 3, 4)
      const writeAcousticClean = (pat, progression, vol = 0.45) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = cleanVoicings[chordName];
          const pickSteps = [0, 2, 4, 6, 8, 10, 12, 14];
          const pickNotes = [0, 1, 2, 3, 2, 1, 2, 3];
          pickSteps.forEach((step, idx) => {
            const noteIdx = pickNotes[idx];
            const note = voicing[noteIdx];
            const ch = [0, 3, 4][idx % 3];
            pat.set(start + step, ch, note + 12, I_pad, vol);
            pat.set(start + step + 2, ch, OFF, I_pad);
          });
        });
      };

      // 2. Heavy syncopated Helmet guitar riff (distorted 303 power chords on channels 0 and 3)
      const writeHeavyHelmetRiff = (pat, vol = 0.72) => {
        const riffChords = [
          // Bar 0: D5 (root 38)
          [0, 38, 2], [2, 38, 1], [4, 41, 2], [8, 43, 2], [12, 44, 3],
          // Bar 1: D5
          [16, 38, 2], [18, 38, 1], [20, 41, 1], [22, 43, 1], [24, 41, 1], [26, 38, 3],
          // Bar 2: D5
          [32, 38, 2], [34, 38, 1], [36, 41, 2], [40, 43, 2], [44, 44, 3],
          // Bar 3: D5
          [48, 38, 2], [50, 38, 1], [52, 41, 1], [54, 43, 1], [56, 41, 1], [58, 38, 3]
        ];

        for (let i = 0; i < 2; i++) {
          const offset = i * 64;
          riffChords.forEach(([step, rootNote, dur]) => {
            pat.set(offset + step, 0, rootNote, I_303, vol);
            pat.set(offset + step, 3, rootNote + 7, I_303, vol * 0.95);
            pat.set(offset + step + dur, 0, OFF, I_303);
            pat.set(offset + step + dur, 3, OFF, I_303);
          });
        }
      };

      // 3. Heavy Growl Bass (Moog bass on channel 5)
      const writeHeavyBass = (pat, vol = 0.72) => {
        const riffBass = [
          [0, 26], [2, 26], [4, 29], [8, 31], [12, 32],
          [16, 26], [18, 26], [20, 29], [22, 31], [24, 29], [26, 26]
        ];
        for (let i = 0; i < 4; i++) {
          const offset = i * 32;
          riffBass.forEach(([step, note]) => {
            pat.set(offset + step, 5, note, I_bass, vol);
            pat.set(offset + step + 1, 5, OFF, I_bass);
          });
        }
      };

      // 4. Drone/Clean Bass
      const writeCleanBass = (pat, progression, vol = 0.55) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const chords = chordIntervals[chordName];
          pat.set(start, 5, chords.root - 12, I_bass, vol);
          pat.set(start + 15, 5, OFF, I_bass);
        });
      };

      // 5. Rock drums: John Bonham heavy groove vs Helmet tight metal
      const writeRockDrums = (pat, style = 'bonham') => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          const bar = Math.floor(r / 16);
          if (style === 'clean') {
            if (step === 0) pat.set(r, 2, BD, I_808, 0.8);
            if (step === 8) pat.set(r, 2, RIM, I_808, 0.6);
            if (step % 4 === 2) pat.set(r, 2, HH, I_808, 0.35);
          } else if (style === 'bonham') {
            if (step === 0 || step === 3 || step === 8 || step === 11) {
              pat.set(r, 2, BD, I_808, 0.95);
            }
            if (step === 4 || step === 12) {
              pat.set(r, 2, SD, I_808, 0.9);
            }
            if (step % 2 === 1) {
              pat.set(r, 2, HH, I_808, 0.5);
            }
            if (step === 2 || step === 6 || step === 10 || step === 14) {
              pat.set(r, 2, OH, I_808, 0.55);
            }
            if (r === 0) {
              pat.set(r, 2, CLAP, I_808, 0.85); // crash hit simulator
            }
          } else if (style === 'helmet') {
            const kickSteps = [0, 2, 4, 8, 12];
            if (kickSteps.includes(step)) {
              pat.set(r, 2, BD, I_808, 0.95);
            }
            if (step === 4 || step === 12) {
              pat.set(r, 2, SD, I_808, 0.95);
            }
            if (step % 2 === 0) {
              pat.set(r, 2, HH, I_808, 0.6);
            }
            if ((bar === 3 || bar === 7) && step >= 12) {
              pat.set(r, 2, SD, I_808, 0.8);
            }
          }
        }
      };

      const writeLead = (pat, melody, vol = 0.72) => {
        melody.forEach(([row, note, dur]) => {
          if (row < pat.rows) {
            pat.set(row, 6, note, I_lead, vol);
            if (dur && row + dur < pat.rows) {
              pat.set(row + dur, 6, OFF, I_lead);
            }
          }
        });
      };

      // Melodic lines
      const folkMelody = [
        [0, 62, 12], [16, 64, 12], [32, 65, 16], [48, 67, 16],
        [64, 69, 12], [80, 67, 12], [96, 65, 16], [112, 64, 16]
      ];

      const metalLead = [
        [0, 74, 4], [8, 77, 4], [16, 79, 8], [32, 80, 4], [40, 79, 4], [48, 77, 12],
        [64, 74, 4], [72, 77, 4], [80, 79, 8], [96, 82, 4], [104, 79, 4], [112, 77, 12]
      ];

      // ===== Pattern 0: Folk Intro (Led Zeppelin Prelude) =====
      writeAcousticClean(p[0], folkProg, 0.42);
      writeCleanBass(p[0], folkProg, 0.5);
      writeRockDrums(p[0], 'clean');

      // ===== Pattern 1: Folk Verse 1 =====
      writeAcousticClean(p[1], folkProg, 0.42);
      writeCleanBass(p[1], folkProg, 0.5);
      writeRockDrums(p[1], 'clean');
      writeLead(p[1], folkMelody, 0.68);

      // ===== Pattern 2: Folk Verse 1 Cont. =====
      writeAcousticClean(p[2], folkProg, 0.45);
      writeCleanBass(p[2], folkProg, 0.55);
      writeRockDrums(p[2], 'clean');
      writeLead(p[2], folkMelody.map(([r, n, d]) => [r, n + 5, d]), 0.68); // Transposed up a fourth

      // ===== Pattern 3: The Gathering Storm (Folk build-up) =====
      writeAcousticClean(p[3], folkProg, 0.48);
      writeCleanBass(p[3], folkProg, 0.6);
      writeRockDrums(p[3], 'bonham'); // Drums switch to heavy Bonham style
      writeLead(p[3], folkMelody, 0.7);

      // ===== Pattern 4: The Helmet Drop (Syncopated Palm-Muted Metal) =====
      writeHeavyHelmetRiff(p[4], 0.72);
      writeHeavyBass(p[4], 0.72);
      writeRockDrums(p[4], 'helmet'); // Tight syncopated drums

      // ===== Pattern 5: The Helmet Verse =====
      writeHeavyHelmetRiff(p[5], 0.72);
      writeHeavyBass(p[5], 0.72);
      writeRockDrums(p[5], 'helmet');
      writeLead(p[5], metalLead, 0.72);

      // ===== Pattern 6: The Helmet Verse Cont. =====
      writeHeavyHelmetRiff(p[6], 0.75);
      writeHeavyBass(p[6], 0.75);
      writeRockDrums(p[6], 'helmet');
      writeLead(p[6], metalLead.map(([r, n, d]) => [r, n + 12, d]), 0.75); // Octave up solo

      // ===== Pattern 7: The Ent Massacre (Zeppelin Epic Heavy Blues Riff) =====
      writeHeavyHelmetRiff(p[7], 0.7);
      writeHeavyBass(p[7], 0.7);
      writeRockDrums(p[7], 'bonham'); // Big Bonham triplets
      writeLead(p[7], [
        [0, 62, 4], [4, 65, 4], [8, 67, 8], [20, 67, 4], [24, 65, 4], [28, 62, 4],
        [32, 60, 4], [36, 62, 4], [40, 65, 8], [52, 65, 4], [56, 62, 4], [60, 60, 4],
        [64, 62, 4], [68, 65, 4], [72, 67, 8], [84, 67, 4], [88, 65, 4], [92, 62, 4],
        [96, 69, 4], [100, 72, 4], [104, 74, 8], [116, 74, 4], [120, 72, 4], [124, 69, 4]
      ], 0.75);

      // ===== Pattern 8: The Ent Massacre Cont. (Screaming Solo) =====
      writeHeavyHelmetRiff(p[8], 0.72);
      writeHeavyBass(p[8], 0.72);
      writeRockDrums(p[8], 'bonham');
      writeLead(p[8], [
        [0, 74, 4], [4, 77, 4], [8, 79, 8], [20, 79, 4], [24, 77, 4], [28, 74, 4],
        [32, 72, 4], [36, 74, 4], [40, 77, 8], [52, 77, 4], [56, 74, 4], [60, 72, 4],
        [64, 74, 4], [68, 77, 4], [72, 79, 8], [84, 79, 4], [88, 77, 4], [92, 74, 4],
        [96, 81, 4], [100, 84, 4], [104, 86, 8], [116, 86, 4], [120, 84, 4], [124, 81, 4]
      ], 0.78);

      // ===== Pattern 9: Clean Breakdown (The Calm Before the Feast) =====
      writeAcousticClean(p[9], folkProg, 0.4);
      writeCleanBass(p[9], folkProg, 0.5);
      writeRockDrums(p[9], 'clean');

      // ===== Pattern 10: Clean Verse =====
      writeAcousticClean(p[10], folkProg, 0.42);
      writeCleanBass(p[10], folkProg, 0.5);
      writeRockDrums(p[10], 'clean');
      writeLead(p[10], folkMelody, 0.68);

      // ===== Pattern 11: Pre-Climax Build =====
      writeAcousticClean(p[11], folkProg, 0.45);
      writeCleanBass(p[11], folkProg, 0.6);
      writeRockDrums(p[11], 'bonham');
      writeLead(p[11], folkMelody.map(([r, n, d]) => [r, n + 5, d]), 0.7);

      // ===== Pattern 12: The Murder Party Climax (Helmet + Zeppelin peak) =====
      writeHeavyHelmetRiff(p[12], 0.76);
      writeHeavyBass(p[12], 0.76);
      writeRockDrums(p[12], 'bonham');
      writeLead(p[12], metalLead, 0.78);

      // ===== Pattern 13: The Murder Party Climax Cont. =====
      writeHeavyHelmetRiff(p[13], 0.76);
      writeHeavyBass(p[13], 0.76);
      writeRockDrums(p[13], 'bonham');
      writeLead(p[13], metalLead.map(([r, n, d]) => [r, n + 12, d]), 0.8);

      // ===== Pattern 14: Outro (Devastation & Quiet Fade) =====
      writeAcousticClean(p[14], folkProg, 0.38);
      writeCleanBass(p[14], folkProg, 0.45);
      writeRockDrums(p[14], 'clean');
      writeLead(p[14], [[0, 62, 32]], 0.5); // Final fading root note

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Lipstick-Stained Tailpipe",
    bpm: 120,
    params: [
      // 0: DX7 Chiptune Bell — classic retro FM toy bell / chime
      {
        name: "DX7 Chiptune Bell",
        type: "dx7",
        p0: [1.0, 1.0, 1.0, 0.15],
        p1: [8, 0.2, 0.35, 1], // Algorithm 8
        ops: [
          { coarse: 2.0, fine: 0, level: 99, detune: 2,  decay: 0.8, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 4.0, fine: 1, level: 80, detune: -2, decay: 0.5, mode: 0, sustain: 0.0, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 90, detune: 0,  decay: 1.2, mode: 0, sustain: 0.0, release: 0.7 },
          { coarse: 3.0, fine: 0, level: 70, detune: 3,  decay: 0.4, mode: 0, sustain: 0.0, release: 0.3 },
          { coarse: 0.5, fine: 0, level: 95, detune: -3, decay: 1.8, mode: 0, sustain: 0.0, release: 1.0 },
          { coarse: 1.0, fine: 0, level: 50, detune: 0,  decay: 1.0, mode: 0, sustain: 0.0, release: 0.6 }
        ]
      },
      // 1: 303 Square Lead — bubbly retro NES pulse channel
      { name: "303 Square Lead", type: "303", p0: [900, 0.4, 0.45, 0.25], p1: [1.0, 0.15, 0.25, 0] },
      // 2: 808 Latchkey Kit — lo-fi Famicom-like noise drums (handled by moderate bitcrusher send)
      { name: "808 Latchkey Kit", type: "808", p0: [0, 0.5, 0.45, 0.5], p1: [0, 0, 0, 0] },
      // 3: Moog Triangle Bass — clean retro triangle bass wave
      { name: "Moog Triangle Bass", type: "moog", p0: [150, 0.05, 0.8, 0], p1: [1.0, 0.98, 0.8, 1.0] },
      // 4: Moog Pulse Lead — singing, expressive retro synth lead
      { name: "Moog Pulse Lead", type: "moog", p0: [1000, 0.25, 0.45, 0], p1: [12.0, 0.6, 0.75, 0.5] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: true, bitcrushBits: 8.0, bitcrushRate: 8000.0, chorusMix: 0.3, delayMix: 0.35, delayFeedback: 0.4 }),
      'dx7': Object.assign(defaultFxParams(), { bitcrushOn: true, bitcrushBits: 10.0, bitcrushRate: 12000.0, chorusMix: 0.4, delayMix: 0.3, reverbMix: 0.45 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: true, bitcrushBits: 6.0, bitcrushRate: 6000.0 }), // restrained 8-bit noise drum crunch!
      'moog': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, chorusMix: 0.3, delayMix: 0.25 }),
    },
    data: () => {
      const p = [];
      for (let i = 0; i < 15; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39, RIM = 37;
      const I_pad = 0, I_303 = 1, I_808 = 2, I_bass = 3, I_lead = 4;

      // Chord progressions:
      // Mystical / Town (Circle of Fifths JRPG theme): Am -> Dm -> G -> C -> F -> Bdim -> E7 -> Am
      const rpgProg = ['Am', 'Dm', 'G', 'C', 'F', 'Bdim', 'E7', 'Am'];
      // Frenetic Shmup (Mega Man action theme): Am -> F -> G -> Em -> Am -> F -> G -> E7
      const shmupProg = ['Am', 'F', 'G', 'Em', 'Am', 'F', 'G', 'E7'];

      const voicings = {
        Am: [57, 60, 64],
        Dm: [50, 53, 57],
        G: [55, 59, 62],
        C: [48, 52, 55],
        F: [53, 57, 60],
        Bdim: [59, 62, 65],
        E7: [52, 56, 59],
        Em: [52, 55, 59]
      };

      const bassNotes = {
        Am: 45, Dm: 38, G: 47, C: 40, F: 41, Bdim: 43, E7: 40, Em: 40
      };

      // 1. Chiptune Pads (DX7 Toy Bells on channels 0, 3, 4)
      const writeBells = (pat, progression, style = 'mystical', vol = 0.45) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];
          if (style === 'mystical') {
            voicing.forEach((note, ni) => {
              const ch = [0, 3, 4][ni % 3];
              pat.set(start, ch, note + 12, I_pad, vol);
              pat.set(start + 15, ch, OFF, I_pad);
            });
          } else {
            for (let step = 0; step < 16; step++) {
              const noteIdx = step % voicing.length;
              const ch = [0, 3, 4][step % 3];
              pat.set(start + step, ch, voicing[noteIdx] + 12, I_pad, vol * 0.7);
              pat.set(start + step + 1, ch, OFF, I_pad);
            }
          }
        });
      };

      // 2. Triangle Bass (Moog bass on channel 5)
      const writeBass = (pat, progression, style = 'slow', vol = 0.65) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const root = bassNotes[chordName];
          if (style === 'slow') {
            pat.set(start, 5, root, I_bass, vol);
            pat.set(start + 15, 5, OFF, I_bass);
          } else {
            for (let step = 0; step < 16; step += 2) {
              const isOctave = (step % 4 === 2);
              pat.set(start + step, 5, isOctave ? root + 12 : root, I_bass, vol);
              pat.set(start + step + 1, 5, OFF, I_bass);
            }
          }
        });
      };

      // 3. 303 Square Arps: Bubbly pulse wave arps on channel 1 (retro game style)
      const writePulseArp = (pat, progression, vol = 0.58) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];
          for (let step = 0; step < 16; step += 2) {
            if (step % 8 !== 6) {
              const noteIdx = (step / 2) % voicing.length;
              const note = voicing[noteIdx] + 24;
              pat.set(start + step, 1, note, I_303, vol);
              pat.set(start + step + 1, 1, OFF, I_303);
            }
          }
        });
      };

      // 4. Chiptune Drums (808 kit bitcrushed as retro noise/pcm drums)
      const writeDrums = (pat, style = 'slow') => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (style === 'slow') {
            if (step === 0) pat.set(r, 2, BD, I_808, 0.85);
            if (step === 8) pat.set(r, 2, SD, I_808, 0.7);
            if (step % 8 === 4) pat.set(r, 2, HH, I_808, 0.4);
          } else {
            if (step === 0 || step === 8 || step === 10 || step === 13) pat.set(r, 2, BD, I_808, 0.9);
            if (step === 4 || step === 12) pat.set(r, 2, SD, I_808, 0.85);
            if (step % 2 === 0) pat.set(r, 2, HH, I_808, 0.45);
            if (step === 6 || step === 14) pat.set(r, 2, OH, I_808, 0.5);
          }
        }
      };

      const writeLead = (pat, melody, vol = 0.72) => {
        melody.forEach(([row, note, dur]) => {
          if (row < pat.rows) {
            pat.set(row, 6, note, I_lead, vol);
            if (dur && row + dur < pat.rows) {
              pat.set(row + dur, 6, OFF, I_lead);
            }
          }
        });
      };

      // Riffs & Melodies
      const mysticalMelody = [
        [0, 64, 8], [8, 67, 8], [16, 69, 12], [28, 71, 4],
        [32, 72, 8], [40, 71, 8], [48, 69, 16],
        [64, 67, 8], [72, 69, 8], [80, 71, 12], [92, 72, 4],
        [96, 74, 8], [104, 76, 8], [112, 79, 16]
      ];

      const actionMelody = [
        [0, 76, 4], [4, 79, 4], [8, 81, 6], [14, 81, 2], [16, 83, 8], [24, 81, 4], [28, 79, 4],
        [32, 81, 6], [38, 79, 2], [40, 76, 6], [46, 74, 2], [48, 76, 16],
        [64, 79, 4], [68, 81, 4], [72, 83, 6], [78, 83, 2], [80, 86, 8], [88, 84, 4], [92, 83, 4],
        [96, 81, 6], [102, 79, 2], [104, 76, 6], [110, 74, 2], [112, 76, 16]
      ];

      // ===== Pattern 0: Mystical Intro =====
      writeBells(p[0], rpgProg, 'mystical', 0.4);
      writeBass(p[0], rpgProg, 'slow', 0.55);
      writeDrums(p[0], 'slow');

      // ===== Pattern 1: Mystical Verse 1 =====
      writeBells(p[1], rpgProg, 'mystical', 0.42);
      writeBass(p[1], rpgProg, 'slow', 0.55);
      writeDrums(p[1], 'slow');
      writeLead(p[1], mysticalMelody, 0.7);

      // ===== Pattern 2: Mystical Verse 1 Cont. =====
      writeBells(p[2], rpgProg, 'mystical', 0.42);
      writeBass(p[2], rpgProg, 'slow', 0.58);
      writeDrums(p[2], 'slow');
      writeLead(p[2], mysticalMelody.map(([r, n, d]) => [r, n + 5, d]), 0.7);

      // ===== Pattern 3: Level Load =====
      writeBells(p[3], rpgProg, 'arpeggio', 0.35);
      writeBass(p[3], rpgProg, 'slow', 0.6);
      writeDrums(p[3], 'slow');
      writePulseArp(p[3], rpgProg, 0.5);

      // ===== Pattern 4: Level 1 - Frenetic Shmup =====
      writeBells(p[4], shmupProg, 'arpeggio', 0.35);
      writeBass(p[4], shmupProg, 'fast', 0.65);
      writeDrums(p[4], 'fast');
      writePulseArp(p[4], shmupProg, 0.52);

      // ===== Pattern 5: Level 1 - The First Battle =====
      writeBells(p[5], shmupProg, 'arpeggio', 0.35);
      writeBass(p[5], shmupProg, 'fast', 0.65);
      writeDrums(p[5], 'fast');
      writePulseArp(p[5], shmupProg, 0.52);
      writeLead(p[5], actionMelody, 0.72);

      // ===== Pattern 6: Level 1 - The First Battle Cont. =====
      writeBells(p[6], shmupProg, 'arpeggio', 0.38);
      writeBass(p[6], shmupProg, 'fast', 0.68);
      writeDrums(p[6], 'fast');
      writePulseArp(p[6], shmupProg, 0.55);
      writeLead(p[6], actionMelody.map(([r, n, d]) => [r, n + 12, d]), 0.72);

      // ===== Pattern 7: Boss Battle =====
      writeBells(p[7], shmupProg, 'arpeggio', 0.38);
      writeBass(p[7], shmupProg, 'fast', 0.68);
      writeDrums(p[7], 'fast');
      writePulseArp(p[7], shmupProg, 0.55);
      writeLead(p[7], [
        [0, 64, 4], [4, 67, 4], [8, 69, 8], [20, 69, 4], [24, 67, 4], [28, 64, 4],
        [32, 62, 4], [36, 64, 4], [40, 67, 8], [52, 67, 4], [56, 64, 4], [60, 62, 4],
        [64, 64, 4], [68, 67, 4], [72, 69, 8], [84, 69, 4], [88, 67, 4], [92, 64, 4],
        [96, 71, 4], [100, 74, 4], [104, 76, 8], [116, 76, 4], [120, 74, 4], [124, 71, 4]
      ], 0.75);

      // ===== Pattern 8: Boss Battle Cont. =====
      writeBells(p[8], shmupProg, 'arpeggio', 0.4);
      writeBass(p[8], shmupProg, 'fast', 0.7);
      writeDrums(p[8], 'fast');
      writePulseArp(p[8], shmupProg, 0.58);
      writeLead(p[8], [
        [0, 76, 4], [4, 79, 4], [8, 81, 8], [20, 81, 4], [24, 79, 4], [28, 76, 4],
        [32, 74, 4], [36, 76, 4], [40, 79, 8], [52, 79, 4], [56, 76, 4], [60, 74, 4],
        [64, 76, 4], [68, 79, 4], [72, 81, 8], [84, 81, 4], [88, 79, 4], [92, 76, 4],
        [96, 83, 4], [100, 86, 4], [104, 88, 8], [116, 88, 4], [120, 86, 4], [124, 83, 4]
      ], 0.78);

      // ===== Pattern 9: Safe Haven =====
      writeBells(p[9], rpgProg, 'mystical', 0.4);
      writeBass(p[9], rpgProg, 'slow', 0.52);
      writeDrums(p[9], 'slow');

      // ===== Pattern 10: Safe Haven Verse =====
      writeBells(p[10], rpgProg, 'mystical', 0.42);
      writeBass(p[10], rpgProg, 'slow', 0.55);
      writeDrums(p[10], 'slow');
      writeLead(p[10], mysticalMelody, 0.68);

      // ===== Pattern 11: Level Boot 2 =====
      writeBells(p[11], rpgProg, 'arpeggio', 0.35);
      writeBass(p[11], rpgProg, 'slow', 0.6);
      writeDrums(p[11], 'slow');
      writePulseArp(p[11], rpgProg, 0.5);

      // ===== Pattern 12: Final Escape =====
      writeBells(p[12], shmupProg, 'arpeggio', 0.38);
      writeBass(p[12], shmupProg, 'fast', 0.68);
      writeDrums(p[12], 'fast');
      writePulseArp(p[12], shmupProg, 0.55);
      writeLead(p[12], actionMelody, 0.74);

      // ===== Pattern 13: Final Escape Cont. =====
      writeBells(p[13], shmupProg, 'arpeggio', 0.38);
      writeBass(p[13], shmupProg, 'fast', 0.68);
      writeDrums(p[13], 'fast');
      writePulseArp(p[13], shmupProg, 0.55);
      writeLead(p[13], actionMelody.map(([r, n, d]) => [r, n + 12, d]), 0.75);

      // ===== Pattern 14: Game Over / Credits =====
      writeBells(p[14], rpgProg, 'mystical', 0.38);
      writeBass(p[14], rpgProg, 'slow', 0.48);
      writeDrums(p[14], 'slow');
      writeLead(p[14], [[0, 64, 32]], 0.55);

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        rowsPerBeat: 4
      };
    }
  }
];

export function demoSong() {
  return DEMO_SONGS[0].data();
}
