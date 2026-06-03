// Song = ordered list of patterns + the default instrument parameter banks, plus
// a built-in demo so the app makes sound on first load.
import { Pattern, OFF, EMPTY } from './pattern.js';
import { INSTRUMENTS, INSTRUMENT_COLORS } from '../constants.js';
import { defaultFxParams } from '../gl/effects.js';

// MIDI note → 808 drum slot (GM-ish drum map). The 808 shader reads the slot
// from uP0.x; the note itself only selects which drum, not a pitch.
export const DRUM_MAP = { 36: 0, 38: 1, 42: 2, 46: 3, 39: 4, 41: 5, 45: 6, 48: 7, 56: 8 };

// Build the instrument table from a song's per-engine-type param banks. Produces
// one instance per engine in INSTRUMENTS order, so existing pattern `inst` values
// (0=303, 1=dx7, 2=808, 3=moog) keep resolving to the right engine + params. The
// UI can append more instances (e.g. a second 303) on top at runtime.
export function instrumentsFromParams(params) {
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

      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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

      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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

      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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

      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
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
      return { patterns: [p], order: [0], rowsPerBeat: 4 };
    }
  },
];

export function demoSong() {
  return DEMO_SONGS[0].data();
}
