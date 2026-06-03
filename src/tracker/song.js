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
    name: "Hyperkinetic",
    bpm: 174,
    params: defaultParams(),
    fxParams: {
      '303': defaultFxParams(),
      'dx7': defaultFxParams(),
      '808': defaultFxParams(),
      'moog': defaultFxParams(),
    },
    data: () => {
      const p = new Pattern(128, 8);
      const BD = 36, SD = 38, HH = 42, OH = 46, CB = 56, CLAP = 39;
      const I_303 = I['303'];
      const I_dx7 = I['dx7'];
      const I_808 = I['808'];
      const I_moog = I['moog'];

      // --- Channel 0: 808 Kick Drum (BD) ---
      for (let r = 0; r < 128; r += 4) {
        const step = r % 16;
        if (step === 0 || step === 10) {
          p.set(r, 0, BD, I_808, 1.0);
        }
        // Dynamic kick fill at end of phrases
        if (r >= 64 && r < 96 && r % 32 === 26) {
          p.set(r, 0, BD, I_808, 0.85);
        }
      }

      // --- Channel 1: 808 Snare Drum (SD) ---
      for (let r = 0; r < 128; r += 8) {
        p.set(r + 4, 1, SD, I_808, 0.9);
        // Frantic 16th-note snare rolls before transitions
        if (r === 24 || r === 56 || r === 88 || r === 120) {
          p.set(r + 6, 1, SD, I_808, 0.5);
          p.set(r + 7, 1, SD, I_808, 0.8);
        }
      }

      // --- Channel 2: 808 Hi-Hats (HH / OH) ---
      for (let r = 0; r < 128; r += 2) {
        if (r % 4 === 2) {
          p.set(r, 2, OH, I_808, 0.55); // offbeat open hat
        } else {
          p.set(r, 2, HH, I_808, 0.25 + (r % 3) * 0.15); // closed hat
        }
        // High-hat rolls in builds
        if (r % 64 >= 56 && r % 4 === 3) {
          p.set(r, 2, HH, I_808, 0.35);
        }
      }

      // --- Channel 3: 303 Acid Bassline ---
      const acidBass = [
        43, 43, 55, 43, 46, 46, 58, 46,
        48, 50, 62, 50, 43, 46, 48, 50
      ];
      for (let r = 16; r < 120; r++) {
        const step = r % 16;
        const bar = Math.floor(r / 16);
        let note = acidBass[step];
        
        // Chord progression transposition: Gmin -> D#maj -> Fmaj -> Dmin
        if (bar === 2 || bar === 6) note += 8;  // up to D#
        if (bar === 3 || bar === 7) note += 10; // up to F
        if (bar === 4) note += 7; // up to D
        
        if (step % 8 !== 3 && step % 8 !== 7) {
          p.set(r, 3, note, I_303, step % 4 === 0 ? 0.95 : 0.65);
        } else {
          p.set(r, 3, OFF, I_303);
        }
      }

      // --- Channel 4: Moog Chord Stabs ---
      const chordRoots = [55, 55, 51, 53, 50, 55, 51, 53];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const root = chordRoots[bar];
        
        p.set(start + 2, 4, root, I_moog, 0.7);
        p.set(start + 3, 4, OFF, I_moog);
        p.set(start + 8, 4, root + 12, I_moog, 0.55);
        p.set(start + 9, 4, OFF, I_moog);
        p.set(start + 14, 4, root, I_moog, 0.65);
        p.set(start + 15, 4, OFF, I_moog);
      }

      // --- Channel 5: DX7 FM Bells ---
      const dx7Melody = [67, 70, 74, 77, 79, 77, 74, 70];
      for (let r = 8; r < 124; r += 2) {
        const idx = (r / 2) % dx7Melody.length;
        let note = dx7Melody[idx];
        const bar = Math.floor(r / 16);
        
        if (bar === 2 || bar === 6) note += 8;
        if (bar === 3 || bar === 7) note += 10;
        if (bar === 4) note += 7;
        
        p.set(r, 5, note, I_dx7, 0.55);
        p.set(r + 1, 5, OFF, I_dx7);
      }

      // --- Channel 6: 808 Clap Percussion ---
      for (let r = 32; r < 96; r++) {
        const step = r % 16;
        if (step === 8 || step === 15) {
          p.set(r, 6, CLAP, I_808, 0.7);
        }
      }

      return makeDemoPatterns(p);
    }
  },
  {
    name: "Shitty AI Noise",
    bpm: 125,
    params: [
      { name: "303 Acid", type: "303", p0: [380, 0.75, 0.55, 0.3], p1: [0, 0.4, 0.3, 0] },
      { name: "DX7 Pad", type: "dx7",
        p0: [1, 2, 2.0, 0.2], p1: [1, 0.7, 0.8, 4],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.8, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 75, detune: 2, decay: 0.8, mode: 0, sustain: 0.7, release: 0.4 },
          { coarse: 2.0, fine: 0, level: 60, detune: 1, decay: 0.7, mode: 0, sustain: 0.6, release: 0.4 },
          { coarse: 3.0, fine: 0, level: 50, detune: 0, decay: 0.6, mode: 0, sustain: 0.5, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.4 }
        ]
      },
      { name: "808 Kit", type: "808", p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
      { name: "Moog Bass", type: "moog", p0: [200, 0.6, 0.7, 0], p1: [4, 0.9, 0.4, 0.8] },
      { name: "Moog Lead", type: "moog", p0: [1100, 0.25, 0.3, 0], p1: [12, 0.4, 0.7, 0.4] }
    ],
    fxParams: {
      '303': defaultFxParams(),
      'dx7': defaultFxParams(),
      '808': defaultFxParams(),
      'moog': defaultFxParams(),
    },
    data: () => {
      const p0 = new Pattern(64, 8);
      const p1 = new Pattern(64, 8);
      const p2 = new Pattern(128, 8);

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_303 = 0, I_dx7 = 1, I_808 = 2, I_moogBass = 3, I_moogLead = 4;

      const getRoot = (bar) => {
        const progression = [36, 46, 44, 43];
        return progression[bar % 4];
      };

      for (let r = 0; r < 64; r += 4) {
        p0.set(r, 0, BD, I_808, 0.9);
        if (r % 8 === 4) {
          p0.set(r, 0, SD, I_808, 0.75);
        }
      }
      for (let r = 0; r < 64; r += 2) {
        p0.set(r, 2, (r % 4 === 2) ? OH : HH, I_808, 0.4);
      }
      for (let r = 0; r < 64; r += 2) {
        const bar = Math.floor(r / 16);
        const root = getRoot(bar);
        const note = (r % 4 === 2) ? root + 12 : root;
        p0.set(r, 3, note, I_moogBass, 0.85);
        p0.set(r + 1, 3, OFF, I_moogBass);
      }

      for (let r = 0; r < 64; r += 4) {
        p1.set(r, 0, BD, I_808, 0.95);
      }
      for (let r = 0; r < 64; r += 2) {
        p1.set(r, 2, HH, I_808, 0.45);
      }
      for (let r = 0; r < 64; r++) {
        if (r >= 48) {
          const snareStep = (r - 48);
          if (snareStep % 2 === 0 || snareStep >= 8) {
            p1.set(r, 1, SD, I_808, 0.5 + (snareStep / 16) * 0.45);
          }
        } else if (r % 8 === 4) {
          p1.set(r, 1, SD, I_808, 0.75);
        }
      }
      for (let r = 0; r < 64; r += 2) {
        const bar = Math.floor(r / 16);
        const root = getRoot(bar);
        const note = (r % 4 === 2) ? root + 12 : root;
        p1.set(r, 3, note, I_moogBass, 0.85);
        p1.set(r + 1, 3, OFF, I_moogBass);
      }
      for (let r = 0; r < 64; r += 4) {
        const bar = Math.floor(r / 16);
        const root = getRoot(bar);
        const arp = [0, 3, 7, 10, 12, 15, 19, 22];
        const step = Math.floor((r % 16) / 2);
        const note = root + 24 + arp[step % arp.length];
        p1.set(r, 4, note, I_moogLead, 0.75);
        p1.set(r + 2, 4, OFF, I_moogLead);
      }

      for (let r = 0; r < 128; r += 4) {
        p2.set(r, 0, BD, I_808, 1.0);
        if (r % 8 === 4) {
          p2.set(r, 1, SD, I_808, 0.85);
          if (r % 16 === 12) {
            p2.set(r + 2, 1, CLAP, I_808, 0.75);
          }
        }
      }
      for (let r = 0; r < 128; r += 2) {
        p2.set(r, 2, (r % 4 === 2) ? OH : HH, I_808, 0.5);
      }
      for (let r = 0; r < 128; r += 2) {
        const bar = Math.floor(r / 16);
        const root = getRoot(bar);
        const riff = [0, 0, 12, 0, 7, 0, 10, 12];
        const step = Math.floor((r % 16) / 2);
        const note = root + riff[step % riff.length];
        p2.set(r, 3, note, I_moogBass, 0.9);
        p2.set(r + 1, 3, OFF, I_moogBass);
      }
      const melody = [
        60, 63, 67, 72, 70, 67, 65, 67,
        60, 63, 67, 72, 74, 75, 79, 74,
        72, 70, 67, 63, 65, 67, 70, 72,
        74, 75, 77, 79, 82, 84, 86, 87
      ];
      for (let r = 0; r < 128; r += 4) {
        const idx = Math.floor(r / 4);
        const note = melody[idx % melody.length];
        p2.set(r, 4, note, I_moogLead, 0.8);
        p2.set(r + 3, 4, OFF, I_moogLead);
      }
      for (let r = 0; r < 128; r += 16) {
        const bar = Math.floor(r / 16);
        const root = getRoot(bar);
        p2.set(r, 5, root + 24, I_dx7, 0.6);
        p2.set(r, 5, root + 27, I_dx7, 0.6);
        p2.set(r, 5, root + 31, I_dx7, 0.6);
        p2.set(r + 12, 5, OFF, I_dx7);
      }
      for (let r = 0; r < 128; r += 2) {
        if (r % 8 === 0 || r % 8 === 3 || r % 8 === 6) {
          const bar = Math.floor(r / 16);
          const root = getRoot(bar);
          const note = root + 12 + (r % 7);
          p2.set(r, 6, note, I_303, 0.65);
          p2.set(r + 1, 6, OFF, I_303);
        }
      }

      return { patterns: [p0, p1, p2], order: [0, 1, 2], rowsPerBeat: 4 };
    }
  },
  {
    name: "Voodoo Beats",
    bpm: 145,
    params: [
      { name: "303 Acid", type: "303", p0: [480, 0.75, 0.6, 0.45], p1: [0, 0.4, 0.4, 0] },
      { name: "DX7 Pad", type: "dx7",
        p0: [1, 2, 3.0, 0.25], p1: [1, 0.7, 0.8, 4],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.8, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 75, detune: 2, decay: 0.8, mode: 0, sustain: 0.7, release: 0.4 },
          { coarse: 2.0, fine: 0, level: 60, detune: 1, decay: 0.7, mode: 0, sustain: 0.6, release: 0.4 },
          { coarse: 3.0, fine: 0, level: 50, detune: 0, decay: 0.6, mode: 0, sustain: 0.5, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.4 }
        ]
      },
      { name: "808 Kit", type: "808", p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
      { name: "Moog Bass", type: "moog", p0: [250, 0.55, 0.75, 0], p1: [4, 0.8, 0.5, 0.7] },
      { name: "Moog Lead", type: "moog", p0: [850, 0.35, 0.5, 0], p1: [12, 0.4, 0.6, 0.4] }
    ],
    fxParams: {
      '303': defaultFxParams(),
      'dx7': defaultFxParams(),
      '808': defaultFxParams(),
      'moog': defaultFxParams(),
    },
    data: () => {
      const p0 = new Pattern(32, 8);
      const p1 = new Pattern(32, 8);
      const p2 = new Pattern(32, 8);
      const p3 = new Pattern(32, 8);
      const p4 = new Pattern(32, 8);
      const p5 = new Pattern(32, 8);
      const p6 = new Pattern(64, 8);
      const p7 = new Pattern(64, 8);
      const p8 = new Pattern(32, 8);
      const p9 = new Pattern(32, 8);
      const p10 = new Pattern(64, 8);
      const p11 = new Pattern(32, 8);
      const p12 = new Pattern(32, 8);

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_303 = 0, I_dx7 = 1, I_808 = 2, I_moogBass = 3, I_moogLead = 4;

      const setDrums = (pat, start, end, hasKick, hasSnare, hasHats, hasClap) => {
        for (let r = start; r < end; r++) {
          const step = r % 16;
          if (hasKick) {
            if (step === 0 || step === 8 || step === 11) pat.set(r, 0, BD, I_808, 0.95);
          }
          if (hasSnare) {
            if (step === 4 || step === 12) pat.set(r, 1, SD, I_808, 0.85);
          }
          if (hasClap) {
            if (step === 12) pat.set(r, 1, CLAP, I_808, 0.8);
          }
          if (hasHats) {
            if (step % 2 === 1) pat.set(r, 2, HH, I_808, 0.4);
            if (step === 6 || step === 14) pat.set(r, 2, OH, I_808, 0.5);
          }
        }
      };

      const setLead = (pat, start, end, vol = 0.8, octShift = 0) => {
        const riff = [50, 50, 53, 55, 56, 55, 53, 50, 50, 53, 50, 50, 48, 48, 48, 48];
        for (let r = start; r < end; r++) {
          const step = r % 16;
          const note = riff[step];
          if (note !== EMPTY) {
            pat.set(r, 4, note + octShift, I_moogLead, vol);
            if (step === 1 || step === 3 || step === 5 || step === 7 || step === 9 || step === 11 || step === 13 || step === 15) {
              pat.set(r, 4, OFF, I_moogLead);
            }
          }
        }
      };

      const setBass = (pat, start, end, vol = 0.85) => {
        const bass = [38, 38, 38, 38, 41, 41, 43, 43, 38, 38, 38, 38, 36, 36, 36, 36];
        for (let r = start; r < end; r += 2) {
          const step = Math.floor((r % 16) / 2);
          const note = bass[step];
          pat.set(r, 3, note, I_moogBass, vol);
          pat.set(r + 1, 3, OFF, I_moogBass);
        }
      };

      const setAcid = (pat, start, end, vol = 0.7) => {
        for (let r = start; r < end; r += 2) {
          const step = r % 16;
          if (step === 0 || step === 3 || step === 6 || step === 8 || step === 11 || step === 14) {
            const note = 50 + (step === 3 ? 3 : step === 6 ? 6 : step === 8 ? 8 : step === 11 ? 5 : 0);
            pat.set(r, 6, note, I_303, vol);
            pat.set(r + 1, 6, OFF, I_303);
          }
        }
      };

      for (let r = 0; r < 32; r += 16) {
        p0.set(r, 5, 50, I_dx7, 0.6);
        p0.set(r, 5, 53, I_dx7, 0.6);
        p0.set(r, 5, 57, I_dx7, 0.6);
        p0.set(r + 14, 5, OFF, I_dx7);
      }

      setLead(p1, 0, 32, 0.75);

      setDrums(p2, 0, 32, true, false, false, false);
      setLead(p2, 0, 32, 0.78);
      setBass(p2, 0, 32, 0.7);

      setDrums(p3, 0, 32, true, false, true, false);
      setLead(p3, 0, 32, 0.8);
      setBass(p3, 0, 32, 0.8);

      setDrums(p4, 0, 32, true, true, true, false);
      setLead(p4, 0, 32, 0.8);
      setBass(p4, 0, 32, 0.8);

      setDrums(p5, 0, 32, true, true, true, false);
      setLead(p5, 0, 32, 0.8);
      setBass(p5, 0, 32, 0.8);
      setAcid(p5, 0, 32, 0.6);

      setDrums(p6, 0, 64, true, true, true, true);
      setLead(p6, 0, 64, 0.85);
      setBass(p6, 0, 64, 0.85);
      setAcid(p6, 0, 64, 0.75);

      setDrums(p7, 0, 64, true, true, true, false);
      setBass(p7, 0, 64, 0.8);
      setAcid(p7, 0, 64, 0.85);
      for (let r = 0; r < 64; r += 16) {
        p7.set(r, 5, 62, I_dx7, 0.65);
        p7.set(r + 12, 5, OFF, I_dx7);
      }

      setDrums(p8, 0, 32, false, false, true, false);
      setBass(p8, 0, 32, 0.6);
      for (let r = 0; r < 32; r += 8) {
        p8.set(r, 5, 50, I_dx7, 0.5);
        p8.set(r + 6, 5, OFF, I_dx7);
      }

      setLead(p9, 0, 32, 0.75);
      setBass(p9, 0, 32, 0.75);
      setAcid(p9, 0, 32, 0.65);
      for (let r = 0; r < 32; r++) {
        if (r >= 16) {
          const buildStep = (r - 16);
          if (buildStep % 2 === 0 || buildStep >= 8) {
            p9.set(r, 1, SD, I_808, 0.5 + (buildStep / 16) * 0.45);
          }
        }
      }

      setDrums(p10, 0, 64, true, true, true, true);
      setLead(p10, 0, 64, 0.9, 12);
      setBass(p10, 0, 64, 0.9);
      setAcid(p10, 0, 64, 0.85);

      setDrums(p11, 0, 32, true, false, true, false);
      setBass(p11, 0, 32, 0.75);

      setBass(p12, 0, 32, 0.5);

      return {
        patterns: [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12],
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Groove 90 (Hot Trash)",
    bpm: 125,
    params: [
      { name: "303 Bass", type: "303", p0: [280, 0.65, 0.5, 0.3], p1: [0, 0.35, 0.4, 0] },
      { name: "DX7 Brass", type: "dx7",
        p0: [1, 2, 2.5, 0.2], p1: [1, 0.7, 0.6, 2],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.8, mode: 0, sustain: 0.85, release: 0.3 },
          { coarse: 1.0, fine: 5, level: 85, detune: 2, decay: 0.4, mode: 0, sustain: 0.7, release: 0.3 },
          { coarse: 2.0, fine: 0, level: 75, detune: -2, decay: 0.3, mode: 0, sustain: 0.6, release: 0.3 },
          { coarse: 3.0, fine: 0, level: 60, detune: 0, decay: 0.15, mode: 0, sustain: 0.0, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.3 }
        ]
      },
      { name: "808 House", type: "808", p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
      { name: "Moog Organ", type: "moog", p0: [900, 0.4, 0.45, 0], p1: [8, 0.7, 0.5, 0.8] },
      { name: "DX7 Piano", type: "dx7",
        p0: [1, 1, 1.0, 0.1], p1: [1, 0.8, 0.7, 0],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 85, detune: 1, decay: 0.6, mode: 0, sustain: 0.6, release: 0.3 },
          { coarse: 2.0, fine: 0, level: 70, detune: 0, decay: 0.5, mode: 0, sustain: 0.5, release: 0.3 },
          { coarse: 3.0, fine: 0, level: 65, detune: 0, decay: 0.4, mode: 0, sustain: 0.4, release: 0.3 },
          { coarse: 4.0, fine: 0, level: 60, detune: 0, decay: 0.3, mode: 0, sustain: 0.3, release: 0.3 },
          { coarse: 5.0, fine: 0, level: 50, detune: 0, decay: 0.2, mode: 0, sustain: 0.2, release: 0.3 }
        ]
      }
    ],
    fxParams: {
      '303': defaultFxParams(),
      'dx7': defaultFxParams(),
      '808': defaultFxParams(),
      'moog': defaultFxParams(),
    },
    data: () => {
      const p0 = new Pattern(32, 8);
      const p1 = new Pattern(32, 8);
      const p2 = new Pattern(32, 8);
      const p3 = new Pattern(32, 8);
      const p4 = new Pattern(32, 8);
      const p5 = new Pattern(32, 8);
      const p6 = new Pattern(32, 8);
      const p7 = new Pattern(32, 8);
      const p8 = new Pattern(32, 8);
      const p9 = new Pattern(32, 8);
      const p10 = new Pattern(32, 8);
      const p11 = new Pattern(32, 8);
      const p12 = new Pattern(32, 8);
      const p13 = new Pattern(32, 8);
      const p14 = new Pattern(32, 8);
      const p15 = new Pattern(32, 8);

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_303 = 0, I_dx7Brass = 1, I_808 = 2, I_moogLead = 3, I_dx7Piano = 4;

      const setHouseDrums = (pat, hasKick, hasHats, hasSnare, hasClap) => {
        for (let r = 0; r < 32; r++) {
          const step = r % 16;
          if (hasKick) {
            if (step === 0 || step === 4 || step === 8 || step === 12) {
              pat.set(r, 0, BD, I_808, 0.95);
            }
          }
          if (hasHats) {
            if (step === 2 || step === 6 || step === 10 || step === 14) {
              pat.set(r, 2, OH, I_808, 0.55);
            } else if (step % 2 === 0) {
              pat.set(r, 2, HH, I_808, 0.3);
            }
          }
          if (hasSnare) {
            if (step === 4 || step === 12) {
              pat.set(r, 1, SD, I_808, 0.8);
            }
          }
          if (hasClap) {
            if (step === 12) {
              pat.set(r, 1, CLAP, I_808, 0.75);
            }
          }
        }
      };

      const setHouseBass = (pat, vol = 0.8) => {
        const bassCm = [36, EMPTY, 36, 39, EMPTY, 36, EMPTY, 41, EMPTY, 36, 43, EMPTY, 36, EMPTY, 36, OFF];
        const bassFm = [41, EMPTY, 41, 44, EMPTY, 41, EMPTY, 46, EMPTY, 41, 48, EMPTY, 41, EMPTY, 41, OFF];
        for (let r = 0; r < 32; r++) {
          const note = (r < 16) ? bassCm[r % 16] : bassFm[r % 16];
          if (note !== EMPTY) {
            pat.set(r, 3, note, I_303, vol);
          }
        }
      };

      const setPianoChords = (pat, vol = 0.65) => {
        for (let r = 0; r < 32; r += 8) {
          const isFm = r >= 16;
          const root = isFm ? 41 : 36;
          const third = isFm ? 44 : 39;
          const fifth = isFm ? 48 : 43;
          
          pat.set(r, 5, root + 12, I_dx7Piano, vol);
          pat.set(r, 5, third + 12, I_dx7Piano, vol);
          pat.set(r, 5, fifth + 12, I_dx7Piano, vol);
          
          pat.set(r + 3, 5, root + 12, I_dx7Piano, vol);
          pat.set(r + 3, 5, third + 12, I_dx7Piano, vol);
          pat.set(r + 3, 5, fifth + 12, I_dx7Piano, vol);
          
          pat.set(r + 6, 5, OFF, I_dx7Piano);
        }
      };

      const setBrassStabs = (pat, vol = 0.8) => {
        const brassRiff = [60, EMPTY, EMPTY, 60, EMPTY, EMPTY, 63, EMPTY, 62, EMPTY, EMPTY, 58, EMPTY, EMPTY, 60, OFF];
        for (let r = 0; r < 32; r++) {
          const note = brassRiff[r % 16];
          if (note !== EMPTY) {
            pat.set(r, 4, note, I_dx7Brass, vol);
          }
        }
      };

      const setOrganLead = (pat, vol = 0.75) => {
        const melody = [60, 62, 63, 67, 65, 63, 62, 60, 65, 67, 68, 72, 70, 68, 67, 65];
        for (let r = 0; r < 32; r += 2) {
          const step = Math.floor((r % 16) / 2);
          const note = melody[step + (r >= 16 ? 8 : 0)];
          pat.set(r, 6, note, I_moogLead, vol);
          pat.set(r + 1, 6, OFF, I_moogLead);
        }
      };

      setHouseDrums(p0, true, false, false, false);
      setHouseBass(p0, 0.75);

      setHouseDrums(p1, true, true, false, false);
      setHouseBass(p1, 0.8);

      setHouseDrums(p2, true, true, false, false);
      setHouseBass(p2, 0.8);
      setPianoChords(p2, 0.65);

      setHouseDrums(p3, true, true, true, false);
      setHouseBass(p3, 0.8);
      setPianoChords(p3, 0.65);

      setHouseDrums(p4, true, true, true, false);
      setHouseBass(p4, 0.8);
      setPianoChords(p4, 0.6);
      setBrassStabs(p4, 0.8);

      setHouseDrums(p5, true, true, true, true);
      setHouseBass(p5, 0.8);
      setPianoChords(p5, 0.6);
      setBrassStabs(p5, 0.85);

      setHouseDrums(p6, true, true, true, true);
      setHouseBass(p6, 0.8);
      setPianoChords(p6, 0.6);
      setOrganLead(p6, 0.75);

      setHouseBass(p7, 0.8);
      setPianoChords(p7, 0.6);
      for (let r = 0; r < 32; r++) {
        if (r >= 16) {
          const step = r - 16;
          if (step % 2 === 0 || step >= 8) {
            p7.set(r, 1, SD, I_808, 0.5 + (step / 16) * 0.45);
          }
        }
      }

      setHouseDrums(p8, true, true, true, true);
      setHouseBass(p8, 0.85);
      setPianoChords(p8, 0.7);
      setOrganLead(p8, 0.8);
      setBrassStabs(p8, 0.8);

      setHouseDrums(p9, true, true, true, true);
      setHouseBass(p9, 0.85);
      setPianoChords(p9, 0.7);
      setOrganLead(p9, 0.8);
      setBrassStabs(p9, 0.85);

      setHouseDrums(p10, false, true, false, false);
      setHouseBass(p10, 0.6);
      setPianoChords(p10, 0.6);
      setOrganLead(p10, 0.7);

      setHouseDrums(p11, true, true, false, false);
      setPianoChords(p11, 0.75);

      setHouseBass(p12, 0.75);
      setPianoChords(p12, 0.6);
      for (let r = 0; r < 32; r++) {
        if (r % 2 === 0) p12.set(r, 2, HH, I_808, 0.4);
        if (r >= 16) {
          const step = r - 16;
          if (step % 2 === 0 || step >= 8) {
            p12.set(r, 1, SD, I_808, 0.5 + (step / 16) * 0.45);
          }
        }
      }

      setHouseDrums(p13, true, true, true, true);
      setHouseBass(p13, 0.9);
      setPianoChords(p13, 0.75);
      setOrganLead(p13, 0.85);
      setBrassStabs(p13, 0.9);

      setHouseDrums(p14, true, true, true, false);
      setHouseBass(p14, 0.8);
      setPianoChords(p14, 0.65);

      setHouseDrums(p15, true, false, false, false);
      setHouseBass(p15, 0.7);

      return {
        patterns: [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15],
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        rowsPerBeat: 4
      };
    }
  },
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
    name: "Ambient Drones",
    bpm: 90,
    params: defaultParams(),
    fxParams: {
      '303': defaultFxParams(),
      'dx7': defaultFxParams(),
      '808': defaultFxParams(),
      'moog': defaultFxParams(),
    },
    data: () => {
      const p = new Pattern(128, 8);
      const I_303 = I['303'];
      const I_dx7 = I['dx7'];
      const I_moog = I['moog'];

      // Channel 3: Slow 303 bass drone (low root notes held for 32 steps)
      p.set(0, 3, 33, I_303, 0.7); // A-1
      p.set(32, 3, 29, I_303, 0.7); // F-1
      p.set(64, 3, 33, I_303, 0.7); // A-1
      p.set(96, 3, 31, I_303, 0.7); // G-1

      // Channel 4: Moog Pad 1 (Root chord notes held for 32 steps)
      p.set(0, 4, 45, I_moog, 0.65); // A-2
      p.set(32, 4, 41, I_moog, 0.65); // F-2
      p.set(64, 4, 45, I_moog, 0.65); // A-2
      p.set(96, 4, 43, I_moog, 0.65); // G-2

      // Channel 7: Moog Pad 2 (Fifth interval notes held for 32 steps)
      p.set(0, 7, 52, I_moog, 0.55); // E-3
      p.set(32, 7, 48, I_moog, 0.55); // C-3
      p.set(64, 7, 52, I_moog, 0.55); // E-3
      p.set(96, 7, 50, I_moog, 0.55); // D-3

      // Channel 5: DX7 Slow FM Bells (gentle melody with long delays)
      const bellNotes = [57, 60, 64, 67, 69, 67, 64, 60];
      for (let r = 4; r < 120; r += 8) {
        const idx = Math.floor(r / 8) % bellNotes.length;
        p.set(r, 5, bellNotes[idx], I_dx7, 0.45);
        p.set(r + 6, 5, OFF, I_dx7); // release tail ringing
      }

      return makeDemoPatterns(p);
    }
  },
  {
    name: "Dystopian Industrial",
    bpm: 120,
    params: makeParams({
      '303':  { p0: [1200, 0.85, 0.8, 0.5], p1: [1, 0.2, 0.35, 0] },
      'dx7':  { p0: [2, 1, 4.5, 0.5],      p1: [5, 0.4, 0.5, 4] },
      '808':  { p0: [0, 0.4, 0.7, 0.8],    p1: [0, 0, 0, 0] },
      'moog': { p0: [600, 0.6, 0.7, 0],    p1: [25, 0.4, 1.2, 0.8] },
    }),
    fxParams: {
      '303': Object.assign(defaultFxParams(), {
        drive: 2.5, width: 1.2, master: 0.9,
        chorusMix: 0.35, chorusRate: 2.0, chorusDepth: 3.0,
        tremoloMix: 0.2, tremoloRate: 4.0,
        delayTime: 0.375, delayFeedback: 0.45, delayMix: 0.3,
        reverbDecay: 0.8, reverbDamp: 0.3, reverbSend: 0.5, reverbMix: 0.2,
      }),
      'dx7': Object.assign(defaultFxParams(), {
        drive: 1.5, width: 1.5, master: 0.8,
        chorusMix: 0.5, chorusRate: 1.0, chorusDepth: 4.0,
        delayTime: 0.5, delayFeedback: 0.6, delayMix: 0.4,
        reverbDecay: 0.85, reverbDamp: 0.4, reverbSend: 0.7, reverbMix: 0.35,
      }),
      '808': Object.assign(defaultFxParams(), {
        drive: 2.8, width: 0.8, master: 1.0,
        delayTime: 0.25, delayFeedback: 0.3, delayMix: 0.15,
        reverbDecay: 0.6, reverbDamp: 0.5, reverbSend: 0.4, reverbMix: 0.15,
      }),
      'moog': Object.assign(defaultFxParams(), {
        drive: 2.0, width: 1.4, master: 0.7,
        chorusMix: 0.6, chorusRate: 0.8, chorusDepth: 5.0,
        tremoloMix: 0.3, tremoloRate: 2.5,
        delayTime: 0.5, delayFeedback: 0.5, delayMix: 0.3,
        reverbDecay: 0.95, reverbDamp: 0.2, reverbSend: 0.9, reverbMix: 0.6,
      }),
    },
    data: () => {
      const p = new Pattern(128, 8);
      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_303 = I['303'];
      const I_dx7 = I['dx7'];
      const I_808 = I['808'];
      const I_moog = I['moog'];

      // BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39
      // Heavy four-on-the-floor industrial kick
      for (let r = 0; r < 128; r += 4) {
        p.set(r, 0, BD, I_808, 1.0);
      }
      // Offbeat open hats and steady closed hats
      for (let r = 0; r < 128; r += 2) {
        if (r % 4 === 2) {
          p.set(r, 2, OH, I_808, 0.6); // OH
        } else {
          p.set(r, 2, HH, I_808, 0.35); // HH
        }
      }
      // Heavy snare on 4 and 12
      for (let r = 0; r < 128; r += 8) {
        p.set(r + 4, 1, SD, I_808, 0.95);
        if (r % 16 === 8) {
          p.set(r + 7, 1, SD, I_808, 0.7);
        }
      }
      // Heavy industrial clap accent
      for (let r = 16; r < 112; r += 16) {
        p.set(r + 12, 6, CLAP, I_808, 0.8);
      }

      // Bassline in D minor: D (38), F (41), G (43), C (36)
      const bassProg = [
        38, 38, 50, 38, 38, 50, 38, 41,
        43, 43, 55, 43, 36, 36, 48, 36
      ];
      for (let r = 0; r < 128; r++) {
        const step = r % 16;
        const bar = Math.floor(r / 16);
        let note = bassProg[step];
        if (bar === 2 || bar === 6) {
          if (step < 8) note -= 4; // D-2 -> Bb-1 (34)
          else note -= 5; // C-2 -> G-1 (31)
        }
        if (r % 2 === 0) {
          p.set(r, 3, note, I_303, 0.95);
        } else {
          p.set(r, 3, OFF, I_303);
        }
      }

      // Moog chord drones (e.g. D-3 (50) and A-3 (57))
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        let root = 50; // D-3
        let fifth = 57; // A-3
        if (bar === 2 || bar === 6) {
          root = 46; // Bb-2
          fifth = 53; // F-3
        } else if (bar === 3 || bar === 7) {
          root = 48; // C-3
          fifth = 55; // G-3
        }
        p.set(start, 4, root, I_moog, 0.8);
        p.set(start + 12, 4, OFF, I_moog);
        p.set(start, 7, fifth, I_moog, 0.7);
        p.set(start + 12, 7, OFF, I_moog);
      }

      // Fast, urgent industrial lead/melody on DX7
      const leadMelody = [62, 65, 62, 67, 62, 69, 67, 65];
      for (let r = 8; r < 120; r += 4) {
        const idx = Math.floor(r / 4) % leadMelody.length;
        const note = leadMelody[idx];
        p.set(r, 5, note, I_dx7, 0.75);
        p.set(r + 2, 5, OFF, I_dx7);
      }

      return makeDemoPatterns(p);
    }
  },
  {
    name: "Cinematic Soundscape",
    bpm: 80,
    params: makeParams({
      '303':  { p0: [350, 0.9, 0.85, 0.3], p1: [0, 0.9, 0.8, 0] },
      'dx7':  { p0: [1.5, 3.5, 5.0, 0.6],  p1: [1, 0.9, 1.2, 5] },
      '808':  { p0: [0, 0.5, 0.8, 0.4],    p1: [0, 0, 0, 0] },
      'moog': { p0: [400, 0.6, 0.5, 0],    p1: [15, 0.8, 1.2, 0.9] },
    }),
    fxParams: {
      '303': Object.assign(defaultFxParams(), {
        drive: 1.8, width: 1.3, master: 0.8,
        chorusMix: 0.3, chorusRate: 1.2, chorusDepth: 2.5,
        delayTime: 0.6, delayFeedback: 0.5, delayMix: 0.35,
        reverbDecay: 0.85, reverbDamp: 0.3, reverbSend: 0.6, reverbMix: 0.3,
      }),
      'dx7': Object.assign(defaultFxParams(), {
        drive: 1.1, width: 1.6, master: 0.8,
        chorusMix: 0.5, chorusRate: 0.8, chorusDepth: 4.0,
        delayTime: 0.75, delayFeedback: 0.75, delayMix: 0.5,
        reverbDecay: 0.9, reverbDamp: 0.4, reverbSend: 0.8, reverbMix: 0.45,
      }),
      '808': Object.assign(defaultFxParams(), {
        drive: 1.2, width: 0.9, master: 1.0,
        delayTime: 0.3, delayFeedback: 0.2, delayMix: 0.1,
        reverbDecay: 0.9, reverbDamp: 0.4, reverbSend: 0.7, reverbMix: 0.6,
      }),
      'moog': Object.assign(defaultFxParams(), {
        drive: 1.4, width: 1.2, master: 0.9,
        chorusMix: 0.4, chorusRate: 0.5, chorusDepth: 3.0,
        delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.15,
        reverbDecay: 0.95, reverbDamp: 0.2, reverbSend: 0.9, reverbMix: 0.5,
      }),
    },
    data: () => {
      const p = new Pattern(256, 8);
      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_303 = I['303'];
      const I_dx7 = I['dx7'];
      const I_808 = I['808'];
      const I_moog = I['moog'];

      // --- Drums (808) ---
      for (let r = 0; r < 256; r += 16) {
        p.set(r, 0, BD, I_808, 0.9);
      }
      for (let r = 0; r < 256; r += 32) {
        p.set(r + 8, 1, SD, I_808, 0.7);
        p.set(r + 24, 6, CLAP, I_808, 0.55);
      }
      for (let r = 2; r < 256; r += 4) {
        p.set(r, 2, HH, I_808, 0.25);
      }

      // --- Moog Bass Drone (Channel 4) ---
      const bassRoots = [36, 31, 32, 34];
      for (let segment = 0; segment < 4; segment++) {
        const start = segment * 64;
        const note = bassRoots[segment];
        p.set(start, 4, note, I_moog, 0.8);
        p.set(start + 60, 4, OFF, I_moog);
      }

      // --- 303 Slow Sweeps (Channel 3) ---
      const arps = [
        [48, 51, 55, 59],
        [43, 46, 50, 53],
        [44, 48, 51, 55],
        [46, 50, 53, 57]
      ];
      for (let r = 0; r < 256; r += 4) {
        const seg = Math.floor(r / 64);
        const chord = arps[seg];
        const stepInSeg = Math.floor(r / 4) % 16;
        const noteIdx = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3][stepInSeg];
        const note = chord[noteIdx];
        
        p.set(r, 3, note, I_303, 0.65);
        p.set(r + 3, 3, OFF, I_303);
      }

      // --- DX7 FM Cinematic Chimes (Channel 5) ---
      const chimeMelodies = [
        [67, 72, 74, 79],
        [62, 67, 69, 74],
        [63, 68, 70, 75],
        [65, 70, 72, 77]
      ];
      for (let r = 4; r < 256; r += 8) {
        const seg = Math.floor(r / 64);
        const chord = chimeMelodies[seg];
        const stepInSeg = Math.floor((r - 4) / 8) % 8;
        const note = chord[stepInSeg % chord.length];
        
        p.set(r, 5, note, I_dx7, 0.5);
        p.set(r + 6, 5, OFF, I_dx7);
      }

      return makeDemoPatterns(p);
    }
  },
  {
    name: "Neo-Noir Synthwave",
    bpm: 105,
    params: makeParams({
      'dx7': { p0: [1, 3, 2.0, 0.3], p1: [1, 0.6, 0.9, 3] },
      'moog': { p0: [400, 0.45, 0.5, 0], p1: [8, 0.8, 0.6, 0.9] }
    }),
    fxParams: makeFx({
      'dx7': { chorusMix: 0.45, delayMix: 0.3, delayTime: 0.4 },
      'moog': { reverbMix: 0.4, reverbDecay: 0.9 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 16) {
        p.set(r, 0, 36, I['808'], 0.9);
        p.set(r + 8, 0, 36, I['808'], 0.7);
        p.set(r + 14, 0, 36, I['808'], 0.65);
        p.set(r + 4, 1, 38, I['808'], 0.85);
        p.set(r + 12, 1, 38, I['808'], 0.85);
      }
      for (let r = 0; r < 128; r += 2) {
        p.set(r, 2, 42, I['808'], 0.25);
      }
      const walk = [45, 48, 52, 50, 45, 48, 52, 50];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const note = walk[bar % walk.length];
        p.set(start, 4, note, I['moog'], 0.75);
        p.set(start + 4, 4, note + 7, I['moog'], 0.6);
        p.set(start + 8, 4, note + 12, I['moog'], 0.7);
        p.set(start + 12, 4, note + 5, I['moog'], 0.65);
      }
      const chords = [
        [57, 60, 64, 67],
        [55, 59, 62, 65],
        [53, 57, 60, 64],
        [52, 56, 59, 62]
      ];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const ch = chords[Math.floor(bar / 2) % chords.length];
        p.set(start + 4, 5, ch[0], I['dx7'], 0.45);
        p.set(start + 4, 7, ch[2], I['dx7'], 0.45);
        p.set(start + 6, 5, OFF, I['dx7']);
        p.set(start + 6, 7, OFF, I['dx7']);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Retro Acid Trance",
    bpm: 140,
    params: makeParams({
      '303': { p0: [800, 0.95, 0.85, 0.6], p1: [1, 0.3, 0.4, 0] }
    }),
    fxParams: makeFx({
      '303': { drive: 2.2, delayFeedback: 0.6, delayMix: 0.4 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 4) {
        p.set(r, 0, 36, I['808'], 1.0);
        p.set(r + 2, 2, 46, I['808'], 0.6);
      }
      for (let r = 0; r < 128; r += 16) {
        p.set(r + 12, 1, 38, I['808'], 0.8);
        p.set(r + 14, 1, 38, I['808'], 0.9);
      }
      const acid = [48, 48, 60, 48, 51, 48, 60, 51, 46, 46, 58, 46, 53, 46, 58, 53];
      for (let r = 0; r < 128; r++) {
        if (r % 16 !== 7 && r % 16 !== 15) {
          p.set(r, 3, acid[r % 16], I['303'], 0.85);
        } else {
          p.set(r, 3, OFF, I['303']);
        }
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Cyberpunk Club",
    bpm: 128,
    params: makeParams({
      '303': { p0: [1500, 0.7, 0.8, 0.5], p1: [0, 0.2, 0.3, 0] },
      'moog': { p0: [800, 0.5, 0.6, 0], p1: [20, 0.8, 0.6, 0.9] }
    }),
    fxParams: makeFx({
      '303': { drive: 3.2, width: 1.4, delayMix: 0.25 },
      'moog': { drive: 2.0, chorusMix: 0.4 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 8) {
        p.set(r, 0, 36, I['808'], 1.0);
        p.set(r + 4, 1, 38, I['808'], 0.95);
      }
      for (let r = 0; r < 128; r += 4) {
        p.set(r, 3, 38, I['303'], 0.9);
        p.set(r + 1, 3, 50, I['303'], 0.7);
        p.set(r + 3, 3, OFF, I['303']);
      }
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        let note = (bar % 4 === 3) ? 41 : 38;
        p.set(start + 2, 4, note, I['moog'], 0.8);
        p.set(start + 6, 4, OFF, I['moog']);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Chillwave Sunset",
    bpm: 95,
    params: makeParams({
      'dx7': { p0: [1, 2, 4.0, 0.1], p1: [1, 0.6, 0.9, 5] }
    }),
    fxParams: makeFx({
      'dx7': { chorusMix: 0.6, delayTime: 0.5, delayFeedback: 0.5, delayMix: 0.4 },
      'moog': { chorusMix: 0.5, reverbMix: 0.5 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 16) {
        p.set(r, 0, 36, I['808'], 0.85);
        p.set(r + 8, 1, 38, I['808'], 0.7);
        p.set(r + 12, 0, 36, I['808'], 0.6);
      }
      for (let r = 0; r < 128; r += 4) {
        p.set(r + 2, 2, 42, I['808'], 0.3);
      }
      const chords = [
        [53, 57, 60, 64],
        [55, 59, 62, 65],
        [48, 52, 55, 59],
        [45, 48, 52, 55]
      ];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const ch = chords[Math.floor(bar / 2) % chords.length];
        p.set(start, 5, ch[0], I['dx7'], 0.5);
        p.set(start, 7, ch[2], I['dx7'], 0.5);
        p.set(start + 12, 5, OFF, I['dx7']);
        p.set(start + 12, 7, OFF, I['dx7']);
        p.set(start, 4, ch[0] - 12, I['moog'], 0.7);
        p.set(start + 12, 4, OFF, I['moog']);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "IDM Glitch",
    bpm: 135,
    params: makeParams({
      '303': { p0: [600, 0.8, 0.9, 0.4], p1: [0, 0.1, 0.2, 0] }
    }),
    fxParams: makeFx({
      '808': { drive: 1.5, reverbDecay: 0.95, reverbMix: 0.6 },
      '303': { chorusMix: 0.4, delayMix: 0.3 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r++) {
        const step = r % 16;
        if (step === 0 || step === 9 || step === 14) {
          p.set(r, 0, 36, I['808'], 0.9);
        }
        if (step === 4 || step === 12) {
          p.set(r, 1, 38, I['808'], 0.85);
        }
        if (r % 32 === 28 || r % 32 === 30) {
          p.set(r, 6, 39, I['808'], 0.7);
        }
      }
      for (let r = 0; r < 128; r += 2) {
        if (r % 16 !== 6 && r % 16 !== 14) {
          const note = 48 + ((r * 7) % 24);
          p.set(r, 3, note, I['303'], 0.75);
        }
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Synth-Pop Anthem",
    bpm: 120,
    params: makeParams({
      'moog': { p0: [1200, 0.4, 0.5, 0], p1: [5, 0.8, 0.1, 0.2] }
    }),
    fxParams: makeFx({
      'dx7': { chorusMix: 0.5, delayMix: 0.25 },
      'moog': { drive: 1.3 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 4) {
        p.set(r, 0, 36, I['808'], 1.0);
        p.set(r + 2, 6, 39, I['808'], 0.8);
      }
      for (let r = 0; r < 128; r += 2) {
        const bar = Math.floor(r / 16);
        let note = 48;
        if (bar === 2 || bar === 3) note = 55;
        if (bar === 4 || bar === 5) note = 53;
        if (bar === 6 || bar === 7) note = 52;
        const isUp = (r % 4 === 2);
        p.set(r, 4, isUp ? note + 12 : note, I['moog'], 0.85);
      }
      const melody = [67, 72, 74, 76, 74, 72, 67, 72];
      for (let r = 16; r < 112; r += 4) {
        const note = melody[Math.floor(r / 4) % melody.length];
        p.set(r, 5, note, I['dx7'], 0.7);
        p.set(r + 2, 5, OFF, I['dx7']);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Cosmic Space Ambient",
    bpm: 65,
    params: makeParams({
      'moog': { p0: [300, 0.3, 0.4, 0], p1: [30, 0.9, 1.8, 1.8] }
    }),
    fxParams: makeFx({
      'moog': { reverbDecay: 0.97, reverbMix: 0.6 },
      'dx7': { delayFeedback: 0.8, delayMix: 0.5, delayTime: 0.8 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      const droneRoots = [33, 38, 41, 43];
      for (let segment = 0; segment < 4; segment++) {
        const start = segment * 32;
        p.set(start, 4, droneRoots[segment], I['moog'], 0.85);
        p.set(start + 28, 4, OFF, I['moog']);
      }
      for (let r = 8; r < 120; r += 16) {
        const notes = [69, 74, 77, 81];
        const note = notes[Math.floor(r / 16) % notes.length];
        p.set(r, 5, note, I['dx7'], 0.5);
      }
      return makeDemoPatterns(p);
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
    name: "Minimal Hypnotic",
    bpm: 126,
    params: makeParams({
      '303': { p0: [120, 0.95, 0.8, 0.2], p1: [0, 0.1, 0.1, 0] }
    }),
    fxParams: makeFx({
      '808': { drive: 1.4, delayMix: 0.15 },
      '303': { delayTime: 0.33, delayFeedback: 0.4, delayMix: 0.3 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 4) {
        p.set(r, 0, 36, I['808'], 1.0);
        p.set(r + 2, 2, 46, I['808'], 0.5);
      }
      for (let r = 0; r < 128; r += 2) {
        const notes = [41, 41, 41, 41, 44, 41, 44, 46];
        const step = Math.floor(r / 2) % notes.length;
        if (r % 8 !== 6) {
          p.set(r, 3, notes[step], I['303'], 0.7);
        }
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Chiptune Arcade",
    bpm: 150,
    params: makeParams({
      '303': { p0: [2000, 0.2, 0.5, 0], p1: [1, 0.05, 0.05, 0] }
    }),
    fxParams: makeFx({
      '303': { drive: 1.0, delayTime: 0.2, delayFeedback: 0.4, delayMix: 0.3 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 8) {
        p.set(r, 0, 36, I['808'], 0.95);
        p.set(r + 4, 1, 38, I['808'], 0.8);
      }
      const chords = [
        [60, 64, 67, 72],
        [65, 69, 72, 77],
        [67, 71, 74, 79],
        [64, 67, 71, 76]
      ];
      for (let r = 0; r < 128; r++) {
        const chord = chords[Math.floor(r / 32) % chords.length];
        const note = chord[r % chord.length];
        p.set(r, 3, note, I['303'], 0.75);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Liquid Drum & Bass",
    bpm: 172,
    params: makeParams({
      'moog': { p0: [150, 0.0, 0.0, 0], p1: [0, 0.9, 0.8, 0.8] },
      'dx7': { p0: [1, 2, 3.5, 0.2], p1: [1, 0.8, 1.0, 4] }
    }),
    fxParams: makeFx({
      '808': { drive: 1.6 },
      'dx7': { chorusMix: 0.5, delayTime: 0.45, delayFeedback: 0.6, delayMix: 0.4 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 16) {
        p.set(r, 0, 36, I['808'], 1.0);
        p.set(r + 10, 0, 36, I['808'], 0.85);
        p.set(r + 4, 1, 38, I['808'], 0.95);
        p.set(r + 12, 1, 38, I['808'], 0.95);
      }
      for (let r = 0; r < 128; r += 2) {
        p.set(r, 2, 42, I['808'], 0.35);
      }
      const subs = [36, 41, 43, 39];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const note = subs[Math.floor(bar / 2) % subs.length];
        p.set(start, 4, note, I['moog'], 0.9);
        p.set(start + 12, 4, OFF, I['moog']);
      }
      const chords = [
        [60, 63, 67, 70],
        [65, 68, 72, 75],
        [67, 70, 74, 77],
        [63, 67, 70, 74]
      ];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const ch = chords[Math.floor(bar / 2) % chords.length];
        p.set(start + 4, 5, ch[0], I['dx7'], 0.45);
        p.set(start + 4, 7, ch[2], I['dx7'], 0.45);
        p.set(start + 14, 5, OFF, I['dx7']);
        p.set(start + 14, 7, OFF, I['dx7']);
      }
      return makeDemoPatterns(p);
    }
  },
  {
    name: "Future Garage",
    bpm: 130,
    params: makeParams({
      'dx7': { p0: [1, 2.5, 4.0, 0.4], p1: [0, 0.4, 0.6, 3] }
    }),
    fxParams: makeFx({
      '808': { drive: 1.2, reverbDecay: 0.8, reverbMix: 0.4 },
      'dx7': { delayTime: 0.6, delayFeedback: 0.6, delayMix: 0.45, chorusMix: 0.4 }
    }),
    data: () => {
      const p = new Pattern(128, 8);
      for (let r = 0; r < 128; r += 16) {
        p.set(r, 0, 36, I['808'], 0.9);
        p.set(r + 6, 0, 36, I['808'], 0.85);
        p.set(r + 4, 1, 38, I['808'], 0.9);
        p.set(r + 12, 1, 38, I['808'], 0.9);
        p.set(r + 2, 2, 42, I['808'], 0.3);
        p.set(r + 5, 2, 42, I['808'], 0.25);
        p.set(r + 8, 2, 46, I['808'], 0.4);
        p.set(r + 10, 2, 42, I['808'], 0.25);
        p.set(r + 14, 2, 42, I['808'], 0.3);
      }
      const subSeq = [38, 38, 38, 41, 45, 45, 45, 43];
      for (let bar = 0; bar < 8; bar++) {
        const start = bar * 16;
        const note = subSeq[bar];
        p.set(start + 2, 4, note, I['moog'], 0.85);
        p.set(start + 10, 4, note + 5, I['moog'], 0.7);
        p.set(start + 14, 4, OFF, I['moog']);
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
];

export function demoSong() {
  return DEMO_SONGS[0].data();
}
