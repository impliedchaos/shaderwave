import { Pattern, OFF, EMPTY } from './pattern.js';
import { INSTRUMENTS } from '../constants.js';
import { defaultFxParams } from '../gl/effects.js';
import { targetByCode, normByte } from './automation.js';

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
    // p0.w = filter keyboard tracking; p2 = (osc1/2/3 wave, glide s); p3 =
    // (osc1/2/3 octave, noise mix). Defaults: three saws at 8', no glide/noise.
    'moog': { p0: [800, 0.45, 0.5, 0],   p1: [8, 0.8, 0.6, 0.9], p2: [1, 1, 1, 0], p3: [2, 2, 2, 0] },
  };
}

export function makeParams(overrides) {
  const p = defaultParams();
  for (const k in overrides) {
    if (overrides[k].p0) p[k].p0 = [...overrides[k].p0];
    if (overrides[k].p1) p[k].p1 = [...overrides[k].p1];
    if (overrides[k].p2) p[k].p2 = [...overrides[k].p2];
    if (overrides[k].p3) p[k].p3 = [...overrides[k].p3];
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
      { name: "Moog Bass A", type: "moog", p0: [150, 0.7, 0.8, 0], p1: [4, 0.9, 0.5, 0.8], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] },
      { name: "Moog Bass B", type: "moog", p0: [120, 0.8, 0.9, 0], p1: [6, 0.95, 0.6, 0.9], p2: [2, 2, 1, 0], p3: [2, 2, 2, 0] },
      { name: "Moog Lead A", type: "moog", p0: [900, 0.3, 0.4, 0.35], p1: [12, 0.5, 0.7, 0.4], p2: [1, 2, 1, 0.05], p3: [2, 2, 3, 0] },
      { name: "Moog Lead B", type: "moog", p0: [1400, 0.2, 0.3, 0.4], p1: [16, 0.4, 0.8, 0.3], p2: [1, 3, 2, 0.04], p3: [2, 3, 2, 0] }
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

      // ---- automation helpers ----
      // Resonance climb (303, inst-scope): rides the acid lead from smooth to
      // screaming self-oscillation across the pattern.
      const RES = targetByCode('303', 'RES');     // 0..0.98
      const resClimb = (pat, ch, lo, hi) => {
        const loB = normByte(RES, lo), hiB = normByte(RES, hi);
        for (let r = 0; r < 128; r++) pat.setFx(r, ch, RES.id, Math.round(loB + (hiB - loB) * (r / 127)));
      };
      // Reverb swell (moog, fx-scope → track-wide for the engine): drenches the
      // breakdown. Written on a live moog channel so it resolves to the moog chain.
      const MRV = targetByCode('moog', 'RVM');    // reverbMix 0..1
      const revSwell = (pat, ch, lo, hi) => {
        const loB = normByte(MRV, lo), hiB = normByte(MRV, hi);
        for (let r = 0; r < 128; r++) pat.setFx(r, ch, MRV.id, Math.round(loB + (hiB - loB) * (r / 127)));
      };

      // Playback map details
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

      // ---- automation ----
      // Acid leads scream upward in resonance through the lead sections (303 lead
      // is on ch5, with a second lead on ch6 in p9).
      resClimb(p8, 5, 0.60, 0.95);
      resClimb(p9, 5, 0.65, 0.97); resClimb(p9, 6, 0.60, 0.95);
      resClimb(p12, 5, 0.70, 0.97);
      // The breakdown (p10) drowns the moog in reverb; the riser (p11) snaps it
      // dry again on its first row so the drop hits clean.
      revSwell(p10, 3, 0.40, 0.85);
      p11.setFx(0, 3, MRV.id, normByte(MRV, 0.40));

      return {
        patterns: [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13],
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 12, 13],
        rowsPerBeat: 4
      };
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
      { name: "Fat Moog Lead", type: "moog", p0: [1200, 0.4, 0.5, 0.35], p1: [8, 0.8, 0.6, 0.9], p2: [1, 1, 2, 0.05], p3: [2, 2, 3, 0] },
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
        order: [0, 1, 2, 3, 4, 5, 6, 2, 3, 4, 5, 6, 6, 7, 7, 0],
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
      { name: "Warm Pad", type: "moog", p0: [400, 0.2, 0.3, 0.1], p1: [15.0, 0.8, 1.5, 1.2], p2: [1, 1, 0, 0], p3: [2, 2, 1, 0.05] },
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
      { name: "Soaring Moog Lead", type: "moog", p0: [900, 0.4, 0.6, 0.45], p1: [6.0, 0.9, 0.8, 0.6], p2: [1, 1, 2, 0.08], p3: [2, 3, 2, 0] }
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

      const v1Bass = [
        [[0, 44], [14, 39]],
        [[0, 43], [14, 37]],
        [[0, 41], [14, 39]],
        [[0, 43], [8, 39], [10, 41], [12, 44], [14, 46]],
        [[0, 44], [14, 39]],
        [[0, 43], [14, 37]],
        [[0, 41], [14, 39]],
        [[0, 43], [8, 39], [10, 41], [12, 44], [14, 48]],
      ];

      const v2Bass = [
        [[0, 46], [14, 41]],
        [[0, 44], [14, 37]],
        [[0, 39], [14, 37]],
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]],
        [[0, 44], [14, 39]],
        [[0, 43], [14, 36]],
        [[0, 37], [14, 34]],
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]],
      ];

      const chorusBass = [
        [[0, 44], [14, 39]],
        [[0, 43], [14, 36]],
        [[0, 37], [14, 34]],
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]],
        [[0, 44], [14, 39]],
        [[0, 43], [14, 36]],
        [[0, 37], [14, 34]],
        [[0, 39], [8, 39], [10, 41], [12, 44], [14, 46]],
      ];

      const bridgeBass = [
        [[0, 44], [14, 39]],
        [[0, 43], [14, 37]],
        [[0, 41], [14, 39]],
        [[0, 43], [8, 43], [12, 44]],
        [[0, 46], [14, 44]],
        [[0, 43], [14, 39]],
        [[0, 37], [14, 37]],
        [[0, 44], [14, 44]],
        [[0, 46], [14, 44]],
        [[0, 43], [14, 39]],
        [[0, 37], [14, 37]],
        [[0, 44], [14, 44]],
        [[0, 46], [4, 41], [14, 34]],
        [],
        [[0, 51], [4, 46], [14, 39]],
        [[8, 39], [10, 41], [12, 44], [14, 46]],
      ];

      const v1Chords = [
        [56, 60, 63],
        [55, 58, 62],
        [53, 56, 60],
        [55, 58, 62],
        [56, 60, 63],
        [55, 58, 62],
        [53, 56, 60],
        [55, 58, 62],
      ];

      const v2Chords = [
        [58, 62, 65],
        [56, 60, 63],
        [51, 55, 58],
        [51, 55, 58],
        [56, 60, 63],
        [51, 55, 60],
        [49, 53, 56],
        [51, 55, 58],
      ];

      const chorusChords = [
        [56, 60, 63],
        [51, 55, 60],
        [49, 53, 56],
        [51, 55, 58],
        [56, 60, 63],
        [51, 55, 60],
        [49, 53, 56],
        [51, 55, 58],
      ];

      const bridgeChords = [
        [56, 60, 63],
        [55, 58, 62],
        [53, 56, 60],
        [55, 58, 62],
        [58, 62, 65],
        [55, 58, 62],
        [49, 53, 56],
        [56, 60, 63],
        [58, 62, 65],
        [55, 58, 62],
        [49, 53, 56],
        [56, 60, 63],
        [58, 62, 65],
        [58, 62, 65],
        [51, 55, 58],
        [51, 55, 58],
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
            let note = 74;
            if (bar === 3 || bar === 7) note = 72;
            pat.set(r, ch, note + transpose, inst, vol);
          } else if (step === 4 || step === 8 || step === 12) {
            let note = 77;
            if (bar === 6) note = 75;
            pat.set(r, ch, note + transpose, inst, vol);
          } else if (step === 6 || step === 14) {
            let note = 82;
            if (bar === 1 || bar === 7) note = 81;
            else if (bar === 2) note = 79;
            else if (bar === 4) note = 77;
            else if (bar === 5) note = 82;
            else if (bar === 6) note = 79;
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

      writeBass(p0, v1Bass);
      writePads(p0, v1Chords);

      writeBass(p1, v1Bass);
      writePads(p1, v1Chords);
      setChimeMelody(p1, 5, I_chime, 0.7);

      setGatedDrums(p2, true, false, true);
      writeBass(p2, v1Bass);
      writePads(p2, v1Chords);
      setChimeMelody(p2, 5, I_chime, 0.7);

      setGatedDrums(p3, true, true, true);
      writeBass(p3, v2Bass);
      writePads(p3, v2Chords);
      setChimeMelody(p3, 5, I_chime, 0.65);

      setGatedDrums(p4, true, true, true);
      writeBass(p4, chorusBass);
      writePads(p4, chorusChords);
      setChimeMelody(p4, 5, I_chime, 0.75, 12);

      writeBass(p5, bridgeBass.slice(0, 8));
      writePads(p5, bridgeChords.slice(0, 8));

      setGatedDrums(p6, false, false, true);
      writeBass(p6, bridgeBass.slice(8, 16));
      writePads(p6, bridgeChords.slice(8, 16));
      for (let r = 96; r < 128; r++) {
        if (r % 2 === 0 || r >= 112) {
          p6.set(r, 1, SD, I_808, 0.4 + ((r - 96) / 32) * 0.55);
        }
      }

      setGatedDrums(p7, true, true, true);
      writeBass(p7, v1Bass, 3);
      writePads(p7, v1Chords, 3);
      setChimeMelody(p7, 5, I_chime, 0.7, 3);

      setGatedDrums(p8, true, true, true);
      writeBass(p8, v2Bass, 3);
      writePads(p8, v2Chords, 3);
      setChimeMelody(p8, 5, I_chime, 0.75, 15);
      setSoaringMoog(p8, 6, I_moog, 0.75, 3);

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
      { name: "Moog Warm Bass", type: "moog", p0: [180, 0.15, 0.7, 0], p1: [2.0, 0.95, 0.8, 1.2], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] },
      { name: "303 Shimmer", type: "303", p0: [1800, 0.25, 0.3, 0.15], p1: [1.0, 0.1, 0.6, 0] },
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
      { name: "Moog Ethereal Sub", type: "moog", p0: [120, 0.08, 0.85, 0.1], p1: [1.0, 0.98, 1.2, 1.5], p2: [1, 1, 0, 0], p3: [2, 2, 2, 0.04] },
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { chorusMix: 0.6, chorusRate: 0.5, chorusDepth: 3.5, delayMix: 0.45, delayTime: 0.6, delayFeedback: 0.55, reverbMix: 0.7, reverbDecay: 0.95 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.5, chorusRate: 0.4, chorusDepth: 3.0, delayMix: 0.4, delayTime: 0.5, delayFeedback: 0.45, reverbMix: 0.75, reverbDecay: 0.95 }),
      '808': defaultFxParams(),
      'moog': Object.assign(defaultFxParams(), { chorusMix: 0.35, chorusRate: 0.3, chorusDepth: 2.5, delayMix: 0.3, delayTime: 0.45, delayFeedback: 0.4, reverbMix: 0.65, reverbDecay: 0.93 }),
    },
    data: () => {
      const CH = 8;
      const I_pad = 0, I_bass = 1, I_shimmer = 2, I_bell = 3, I_sub = 4;

      const p = [];
      for (let i = 0; i < 8; i++) p.push(new Pattern(128, CH));

      const chords = {
        D:   [62, 66, 69],
        Bm:  [59, 62, 66],
        G:   [55, 59, 62],
        A:   [57, 61, 64],
        Em:  [52, 55, 59],
        Fm:  [54, 57, 61],
      };

      const highChords = {
        D:   [74, 78, 81],
        Bm:  [71, 74, 78],
        G:   [67, 71, 74],
        A:   [69, 73, 76],
        Em:  [64, 67, 71],
        Fm:  [66, 69, 73],
      };

      const bassNotes = {
        D: 38, Bm: 47, G: 43, A: 45, Em: 40, Fm: 42,
      };

      const subNotes = {
        D: 38, Bm: 35, G: 31, A: 33, Em: 28, Fm: 30,
      };

      const writePadChords = (pat, progression, vol = 0.5) => {
        progression.forEach((chordName, barIdx) => {
          const startRow = barIdx * 16;
          const chord = chords[chordName];
          chord.forEach((note, ni) => {
            pat.set(startRow, 0 + ni, note, I_pad, vol);
          });
          if (barIdx < progression.length - 1) {
            chord.forEach((_, ni) => {
              pat.set(startRow + 15, 0 + ni, OFF, I_pad);
            });
          } else {
            chord.forEach((_, ni) => {
              pat.set(127, 0 + ni, OFF, I_pad);
            });
          }
        });
      };

      const writeBassLine = (pat, progression, vol = 0.65) => {
        progression.forEach((chordName, barIdx) => {
          const startRow = barIdx * 16;
          const rootNote = bassNotes[chordName];
          pat.set(startRow, 3, rootNote, I_bass, vol);
          pat.set(startRow + 8, 3, rootNote + 12, I_bass, vol * 0.8);
          if (barIdx < progression.length - 1) {
            const nextRoot = bassNotes[progression[barIdx + 1]];
            pat.set(startRow + 14, 3, nextRoot - 1, I_bass, vol * 0.5);
          }
        });
      };

      const writeSubDrone = (pat, progression, vol = 0.4) => {
        for (let barIdx = 0; barIdx < progression.length; barIdx += 2) {
          const startRow = barIdx * 16;
          const note = subNotes[progression[barIdx]];
          pat.set(startRow, 7, note, I_sub, vol);
          pat.set(startRow + 31, 7, OFF, I_sub);
        }
      };

      const writeShimmerArp = (pat, progression, vol = 0.3) => {
        progression.forEach((chordName, barIdx) => {
          const startRow = barIdx * 16;
          const notes = highChords[chordName];
          for (let step = 0; step < 16; step += 4) {
            const noteIdx = (step / 4) % notes.length;
            pat.set(startRow + step, 4, notes[noteIdx], I_shimmer, vol);
            pat.set(startRow + step + 3, 4, OFF, I_shimmer);
          }
        });
      };

      const writeBellMelody = (pat, melody, vol = 0.35) => {
        melody.forEach(([row, note, dur]) => {
          pat.set(row, 5, note, I_bell, vol);
          if (dur) pat.set(row + dur, 5, OFF, I_bell);
        });
      };

      const verse =  ['D', 'Bm', 'G', 'A',  'D', 'Bm', 'G', 'A'];
      const bridge = ['Em', 'G', 'A', 'Fm', 'Em', 'G', 'A', 'Fm'];
      const climax = ['D', 'A', 'Bm', 'G',  'D', 'A', 'Bm', 'G'];
      const outro =  ['G', 'A', 'D', 'D',   'G', 'A', 'D', 'D'];

      const bellMelody1 = [
        [4,  78, 6],
        [16, 81, 8],
        [32, 74, 6],
        [48, 76, 10],
        [68, 78, 6],
        [80, 81, 10],
        [100, 74, 6],
        [112, 78, 10],
      ];

      const bellMelody2 = [
        [0,  81, 10],
        [20, 78, 6],
        [32, 83, 8],
        [48, 81, 10],
        [64, 74, 8],
        [80, 76, 6],
        [96, 78, 10],
        [112, 81, 12],
      ];

      const bellMelody3 = [
        [8,  74, 8],
        [24, 78, 6],
        [40, 81, 10],
        [56, 83, 8],
        [72, 86, 12],
        [96, 83, 8],
        [112, 81, 12],
      ];

      const bellMelodyOutro = [
        [0,  78, 12],
        [24, 74, 12],
        [48, 69, 16],
        [80, 66, 16],
        [112, 62, 16],
      ];

      writeSubDrone(p[0], verse, 0.35);
      writePadChords(p[0], verse, 0.2);

      writePadChords(p[1], verse, 0.4);
      writeBassLine(p[1], verse, 0.45);
      writeSubDrone(p[1], verse, 0.35);

      writePadChords(p[2], verse, 0.5);
      writeBassLine(p[2], verse, 0.6);
      writeSubDrone(p[2], verse, 0.35);
      writeShimmerArp(p[2], verse, 0.2);
      writeBellMelody(p[2], bellMelody1, 0.3);

      writePadChords(p[3], bridge, 0.55);
      writeBassLine(p[3], bridge, 0.65);
      writeSubDrone(p[3], bridge, 0.4);
      writeShimmerArp(p[3], bridge, 0.28);
      writeBellMelody(p[3], bellMelody2, 0.35);

      writePadChords(p[4], climax, 0.6);
      writeBassLine(p[4], climax, 0.7);
      writeSubDrone(p[4], climax, 0.45);
      writeShimmerArp(p[4], climax, 0.35);
      writeBellMelody(p[4], bellMelody3, 0.4);

      writePadChords(p[5], climax, 0.6);
      writeBassLine(p[5], climax, 0.7);
      writeSubDrone(p[5], climax, 0.45);
      writeShimmerArp(p[5], climax, 0.35);
      writeBellMelody(p[5], bellMelody3.map(([r, n, d]) => [r, n + 5, d]), 0.4);

      writePadChords(p[6], verse, 0.45);
      writeBassLine(p[6], verse, 0.5);
      writeSubDrone(p[6], verse, 0.35);
      writeShimmerArp(p[6], verse, 0.22);
      writeBellMelody(p[6], bellMelody1, 0.28);

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
      {
        name: "DX7 Glass String",
        type: "dx7",
        p0: [1, 2.5, 3.0, 0.5],
        p1: [5, 0.6, 0.85, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 2,  decay: 2.5,  mode: 0, sustain: 0.8,  release: 1.8 },
          { coarse: 1.0, fine: 2, level: 78, detune: -2, decay: 2.0,  mode: 0, sustain: 0.7,  release: 1.5 },
          { coarse: 2.0, fine: 0, level: 90, detune: 4,  decay: 1.8,  mode: 0, sustain: 0.75, release: 1.6 },
          { coarse: 3.0, fine: 0, level: 55, detune: -3, decay: 1.2,  mode: 0, sustain: 0.5,  release: 1.0 },
          { coarse: 0.5, fine: 0, level: 95, detune: 5,  decay: 3.0,  mode: 0, sustain: 0.9,  release: 2.0 },
          { coarse: 1.0, fine: 0, level: 65, detune: 0,  decay: 2.2,  mode: 0, sustain: 0.6,  release: 1.4 }
        ]
      },
      { name: "303 Liquid Pluck", type: "303", p0: [650, 0.45, 0.5, 0.2], p1: [1.0, 0.35, 0.45, 0] },
      { name: "808 Clean Kit", type: "808", p0: [0, 0.5, 0.45, 0.6], p1: [0, 0, 0, 0] },
      { name: "Moog Warm Bass", type: "moog", p0: [150, 0.1, 0.75, 0], p1: [2.0, 0.95, 0.7, 1.0], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] },
      { name: "Moog Soaring Lead", type: "moog", p0: [900, 0.35, 0.45, 0.45], p1: [15.0, 0.6, 0.8, 0.6], p2: [1, 1, 2, 0.07], p3: [2, 3, 2, 0] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, delayMix: 0.4, chorusMix: 0.4 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.55, chorusRate: 1.2, delayMix: 0.35, reverbMix: 0.6, reverbDecay: 0.93 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false }),
      'moog': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, chorusMix: 0.3, delayMix: 0.3, reverbMix: 0.35 }),
    },
    data: () => {
      const p = [];
      for (let i = 0; i < 12; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39, RIM = 37;
      const I_pad = 0, I_303 = 1, I_808 = 2, I_bass = 3, I_lead = 4;

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

      const writePadsAndBass = (pat, isMajor = false, volP = 0.45, volB = 0.65) => {
        const prog = isMajor ? majorProg : minorProg;
        const voicings = isMajor ? majorVoicings : minorVoicings;
        const bass = isMajor ? majorBass : minorBass;
        const padChannels = [0, 3, 4, 7];

        prog.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];

          padChannels.forEach(ch => {
            for (let step = 0; step < 16; step++) {
              pat.clear(start + step, ch);
            }
          });

          for (let step = 0; step < 16; step += 2) {
            const i = step / 2;
            const noteIndex = i % voicing.length;
            const isHighOctave = Math.floor(i / voicing.length) % 2 === 1;
            const note = voicing[noteIndex] + 12 + (isHighOctave ? 12 : 0);
            const channel = padChannels[i % padChannels.length];

            pat.set(start + step, channel, note, I_pad, volP);
            const offRow = start + step + 3;
            if (offRow < pat.rows) {
              pat.set(offRow, channel, OFF, I_pad);
            }
          }

          pat.set(start, 5, bass[chordName], I_bass, volB);
          pat.set(start + 15, 5, OFF, I_bass);
        });
      };

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

      const write303Pluck = (pat, isMajor = false, density = 0.5, vol = 0.65) => {
        const prog = isMajor ? majorProg : minorProg;
        const voicings = isMajor ? majorVoicings : minorVoicings;

        prog.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = voicings[chordName];
          const notes = voicing.map(n => n + 24);
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

      const writeDrums = (pat, style = 'dreamy') => {
        for (let r = 0; r < 128; r++) {
          const step = r % 16;
          if (style === 'dreamy') {
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

      const writeLead = (pat, melody, vol = 0.72) => {
        melody.forEach(([row, note, dur]) => {
          pat.set(row, 6, note, I_lead, vol);
          if (dur) pat.set(row + dur, 6, OFF, I_lead);
        });
      };

      writePadsAndBass(p[0], false, 0.35, 0.5);

      writePadsAndBass(p[1], false, 0.4, 0.55);
      writeDrums(p[1], 'dreamy');

      writePadsAndBass(p[2], false, 0.4, 0.6);
      writeDrums(p[2], 'dreamy');
      write303Pluck(p[2], false, 0.4, 0.6);

      writePadsAndBass(p[3], false, 0.45, 0.6);
      writeDrums(p[3], 'dreamy');
      write303Pluck(p[3], false, 0.6, 0.6);
      writeLead(p[3], [
        [0, 57, 12], [16, 60, 12], [32, 64, 16], [64, 57, 12], [80, 60, 12], [96, 62, 24]
      ], 0.65);

      writePadsAndBass(p[4], false, 0.45, 0.65);
      writeDrums(p[4], 'dreamy');
      write303Pluck(p[4], false, 0.5, 0.6);
      writeLead(p[4], [
        [0, 57, 12], [16, 60, 12], [32, 64, 16], [64, 69, 12], [80, 67, 12], [96, 64, 24]
      ], 0.65);

      writePadsAndBass(p[5], true, 0.45, 0.7);
      writeDrivingBass(p[5], true, 0.7);
      writeDrums(p[5], 'climax');
      write303Pluck(p[5], true, 0.7, 0.65);

      writePadsAndBass(p[6], true, 0.5, 0.7);
      writeDrivingBass(p[6], true, 0.7);
      writeDrums(p[6], 'climax');
      write303Pluck(p[6], true, 0.8, 0.65);
      writeLead(p[6], [
        [0, 61, 4], [8, 64, 4], [16, 68, 8], [32, 63, 4], [40, 66, 4], [48, 69, 8],
        [64, 64, 4], [72, 68, 4], [80, 71, 8], [96, 73, 4], [104, 71, 4], [112, 69, 12]
      ], 0.72);

      writePadsAndBass(p[7], true, 0.5, 0.7);
      writeDrivingBass(p[7], true, 0.7);
      writeDrums(p[7], 'climax');
      write303Pluck(p[7], true, 0.75, 0.65);
      writeLead(p[7], [
        [0, 73, 4], [8, 76, 4], [16, 80, 8], [32, 75, 4], [40, 78, 4], [48, 81, 8],
        [64, 76, 4], [72, 80, 4], [80, 83, 8], [96, 85, 4], [104, 83, 4], [112, 81, 12]
      ], 0.75);

      writePadsAndBass(p[8], true, 0.5, 0.7);
      writeDrivingBass(p[8], true, 0.7);
      writeDrums(p[8], 'half-time');
      write303Pluck(p[8], true, 0.6, 0.65);
      writeLead(p[8], [
        [0, 61, 12], [16, 64, 12], [32, 68, 16], [64, 61, 12], [80, 64, 12], [96, 69, 24]
      ], 0.72);

      writePadsAndBass(p[9], true, 0.5, 0.7);
      writeDrivingBass(p[9], true, 0.7);
      writeDrums(p[9], 'climax');
      write303Pluck(p[9], true, 0.8, 0.65);
      writeLead(p[9], [
        [0, 73, 4], [8, 76, 4], [16, 80, 8], [32, 75, 4], [40, 78, 4], [48, 81, 8],
        [64, 76, 4], [72, 80, 4], [80, 83, 8], [96, 85, 4], [104, 83, 4], [112, 81, 12]
      ], 0.75);

      writePadsAndBass(p[10], false, 0.45, 0.6);
      writeDrums(p[10], 'dreamy');
      write303Pluck(p[10], false, 0.4, 0.6);
      writeLead(p[10], [
        [0, 57, 12], [16, 52, 12], [32, 53, 12], [48, 45, 16],
        [64, 57, 12], [80, 60, 12], [96, 55, 12], [112, 52, 16]
      ], 0.7);

      writePadsAndBass(p[11], false, 0.35, 0.45);
      writeLead(p[11], [[0, 57, 32]], 0.5);

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        rowsPerBeat: 4,
        // Per-channel pan (0=L, 0.5=C, 1=R): pads spread wide (ch0/3/4/7),
        // pluck & lead nudged off-axis, drums + bass anchored centre.
        pan: [0.38, 0.35, 0.5, 0.62, 0.3, 0.5, 0.55, 0.7],
      };
    }
  },
  {
    name: "Lance's Left Nut",
    bpm: 125,
    params: [
      {
        name: "DX7 Retro Brass",
        type: "dx7",
        p0: [1.0, 1.0, 2.5, 0.4],
        p1: [12, 0.4, 0.6, 0],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 4,  decay: 1.5, mode: 0, sustain: 0.85, release: 1.5 },
          { coarse: 1.0, fine: 1, level: 90, detune: -4, decay: 1.2, mode: 0, sustain: 0.8,  release: 1.2 },
          { coarse: 2.0, fine: 0, level: 85, detune: 5,  decay: 1.0, mode: 0, sustain: 0.75, release: 1.0 },
          { coarse: 2.0, fine: 2, level: 75, detune: -5, decay: 0.8, mode: 0, sustain: 0.7,  release: 0.8 },
          { coarse: 0.5, fine: 0, level: 95, detune: 2,  decay: 2.0, mode: 0, sustain: 0.9,  release: 1.8 },
          { coarse: 1.0, fine: 0, level: 65, detune: 0,  decay: 1.5, mode: 0, sustain: 0.6,  release: 1.0 }
        ]
      },
      { name: "303 Bouncy Pluck", type: "303", p0: [800, 0.6, 0.4, 0.3], p1: [1.0, 0.2, 0.3, 0] },
      { name: "808 Synthpop Kit", type: "808", p0: [0, 0.55, 0.4, 0.5], p1: [0, 0, 0, 0] },
      { name: "Moog Funky Bass", type: "moog", p0: [300, 0.25, 0.6, 0], p1: [4.0, 0.9, 0.65, 0.9], p2: [2, 1, 1, 0.02], p3: [2, 2, 1, 0] },
      { name: "Moog Britpop Lead", type: "moog", p0: [1200, 0.4, 0.5, 0.4], p1: [12.0, 0.55, 0.75, 0.5], p2: [1, 2, 2, 0.05], p3: [2, 2, 3, 0] }
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

      const verseProg = ['Bm', 'G', 'Em', 'F#'];
      const chorusProg = ['D', 'Bb', 'C', 'A'];
      const bridgeProg = ['G', 'A', 'G', 'A'];

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

      const verseMelody = [
        [0, 71, 4], [4, 69, 4], [8, 66, 6], [14, 62, 2],
        [16, 67, 8], [24, 69, 4], [28, 71, 4],
        [32, 64, 4], [36, 67, 4], [40, 71, 8],
        [48, 66, 8], [56, 69, 8],
        [64, 71, 4], [68, 69, 4], [72, 66, 6], [78, 62, 2],
        [80, 67, 8], [88, 69, 4], [92, 71, 4],
        [96, 76, 8], [104, 74, 8],
        [112, 73, 8], [120, 71, 8]
      ];

      const chorusMelody = [
        [0, 74, 6], [6, 76, 2], [8, 78, 6], [14, 81, 2],
        [16, 82, 8], [24, 80, 4], [28, 78, 4],
        [32, 80, 6], [38, 78, 2], [40, 76, 6], [46, 74, 2],
        [48, 73, 8], [56, 76, 8],
        [64, 86, 6], [70, 88, 2], [72, 90, 6], [78, 93, 2],
        [80, 94, 8], [88, 93, 4], [92, 90, 4],
        [96, 91, 6], [102, 90, 2], [104, 88, 6], [110, 86, 2],
        [112, 85, 8], [120, 88, 8]
      ];

      writePads(p[0], chorusProg, 'sustained', 0.4);
      writeBass(p[0], chorusProg, 'drone', 0.6);
      writeDrums(p[0], 'basic');
      writeLead(p[0], [
        [0, 62, 12], [16, 66, 12], [32, 69, 16], [64, 62, 12], [80, 66, 12], [96, 67, 24]
      ], 0.6);

      writePads(p[1], verseProg, 'sustained', 0.38);
      writeBass(p[1], verseProg, 'driving', 0.65);
      writeDrums(p[1], 'synthpop');
      writeLead(p[1], verseMelody, 0.7);

      writePads(p[2], verseProg, 'sustained', 0.4);
      writeBass(p[2], verseProg, 'driving', 0.68);
      writeDrums(p[2], 'synthpop');
      writeErasureArp(p[2], verseProg, 0.48);
      writeLead(p[2], verseMelody, 0.72);

      writePads(p[3], bridgeProg, 'sustained', 0.45);
      writeBass(p[3], bridgeProg, 'driving', 0.7);
      writeDrums(p[3], 'synthpop');
      writeErasureArp(p[3], bridgeProg, 0.58);

      writePads(p[4], chorusProg, 'stabs', 0.48);
      writeBass(p[4], chorusProg, 'funky', 0.72);
      writeDrums(p[4], 'duran');
      writeErasureArp(p[4], chorusProg, 0.5);
      writeLead(p[4], chorusMelody, 0.75);

      writePads(p[5], chorusProg, 'stabs', 0.48);
      writeBass(p[5], chorusProg, 'funky', 0.72);
      writeDrums(p[5], 'duran');
      writeErasureArp(p[5], chorusProg, 0.5);
      writeLead(p[5], chorusMelody.map(([r, n, d]) => [r, n + 12, d]), 0.75);

      writePads(p[6], verseProg, 'sustained', 0.4);
      writeBass(p[6], verseProg, 'driving', 0.68);
      writeDrums(p[6], 'synthpop');
      writeErasureArp(p[6], verseProg, 0.45);
      writeLead(p[6], verseMelody, 0.7);

      writePads(p[7], bridgeProg, 'sustained', 0.45);
      writeBass(p[7], bridgeProg, 'driving', 0.7);
      writeDrums(p[7], 'synthpop');
      writeErasureArp(p[7], bridgeProg, 0.58);

      writePads(p[8], chorusProg, 'stabs', 0.5);
      writeBass(p[8], chorusProg, 'funky', 0.74);
      writeDrums(p[8], 'duran');
      writeErasureArp(p[8], chorusProg, 0.55);
      writeLead(p[8], chorusMelody, 0.76);

      writePads(p[9], chorusProg, 'stabs', 0.5);
      writeBass(p[9], chorusProg, 'funky', 0.74);
      writeDrums(p[9], 'duran');
      writeErasureArp(p[9], chorusProg, 0.55);
      writeLead(p[9], chorusMelody.map(([r, n, d]) => [r, n + 12, d]), 0.78);

      writePads(p[10], bridgeProg, 'sustained', 0.52);
      writeBass(p[10], bridgeProg, 'drone', 0.75);
      writeDrums(p[10], 'duran');
      writeLead(p[10], [
        [0, 67, 24], [32, 69, 24], [64, 71, 24], [96, 73, 24]
      ], 0.78);

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
      {
        name: "DX7 Clean Pluck",
        type: "dx7",
        p0: [1.0, 1.0, 1.2, 0.2],
        p1: [5, 0.35, 0.4, 1],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 2,  decay: 1.5, mode: 0, sustain: 0.0, release: 0.8 },
          { coarse: 1.0, fine: 1, level: 75, detune: -2, decay: 1.0, mode: 0, sustain: 0.0, release: 0.6 },
          { coarse: 2.0, fine: 0, level: 85, detune: 3,  decay: 0.8, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 3.0, fine: 0, level: 60, detune: -3, decay: 0.5, mode: 0, sustain: 0.0, release: 0.4 },
          { coarse: 0.5, fine: 0, level: 90, detune: 4,  decay: 2.0, mode: 0, sustain: 0.0, release: 1.0 },
          { coarse: 1.0, fine: 0, level: 50, detune: 0,  decay: 1.2, mode: 0, sustain: 0.0, release: 0.7 }
        ]
      },
      { name: "303 Heavy Chug", type: "303", p0: [400, 0.85, 0.3, 0.45], p1: [1.0, 0.1, 0.25, 0] },
      { name: "808 Bonham Kit", type: "808", p0: [0, 0.6, 0.8, 0.4], p1: [0, 0, 0, 0] },
      { name: "Moog Growl Bass", type: "moog", p0: [180, 0.15, 0.8, 0], p1: [2.0, 0.95, 0.8, 1.2], p2: [2, 2, 1, 0], p3: [2, 2, 1, 0.04] },
      { name: "Moog Rock Lead", type: "moog", p0: [950, 0.3, 0.5, 0.45], p1: [15.0, 0.7, 0.75, 0.5], p2: [1, 1, 2, 0.06], p3: [2, 3, 2, 0] }
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

      const folkProg = ['Dm', 'C', 'Bb', 'A'];

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

      const writeHeavyHelmetRiff = (pat, vol = 0.72) => {
        const riffChords = [
          [0, 38, 2], [2, 38, 1], [4, 41, 2], [8, 43, 2], [12, 44, 3],
          [16, 38, 2], [18, 38, 1], [20, 41, 1], [22, 43, 1], [24, 41, 1], [26, 38, 3],
          [32, 38, 2], [34, 38, 1], [36, 41, 2], [40, 43, 2], [44, 44, 3],
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

      const writeCleanBass = (pat, progression, vol = 0.55) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const chords = chordIntervals[chordName];
          pat.set(start, 5, chords.root - 12, I_bass, vol);
          pat.set(start + 15, 5, OFF, I_bass);
        });
      };

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
              pat.set(r, 2, CLAP, I_808, 0.85);
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

      const folkMelody = [
        [0, 62, 12], [16, 64, 12], [32, 65, 16], [48, 67, 16],
        [64, 69, 12], [80, 67, 12], [96, 65, 16], [112, 64, 16]
      ];

      const metalLead = [
        [0, 74, 4], [8, 77, 4], [16, 79, 8], [32, 80, 4], [40, 79, 4], [48, 77, 12],
        [64, 74, 4], [72, 77, 4], [80, 79, 8], [96, 82, 4], [104, 79, 4], [112, 77, 12]
      ];

      writeAcousticClean(p[0], folkProg, 0.42);
      writeCleanBass(p[0], folkProg, 0.5);
      writeRockDrums(p[0], 'clean');

      writeAcousticClean(p[1], folkProg, 0.42);
      writeCleanBass(p[1], folkProg, 0.5);
      writeRockDrums(p[1], 'clean');
      writeLead(p[1], folkMelody, 0.68);

      writeAcousticClean(p[2], folkProg, 0.45);
      writeCleanBass(p[2], folkProg, 0.55);
      writeRockDrums(p[2], 'clean');
      writeLead(p[2], folkMelody.map(([r, n, d]) => [r, n + 5, d]), 0.68);

      writeAcousticClean(p[3], folkProg, 0.48);
      writeCleanBass(p[3], folkProg, 0.6);
      writeRockDrums(p[3], 'bonham');
      writeLead(p[3], folkMelody, 0.7);

      writeHeavyHelmetRiff(p[4], 0.72);
      writeHeavyBass(p[4], 0.72);
      writeRockDrums(p[4], 'helmet');

      writeHeavyHelmetRiff(p[5], 0.72);
      writeHeavyBass(p[5], 0.72);
      writeRockDrums(p[5], 'helmet');
      writeLead(p[5], metalLead, 0.72);

      writeHeavyHelmetRiff(p[6], 0.75);
      writeHeavyBass(p[6], 0.75);
      writeRockDrums(p[6], 'helmet');
      writeLead(p[6], metalLead.map(([r, n, d]) => [r, n + 12, d]), 0.75);

      writeHeavyHelmetRiff(p[7], 0.7);
      writeHeavyBass(p[7], 0.7);
      writeRockDrums(p[7], 'bonham');
      writeLead(p[7], [
        [0, 62, 4], [4, 65, 4], [8, 67, 8], [20, 67, 4], [24, 65, 4], [28, 62, 4],
        [32, 60, 4], [36, 62, 4], [40, 65, 8], [52, 65, 4], [56, 62, 4], [60, 60, 4],
        [64, 62, 4], [68, 65, 4], [72, 67, 8], [84, 67, 4], [88, 65, 4], [92, 62, 4],
        [96, 69, 4], [100, 72, 4], [104, 74, 8], [116, 74, 4], [120, 72, 4], [124, 69, 4]
      ], 0.75);

      writeHeavyHelmetRiff(p[8], 0.72);
      writeHeavyBass(p[8], 0.72);
      writeRockDrums(p[8], 'bonham');
      writeLead(p[8], [
        [0, 74, 4], [4, 77, 4], [8, 79, 8], [20, 79, 4], [24, 77, 4], [28, 74, 4],
        [32, 72, 4], [36, 74, 4], [40, 77, 8], [52, 77, 4], [56, 74, 4], [60, 72, 4],
        [64, 74, 4], [68, 77, 4], [72, 79, 8], [84, 79, 4], [88, 77, 4], [92, 74, 4],
        [96, 81, 4], [100, 84, 4], [104, 86, 8], [116, 86, 4], [120, 84, 4], [124, 81, 4]
      ], 0.78);

      writeAcousticClean(p[9], folkProg, 0.4);
      writeCleanBass(p[9], folkProg, 0.5);
      writeRockDrums(p[9], 'clean');

      writeAcousticClean(p[10], folkProg, 0.42);
      writeCleanBass(p[10], folkProg, 0.5);
      writeRockDrums(p[10], 'clean');
      writeLead(p[10], folkMelody, 0.68);

      writeAcousticClean(p[11], folkProg, 0.45);
      writeCleanBass(p[11], folkProg, 0.6);
      writeRockDrums(p[11], 'bonham');
      writeLead(p[11], folkMelody.map(([r, n, d]) => [r, n + 5, d]), 0.7);

      writeHeavyHelmetRiff(p[12], 0.76);
      writeHeavyBass(p[12], 0.76);
      writeRockDrums(p[12], 'bonham');
      writeLead(p[12], metalLead, 0.78);

      writeHeavyHelmetRiff(p[13], 0.76);
      writeHeavyBass(p[13], 0.76);
      writeRockDrums(p[13], 'bonham');
      writeLead(p[13], metalLead.map(([r, n, d]) => [r, n + 12, d]), 0.8);

      writeAcousticClean(p[14], folkProg, 0.38);
      writeCleanBass(p[14], folkProg, 0.45);
      writeRockDrums(p[14], 'clean');
      writeLead(p[14], [[0, 62, 32]], 0.55);

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
      {
        name: "DX7 Chiptune Bell",
        type: "dx7",
        p0: [1.0, 1.0, 1.0, 0.15],
        p1: [8, 0.2, 0.35, 1],
        ops: [
          { coarse: 2.0, fine: 0, level: 99, detune: 2,  decay: 0.8, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 4.0, fine: 1, level: 80, detune: -2, decay: 0.5, mode: 0, sustain: 0.0, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 90, detune: 0,  decay: 1.2, mode: 0, sustain: 0.0, release: 0.7 },
          { coarse: 3.0, fine: 0, level: 70, detune: 3,  decay: 0.4, mode: 0, sustain: 0.0, release: 0.3 },
          { coarse: 0.5, fine: 0, level: 95, detune: -3, decay: 1.8, mode: 0, sustain: 0.0, release: 1.0 },
          { coarse: 1.0, fine: 0, level: 50, detune: 0,  decay: 1.0, mode: 0, sustain: 0.0, release: 0.6 }
        ]
      },
      { name: "303 Square Lead", type: "303", p0: [900, 0.4, 0.45, 0.25], p1: [1.0, 0.15, 0.25, 0] },
      { name: "808 Latchkey Kit", type: "808", p0: [0, 0.5, 0.45, 0.5], p1: [0, 0, 0, 0] },
      { name: "Moog Triangle Bass", type: "moog", p0: [150, 0.05, 0.8, 0], p1: [1.0, 0.98, 0.8, 1.0], p2: [0, 0, 1, 0], p3: [2, 1, 2, 0] },
      { name: "Moog Pulse Lead", type: "moog", p0: [1000, 0.25, 0.45, 0.4], p1: [12.0, 0.6, 0.75, 0.5], p2: [3, 4, 3, 0.05], p3: [2, 2, 3, 0] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: true, bitcrushBits: 8.0, bitcrushRate: 8000.0, chorusMix: 0.3, delayMix: 0.35, delayFeedback: 0.4 }),
      'dx7': Object.assign(defaultFxParams(), { bitcrushOn: true, bitcrushBits: 10.0, bitcrushRate: 12000.0, chorusMix: 0.4, delayMix: 0.3, reverbMix: 0.45 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: true, bitcrushBits: 6.0, bitcrushRate: 6000.0 }),
      'moog': Object.assign(defaultFxParams(), { distOn: false, bitcrushOn: false, chorusMix: 0.3, delayMix: 0.25 }),
    },
    data: () => {
      const p = [];
      for (let i = 0; i < 15; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39, RIM = 37;
      const I_pad = 0, I_303 = 1, I_808 = 2, I_bass = 3, I_lead = 4;

      const rpgProg = ['Am', 'Dm', 'G', 'C', 'F', 'Bdim', 'E7', 'Am'];
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
            pat.set(row, 7, note, I_lead, vol);
            if (dur && row + dur < pat.rows) {
              pat.set(row + dur, 7, OFF, I_lead);
            }
          }
        });
      };

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

      writeBells(p[0], rpgProg, 'mystical', 0.4);
      writeBass(p[0], rpgProg, 'slow', 0.55);
      writeDrums(p[0], 'slow');

      writeBells(p[1], rpgProg, 'mystical', 0.42);
      writeBass(p[1], rpgProg, 'slow', 0.55);
      writeDrums(p[1], 'slow');
      writeLead(p[1], mysticalMelody, 0.7);

      writeBells(p[2], rpgProg, 'mystical', 0.42);
      writeBass(p[2], rpgProg, 'slow', 0.58);
      writeDrums(p[2], 'slow');
      writeLead(p[2], mysticalMelody.map(([r, n, d]) => [r, n + 5, d]), 0.7);

      writeBells(p[3], rpgProg, 'arpeggio', 0.35);
      writeBass(p[3], rpgProg, 'slow', 0.6);
      writeDrums(p[3], 'slow');
      writePulseArp(p[3], rpgProg, 0.5);

      writeBells(p[4], shmupProg, 'arpeggio', 0.35);
      writeBass(p[4], shmupProg, 'fast', 0.65);
      writeDrums(p[4], 'fast');
      writePulseArp(p[4], shmupProg, 0.52);

      writeBells(p[5], shmupProg, 'arpeggio', 0.35);
      writeBass(p[5], shmupProg, 'fast', 0.65);
      writeDrums(p[5], 'fast');
      writePulseArp(p[5], shmupProg, 0.52);
      writeLead(p[5], actionMelody, 0.72);

      writeBells(p[6], shmupProg, 'arpeggio', 0.38);
      writeBass(p[6], shmupProg, 'fast', 0.68);
      writeDrums(p[6], 'fast');
      writePulseArp(p[6], shmupProg, 0.55);
      writeLead(p[6], actionMelody.map(([r, n, d]) => [r, n + 12, d]), 0.72);

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

      writeBells(p[9], rpgProg, 'mystical', 0.4);
      writeBass(p[9], rpgProg, 'slow', 0.52);
      writeDrums(p[9], 'slow');

      writeBells(p[10], rpgProg, 'mystical', 0.42);
      writeBass(p[10], rpgProg, 'slow', 0.55);
      writeDrums(p[10], 'slow');
      writeLead(p[10], mysticalMelody, 0.68);

      writeBells(p[11], rpgProg, 'arpeggio', 0.35);
      writeBass(p[11], rpgProg, 'slow', 0.6);
      writeDrums(p[11], 'slow');
      writePulseArp(p[11], rpgProg, 0.5);

      writeBells(p[12], shmupProg, 'arpeggio', 0.38);
      writeBass(p[12], shmupProg, 'fast', 0.68);
      writeDrums(p[12], 'fast');
      writePulseArp(p[12], shmupProg, 0.55);
      writeLead(p[12], actionMelody, 0.74);

      writeBells(p[13], shmupProg, 'arpeggio', 0.38);
      writeBass(p[13], shmupProg, 'fast', 0.68);
      writeDrums(p[13], 'fast');
      writePulseArp(p[13], shmupProg, 0.55);
      writeLead(p[13], actionMelody.map(([r, n, d]) => [r, n + 12, d]), 0.75);

      writeBells(p[14], rpgProg, 'mystical', 0.38);
      writeBass(p[14], rpgProg, 'slow', 0.48);
      writeDrums(p[14], 'slow');
      writeLead(p[14], [[0, 64, 32]], 0.55);

      // Cut any Moog lead tails ringing in from previous patterns
      p[0].set(0, 7, OFF, I_lead);
      p[3].set(0, 7, OFF, I_lead);
      p[4].set(0, 7, OFF, I_lead);
      p[9].set(0, 7, OFF, I_lead);
      p[11].set(0, 7, OFF, I_lead);

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Affreusement Épouvantable",
    bpm: 76,
    params: [
      { name: "Satie Lead", type: "303", p0: [600, 0.1, 0.4, 0.2], p1: [2.0, 0.3, 0.4, 0] },
      {
        name: "Nostalgic Rhodes",
        type: "dx7",
        p0: [1, 2, 2.5, 0.5],
        p1: [5, 0.5, 0.7, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 2,  decay: 1.8, mode: 0, sustain: 0.8, release: 1.8 },
          { coarse: 1.0, fine: 0, level: 85, detune: -2, decay: 1.5, mode: 0, sustain: 0.7, release: 1.5 },
          { coarse: 2.0, fine: 0, level: 70, detune: 3,  decay: 1.2, mode: 0, sustain: 0.6, release: 1.2 },
          { coarse: 3.0, fine: 0, level: 50, detune: -3, decay: 0.8, mode: 0, sustain: 0.5, release: 0.8 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.5, release: 0.25 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.5, release: 0.25 }
        ]
      },
      { name: "Lo-Fi Vinyl Kit", type: "808", p0: [0, 0.45, 0.5, 0.5], p1: [0, 0, 0, 0] },
      { name: "Moog Sub Bass", type: "moog", p0: [180, 0.35, 0.6, 0.2], p1: [8.0, 0.9, 0.8, 0.8], p2: [2, 1, 1, 0.06], p3: [2, 2, 1, 0.05] },
      { name: "Vinyl Crackle", type: "303", p0: [350, 0.75, 0.0, 0.0], p1: [4.0, 10.0, 10.0, 0] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { delayMix: 0.35, delayTime: 0.375, reverbMix: 0.4 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.45, chorusRate: 0.6, chorusDepth: 3.5, delayMix: 0.4, delayTime: 0.5, delayFeedback: 0.4, reverbMix: 0.5, reverbDecay: 0.9 }),
      '808': Object.assign(defaultFxParams(), { distOn: true, dist: 1.4, tone: 0.38, master: 0.9, bitcrushOn: true, bitcrushBits: 12.0, bitcrushRate: 18000.0, delayMix: 0.05, delayTime: 0.33, delayFeedback: 0.4, reverbMix: 0.06, reverbDecay: 0.7 }),
      'moog': Object.assign(defaultFxParams(), { dist: 1.6, tone: 0.45, chorusMix: 0.3, chorusRate: 0.8, chorusDepth: 2.0, master: 0.85 })
    },
    data: () => {
      const p = Array.from({ length: 7 }, () => new Pattern(128, 8));
      
      const I_303 = 0;
      const I_dx7 = 1;
      const I_808 = 2;
      const I_moog = 3;
      const I_vinyl = 4;

      const BD = 36;
      const SD = 38;
      const CH = 42;
      const OH = 46;
      const CLAP = 39;

      const chordVoicings = {
        Gmaj7: [59, 62, 66],
        Dmaj7: [54, 57, 61],
        Em7:   [55, 59, 62],
        A7sus4:[62, 64, 67],
        A7:    [61, 64, 67]
      };

      const progression = [
        "Gmaj7", "Dmaj7", "Gmaj7", "Dmaj7",
        "Gmaj7", "Dmaj7", "Em7",   "A7sus4", "A7"
      ];

      const writeChords = (pat, vol = 0.5) => {
        const barRows = [4, 20, 36, 52, 68, 84, 100, 116];
        barRows.forEach((rStart, barIdx) => {
          let chordName = progression[barIdx];
          if (barIdx === 7) {
            const v1 = chordVoicings["A7sus4"];
            v1.forEach((note, ni) => {
              pat.set(116, ni, note, I_dx7, vol);
              pat.set(119, ni, OFF, I_dx7);
            });
            const v2 = chordVoicings["A7"];
            v2.forEach((note, ni) => {
              pat.set(120, ni, note, I_dx7, vol * 0.95);
              pat.set(127, ni, OFF, I_dx7);
            });
          } else {
            const voicing = chordVoicings[chordName];
            voicing.forEach((note, ni) => {
              pat.set(rStart, ni, note, I_dx7, vol);
              pat.set(rStart + 11, ni, OFF, I_dx7);
            });
          }
        });
      };

      const writeBass = (pat, vol = 0.6) => {
        const roots = [43, 38, 43, 38, 43, 38, 40, 45];
        roots.forEach((rootNote, barIdx) => {
          const start = barIdx * 16;
          pat.set(start, 4, rootNote, I_moog, vol);
          pat.set(start + 11, 4, OFF, I_moog);
          if (barIdx < 6) {
            pat.set(start + 10, 4, rootNote + 12, I_moog, vol * 0.7);
            pat.set(start + 12, 4, OFF, I_moog);
          }
        });
      };

      const writeDrums = (pat, vol = 0.8) => {
        for (let bar = 0; bar < 8; bar++) {
          const start = bar * 16;
          if (bar % 2 === 0) {
            pat.set(start, 5, BD, I_808, vol);
            pat.set(start + 10, 5, BD, I_808, vol * 0.85);
            pat.set(start + 14, 5, BD, I_808, vol * 0.6);
            pat.set(start + 8, 6, SD, I_808, vol * 0.9);
            
            pat.set(start + 2, 6, CH, I_808, vol * 0.45);
            pat.set(start + 4, 6, CH, I_808, vol * 0.3);
            pat.set(start + 6, 6, CH, I_808, vol * 0.45);
            pat.set(start + 10, 6, CH, I_808, vol * 0.4);
            pat.set(start + 12, 6, CH, I_808, vol * 0.35);
            pat.set(start + 13, 6, CH, I_808, vol * 0.45);
            pat.set(start + 15, 6, CH, I_808, vol * 0.3);
            
            pat.set(start + 14, 6, OH, I_808, vol * 0.25);
          } else {
            pat.set(start, 5, BD, I_808, vol);
            pat.set(start + 3, 5, BD, I_808, vol * 0.5);
            pat.set(start + 10, 5, BD, I_808, vol * 0.85);
            pat.set(start + 8, 6, SD, I_808, vol * 0.9);
            pat.set(start + 15, 6, SD, I_808, vol * 0.4);
            
            pat.set(start + 2, 6, CH, I_808, vol * 0.45);
            pat.set(start + 4, 6, CH, I_808, vol * 0.3);
            pat.set(start + 6, 6, CH, I_808, vol * 0.45);
            pat.set(start + 10, 6, CH, I_808, vol * 0.45);
            pat.set(start + 12, 6, CH, I_808, vol * 0.35);
            pat.set(start + 13, 6, CH, I_808, vol * 0.45);
            
            pat.set(start + 12, 6, CLAP, I_808, vol * 0.4);
            pat.set(start + 14, 6, OH, I_808, vol * 0.25);
          }
        }
      };

      const writeLowKeyDrums = (pat, vol = 0.6) => {
        for (let bar = 0; bar < 8; bar++) {
          const start = bar * 16;
          pat.set(start, 5, BD, I_808, vol);
          pat.set(start + 10, 5, BD, I_808, vol * 0.85);
          
          pat.set(start + 8, 6, CLAP, I_808, vol * 0.5);
          
          pat.set(start + 2, 6, CH, I_808, vol * 0.4);
          pat.set(start + 6, 6, CH, I_808, vol * 0.4);
          pat.set(start + 10, 6, CH, I_808, vol * 0.4);
          
          if (bar % 2 === 1) {
            pat.set(start + 14, 6, OH, I_808, vol * 0.18);
          } else {
            pat.set(start + 14, 6, CH, I_808, vol * 0.3);
          }
        }
      };

      const writeVinylNoise = (pat, vol = 0.22) => {
        pat.set(0, 7, 36, I_vinyl, vol);
      };

      const melodyA = [
        [8, 66, 8], [16, 67, 4], [20, 69, 12], [32, 66, 8],
        [40, 62, 4], [44, 59, 4], [48, 61, 4], [52, 62, 4], [56, 64, 4], [60, 57, 8],
        [72, 66, 8], [80, 67, 4], [84, 69, 12], [96, 66, 8],
        [104, 62, 4], [108, 59, 4], [112, 61, 4], [116, 62, 4], [120, 64, 8]
      ];

      const melodyB = [
        [8, 69, 8], [16, 71, 4], [20, 72, 12], [32, 69, 8],
        [40, 64, 4], [44, 61, 4], [48, 62, 4], [52, 64, 4], [56, 66, 4], [60, 59, 8],
        [72, 66, 12], [88, 62, 12], [104, 59, 24]
      ];

      const writeMelody = (pat, melody, vol = 0.75) => {
        melody.forEach(([row, note, dur]) => {
          pat.set(row, 3, note, I_303, vol);
          pat.set(row + dur, 3, OFF, I_303);
        });
      };

      writeChords(p[0], 0.4);
      writeLowKeyDrums(p[0], 0.6);
      writeVinylNoise(p[0], 0.25);

      writeChords(p[1], 0.45);
      writeBass(p[1], 0.55);
      writeLowKeyDrums(p[1], 0.6);
      writeVinylNoise(p[1], 0.25);

      writeChords(p[2], 0.48);
      writeBass(p[2], 0.6);
      writeDrums(p[2], 0.75);
      writeMelody(p[2], melodyA, 0.72);
      writeVinylNoise(p[2], 0.25);

      writeChords(p[3], 0.48);
      writeBass(p[3], 0.6);
      writeDrums(p[3], 0.75);
      writeMelody(p[3], melodyB, 0.72);
      writeVinylNoise(p[3], 0.25);

      writeChords(p[4], 0.52);
      writeBass(p[4], 0.65);
      writeDrums(p[4], 0.8);
      writeMelody(p[4], melodyA.map(([r, n, d]) => [r, n + 12, d]), 0.65);
      writeVinylNoise(p[4], 0.25);

      writeChords(p[5], 0.48);
      writeBass(p[5], 0.6);
      writeDrums(p[5], 0.75);
      writeMelody(p[5], melodyA, 0.72);
      p[5].set(127, 3, OFF, I_303);
      writeVinylNoise(p[5], 0.25);

      writeChords(p[6], 0.4);
      writeBass(p[6], 0.45);
      writeLowKeyDrums(p[6], 0.5);
      writeVinylNoise(p[6], 0.2);

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 6],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Two-Fingered Typing (FOB)",
    bpm: 142,
    params: [
      { name: "VCO Noise Guitar", type: "303", p0: [1800, 0.96, 0.85, 0.6], p1: [1.0, 0.15, 0.25, 0] },
      {
        name: "Tape Glitch FM",
        type: "dx7",
        p0: [1, 2, 2.5, 0.4],
        p1: [12, 0.6, 0.9, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 5,  decay: 1.5, mode: 0, sustain: 0.85, release: 1.5 },
          { coarse: 1.0, fine: 1, level: 90, detune: -3, decay: 1.2, mode: 0, sustain: 0.8, release: 1.2 },
          { coarse: 2.0, fine: 0, level: 85, detune: 6,  decay: 1.0, mode: 0, sustain: 0.75, release: 1.0 },
          { coarse: 2.0, fine: 2, level: 75, detune: -4, decay: 0.8, mode: 0, sustain: 0.7, release: 0.8 },
          { coarse: 0.5, fine: 0, level: 95, detune: 3,  decay: 2.0, mode: 0, sustain: 0.9, release: 1.8 },
          { coarse: 1.0, fine: 0, level: 65, detune: 1,  decay: 1.5, mode: 0, sustain: 0.6, release: 1.0 }
        ]
      },
      { name: "Booty Metal Kit", type: "808", p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
      { name: "Axe Bass", type: "moog", p0: [600, 0.6, 0.7, 0.2], p1: [12.0, 0.8, 0.6, 0.8], p2: [2, 1, 2, 0.02], p3: [2, 2, 2, 0] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { distOn: true, dist: 15.0, tone: 0.45, chorusMix: 0.4, delayMix: 0.35, delayTime: 0.375, reverbMix: 0.4 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.55, chorusRate: 1.2, delayMix: 0.4, delayTime: 0.5, delayFeedback: 0.45, reverbMix: 0.5, reverbDecay: 0.9 }),
      '808': Object.assign(defaultFxParams(), { distOn: true, dist: 8.0, tone: 0.35, master: 0.9, bitcrushOn: true, bitcrushMix: 0.35, bitcrushRate: 6000, bitcrushDepth: 6 }),
      'moog': Object.assign(defaultFxParams(), { distOn: true, dist: 12.0, tone: 0.4, level: 1.0, master: 0.85, delayMix: 0.2, reverbMix: 0.35 })
    },
    data: () => {
      const p = Array.from({ length: 8 }, () => new Pattern(128, 8));
      
      const I_303 = 0;
      const I_dx7 = 1;
      const I_808 = 2;
      const I_moog = 3;

      const BD = 36;
      const SD = 38;
      const CH = 42;
      const OH = 46;

      const chordVoicings = {
        Dm:  [50, 57, 62],
        F:   [53, 60, 65],
        G:   [55, 62, 67],
        Bb:  [46, 53, 58],
        A:   [45, 52, 57]
      };

      const progression = [
        "Dm", "F", "G", "Bb",
        "Dm", "F", "A", "G"
      ];

      const writeChords = (pat, vol = 0.45) => {
        progression.forEach((chordName, barIdx) => {
          const start = barIdx * 16;
          const voicing = chordVoicings[chordName];
          voicing.forEach((note, ni) => {
            pat.set(start, ni, note, I_dx7, vol);
            pat.set(start + 11, ni, OFF, I_dx7);
          });
        });
      };

      const writeBass = (pat, vol = 0.7) => {
        const roots = [38, 41, 43, 34, 38, 41, 45, 43];
        roots.forEach((rootNote, barIdx) => {
          const start = barIdx * 16;
          for (let step = 0; step < 16; step += 2) {
            pat.set(start + step, 4, rootNote, I_moog, vol);
            pat.set(start + step + 1, 4, OFF, I_moog);
          }
        });
      };

      const writeBassSparse = (pat, vol = 0.6) => {
        const roots = [38, 41, 43, 34, 38, 41, 45, 43];
        roots.forEach((rootNote, barIdx) => {
          const start = barIdx * 16;
          pat.set(start, 4, rootNote, I_moog, vol);
          pat.set(start + 8, 4, rootNote, I_moog, vol * 0.9);
          pat.set(start + 7, 4, OFF, I_moog);
          pat.set(start + 15, 4, OFF, I_moog);
        });
      };

      const writeDrums = (pat, vol = 0.85) => {
        for (let bar = 0; bar < 8; bar++) {
          const start = bar * 16;
          pat.set(start, 5, BD, I_808, vol);
          pat.set(start + 6, 5, BD, I_808, vol * 0.9);
          pat.set(start + 10, 5, BD, I_808, vol * 0.95);
          
          pat.set(start + 4, 6, SD, I_808, vol);
          pat.set(start + 12, 6, SD, I_808, vol);
          
          for (let step = 0; step < 16; step += 2) {
            pat.set(start + step, 7, CH, I_808, vol * 0.5);
          }
          pat.set(start + 14, 7, OH, I_808, vol * 0.3);
        }
      };

      const writeLowKeyDrums = (pat, vol = 0.65) => {
        for (let bar = 0; bar < 8; bar++) {
          const start = bar * 16;
          pat.set(start, 5, BD, I_808, vol);
          pat.set(start + 10, 5, BD, I_808, vol * 0.85);
          for (let step = 0; step < 16; step += 4) {
            pat.set(start + step, 7, CH, I_808, vol * 0.4);
          }
        }
      };

      const melodyA = [
        [8, 62, 4], [12, 65, 4], [16, 67, 8], [28, 65, 4],
        [32, 62, 4], [36, 60, 4], [40, 58, 8], [52, 60, 4],
        [64, 62, 4], [68, 65, 4], [72, 67, 8], [84, 69, 4],
        [88, 70, 4], [92, 69, 4], [96, 67, 8], [112, 65, 8], [120, 62, 8]
      ];

      const melodyB = [
        [8, 69, 4], [12, 72, 4], [16, 74, 8], [28, 72, 4],
        [32, 69, 4], [36, 67, 4], [40, 65, 8], [52, 67, 4],
        [64, 69, 4], [68, 72, 4], [72, 74, 8], [84, 76, 4],
        [88, 77, 4], [92, 76, 4], [96, 74, 8], [112, 72, 8], [120, 69, 8]
      ];

      const writeMelody = (pat, melody, vol = 0.72) => {
        melody.forEach(([row, note, dur]) => {
          pat.set(row, 3, note, I_303, vol);
          pat.set(row + dur, 3, OFF, I_303);
        });
      };

      // Pattern 0: Intro (low-key drums, sparse bass, no leads)
      writeLowKeyDrums(p[0], 0.6);
      writeBassSparse(p[0], 0.55);

      // Pattern 1: Bass enters fully, FM chords
      writeLowKeyDrums(p[1], 0.65);
      writeBass(p[1], 0.65);
      writeChords(p[1], 0.4);

      // Pattern 2: Verse 1
      writeDrums(p[2], 0.75);
      writeBass(p[2], 0.7);
      writeChords(p[2], 0.45);
      writeMelody(p[2], melodyA, 0.7);

      // Pattern 3: Verse 2 (Melody B)
      writeDrums(p[3], 0.75);
      writeBass(p[3], 0.7);
      writeChords(p[3], 0.45);
      writeMelody(p[3], melodyB, 0.7);

      // Pattern 4: Verse 1 variation (transposed/modulated up by an octave for intensity)
      writeDrums(p[4], 0.8);
      writeBass(p[4], 0.72);
      writeChords(p[4], 0.45);
      writeMelody(p[4], melodyA.map(([r, n, d]) => [r, n + 12, d]), 0.68);
      p[4].set(127, 3, OFF, I_303);

      // Pattern 5: Chorus / Climax
      writeDrums(p[5], 0.85);
      writeBass(p[5], 0.75);
      writeChords(p[5], 0.5);
      writeMelody(p[5], melodyB.map(([r, n, d]) => [r, n + 12, d]), 0.68);
      p[5].set(127, 3, OFF, I_303);

      // Pattern 6: Ambient Breakdown / "Transsexual Witch" coven vibe
      writeLowKeyDrums(p[6], 0.5);
      writeBassSparse(p[6], 0.5);
      writeChords(p[6], 0.5);
      // Harmonious melody
      p[6].set(8, 3, 62, I_303, 0.65); // D
      p[6].set(24, 3, OFF, I_303);
      p[6].set(40, 3, 65, I_303, 0.65); // F
      p[6].set(56, 3, OFF, I_303);
      p[6].set(72, 3, 69, I_303, 0.65); // A
      p[6].set(88, 3, OFF, I_303);
      p[6].set(104, 3, 67, I_303, 0.65); // G
      p[6].set(120, 3, OFF, I_303);

      // Pattern 7: Outro Noise Jam (all instruments going wild, max energy)
      writeDrums(p[7], 0.8);
      writeBass(p[7], 0.7);
      writeChords(p[7], 0.45);
      // VCO guitar noise screams (harmonious scale selection)
      const scale = [62, 65, 67, 69, 72, 74, 77];
      for (let r = 0; r < 128; r += 16) {
        const note = scale[Math.floor(Math.random() * scale.length)];
        p[7].set(r, 3, note, I_303, 0.75);
        p[7].set(r + 12, 3, OFF, I_303);
      }

      return {
        patterns: p,
        order: [0, 1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 7, 7, 0],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Where'd I Put My Keys?",
    bpm: 128,
    params: [
      { name: "808 Acid Kit", type: "808", p0: [0, 0.55, 0.42, 0.7], p1: [0, 0, 0, 0] },
      { name: "303 Acid Bass", type: "303", p0: [320, 0.92, 0.85, 0.6], p1: [1, 0.32, 0.34, 0] },
      { name: "303 Screamer",  type: "303", p0: [1100, 0.95, 0.9, 0.55], p1: [1, 0.22, 0.28, 0] },
      { name: "Moog Sub",      type: "moog", p0: [110, 0.15, 0.4, 0], p1: [1.0, 0.95, 0.5, 0.6], p2: [2, 1, 1, 0], p3: [2, 2, 2, 0] },
      { name: "Organ Stab",    type: "dx7",
        p0: [1, 3, 2.5, 0.0], p1: [32, 0.6, 0.9, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0,  decay: 0.30, mode: 0, sustain: 0.55, release: 0.18 },
          { coarse: 2.0, fine: 0, level: 75, detune: 2,  decay: 0.28, mode: 0, sustain: 0.50, release: 0.18 },
          { coarse: 4.0, fine: 0, level: 50, detune: -2, decay: 0.25, mode: 0, sustain: 0.40, release: 0.15 },
          { coarse: 1.0, fine: 0, level: 60, detune: 3,  decay: 0.30, mode: 0, sustain: 0.50, release: 0.18 },
          { coarse: 0.5, fine: 0, level: 55, detune: 0,  decay: 0.35, mode: 0, sustain: 0.50, release: 0.20 },
          { coarse: 3.0, fine: 0, level: 30, detune: 0,  decay: 0.22, mode: 0, sustain: 0.35, release: 0.15 }
        ]
      }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { dist: 7.0, tone: 0.58, level: 1.0, master: 0.6, delayMix: 0.18, delayFeedback: 0.40, delayTime: 0.234, reverbMix: 0.10, reverbDecay: 0.80 }),
      'dx7': Object.assign(defaultFxParams(), { dist: 10.0, tone: 0.0, level: 2.0, master: 1.0, delayMix: 0.24, delayFeedback: 0.38, delayTime: 0.3515, reverbMix: 0.22, reverbDecay: 0.82, chorusMix: 0.30, chorusRate: 0.9, chorusDepth: 2.5 }),
      '808': Object.assign(defaultFxParams(), { dist: 2.0, tone: 0.5, level: 1.0, master: 0.7, reverbMix: 0.06, width: 1.12 }),
      'moog': Object.assign(defaultFxParams(), { dist: 1.0, tone: 0.5, level: 1.0, master: 1.5, width: 1.0 }),
    },
    data: () => {
      const ROWS = 64, CH = 8;
      const mk = () => new Pattern(ROWS, CH);
      const P = [mk(), mk(), mk(), mk(), mk(), mk(), mk(), mk()]; // 0..7

      const BD = 36, CLAP = 39, HH = 42, OH = 46, SD = 38;
      const I_808 = 0, I_BASS = 1, I_LEAD = 2, I_SUB = 3, I_STAB = 4;

      const BASE = 33;                  // A1
      const prog = [0, 0, -4, -2];      // Am · Am · F · G (one root per bar)
      const root = (r) => BASE + prog[Math.floor(r / 16) % 4];

      // Four-on-the-floor kit: kick on the beat, claps on 2 & 4, ticking closed
      // hats on the 16ths, the signature open hat on every offbeat.
      const drums = (pat, { kick = true, clap = true, hats = true, opens = true, build = false } = {}) => {
        for (let r = 0; r < ROWS; r++) {
          const s = r % 16;
          if (kick && s % 4 === 0) pat.set(r, 0, BD, I_808, s === 0 ? 0.98 : 0.9);
          if (clap && (s === 4 || s === 12)) pat.set(r, 1, CLAP, I_808, 0.82);
          if (hats && s % 2 === 1) pat.set(r, 2, HH, I_808, s % 4 === 3 ? 0.42 : 0.3);
          if (opens && s % 4 === 2) pat.set(r, 3, OH, I_808, 0.5);
        }
        if (build) {                    // snare-roll ramp through the last bar
          for (let r = 48; r < ROWS; r++) {
            const k = r - 48;
            if (k % 2 === 0 || k >= 8) pat.set(r, 1, SD, I_808, Math.min(0.95, 0.45 + (k / 16) * 0.5));
          }
        }
      };

      // Relentless 16th-note acid line with octave pops; accents drive the filter.
      const ACID = [0, 0, 12, 0, 0, 12, 0, 3, 0, 0, 12, 0, 7, 12, 10, 5];
      const ACCENT = new Set([0, 5, 10, 13]);
      const bass = (pat, ch, inst, oct = 0, vol = 0.85) => {
        for (let r = 0; r < ROWS; r++) {
          const s = r % 16;
          const n = root(r) + 12 * oct + ACID[s];
          pat.set(r, ch, n, inst, ACCENT.has(s) ? Math.min(1.0, vol + 0.12) : vol);
        }
      };

      // Higher, syncopated squelch lead (staccato — note-off after each hit).
      const LEAD = [0, null, 7, 12, null, 10, 7, null, 0, 3, null, 7, 12, null, 10, null];
      const lead = (pat, ch, inst, oct = 2, vol = 0.8) => {
        for (let r = 0; r < ROWS; r++) {
          const off = LEAD[r % 16];
          if (off === null) continue;
          pat.set(r, ch, root(r) + 12 * oct + off, inst, ACCENT.has(r % 16) ? Math.min(1.0, vol + 0.12) : vol);
          pat.set(r + 1, ch, OFF, inst);
        }
      };

      // Sub-bass root thump on the downbeats.
      const sub = (pat, ch, inst, vol = 0.8) => {
        for (let r = 0; r < ROWS; r += 4) {
          pat.set(r, ch, root(r), inst, vol);
          pat.set(r + 3, ch, OFF, inst);
        }
      };

      // Stabby organ chord hits on the offbeats.
      const stabs = (pat, ch, inst, oct = 2, vol = 0.7) => {
        for (let r = 0; r < ROWS; r++) {
          if (r % 4 === 2) {
            pat.set(r, ch, root(r) + 12 * oct, inst, vol);
            pat.set(r + 2, ch, OFF, inst);
          }
        }
      };

      // Cutoff filter sweep on a 303 channel: a triangle LFO between loHz/hiHz
      // over `cycles` open-close passes per pattern. Endpoints come from the CUT
      // target's own log mapping so they're exact. Written on every row so it
      // overrides each note's cutoff snapshot — the whole line breathes.
      const CUT = targetByCode('303', 'CUT');
      const sweep = (pat, ch, loHz, hiHz, cycles) => {
        const lo = normByte(CUT, loHz), hi = normByte(CUT, hiHz);
        for (let r = 0; r < ROWS; r++) {
          const phase = ((r / ROWS) * cycles) % 1;
          const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
          pat.setFx(r, ch, CUT.id, Math.round(lo + (hi - lo) * tri));
        }
      };
      // Acid Bass (ch 4) sweeps 55–452 Hz, one wah per bar; Screamer (ch 5)
      // sweeps 94–544 Hz, a slower pass every two bars.
      const bassSweep = (pat) => sweep(pat, 4, 55, 452, 4);
      const leadSweep = (pat) => sweep(pat, 5, 94, 544, 2);

      drums(P[0], { kick: true, clap: false, hats: true, opens: false });            // intro

      drums(P[1], { clap: false });                                                   // bass enters
      bass(P[1], 4, I_BASS, 0, 0.8);
      bassSweep(P[1]);

      drums(P[2], {});                                                                // full groove
      bass(P[2], 4, I_BASS, 0, 0.88);
      bassSweep(P[2]);
      sub(P[2], 6, I_SUB, 0.8);

      drums(P[3], {});                                                                // lead variation
      bass(P[3], 4, I_BASS, 0, 0.88);
      bassSweep(P[3]);
      sub(P[3], 6, I_SUB, 0.8);
      lead(P[3], 5, I_LEAD, 2, 0.8);
      leadSweep(P[3]);

      drums(P[4], { kick: false, clap: false });                                      // breakdown
      bass(P[4], 4, I_BASS, 0, 0.8);
      bassSweep(P[4]);
      stabs(P[4], 7, I_STAB, 2, 0.7);

      drums(P[5], { build: true });                                                   // drop / peak
      bass(P[5], 4, I_BASS, 0, 0.92);
      bassSweep(P[5]);
      sub(P[5], 6, I_SUB, 0.85);
      lead(P[5], 5, I_LEAD, 2, 0.85);
      leadSweep(P[5]);

      drums(P[6], {});                                                                // stab section
      bass(P[6], 4, I_BASS, 0, 0.88);
      bassSweep(P[6]);
      sub(P[6], 6, I_SUB, 0.8);
      stabs(P[6], 7, I_STAB, 2, 0.72);

      drums(P[7], { clap: false });                                                   // outro
      bass(P[7], 4, I_BASS, 0, 0.7);
      bassSweep(P[7]);

      return {
        patterns: P,
        // 24 slots × 64 rows at 128 BPM ≈ 3:00.
        order: [0, 1, 1, 2, 2, 3, 2, 4, 4, 5, 5, 3, 2, 6, 5, 5, 4, 5, 5, 3, 2, 7, 7],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Diabetic Foot Amputation",
    bpm: 75,
    params: [
      { name: "Satie Lead", type: "303", p0: [600, 0.1, 0.4, 0.2], p1: [2.0, 0.3, 0.4, 0] },
      {
        name: "Pegasus Harp",
        type: "dx7",
        p0: [1, 2, 2.5, 0.5],
        p1: [5, 0.5, 0.7, 3],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.8, mode: 0, sustain: 0.0, release: 0.8 },
          { coarse: 2.0, fine: 0, level: 82, detune: 2, decay: 0.4, mode: 0, sustain: 0.0, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 95, detune: -2, decay: 0.9, mode: 0, sustain: 0.0, release: 0.9 },
          { coarse: 3.0, fine: 0, level: 75, detune: 3, decay: 0.3, mode: 0, sustain: 0.0, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 0, detune: 0, decay: 0.5, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 1.0, fine: 0, level: 0, detune: 0, decay: 0.5, mode: 0, sustain: 0.0, release: 0.5 }
        ]
      },
      { name: "Vinyl Kit", type: "808", p0: [0, 0.35, 0.4, 0.3], p1: [0, 0, 0, 0] },
      {
        name: "Cloud Pad",
        type: "moog",
        p0: [350, 0.08, 0.25, 0.1],
        p1: [14.0, 0.9, 3.5, 3.5],
        p2: [1, 1, 0, 0],
        p3: [2, 2, 1, 0.06]
      }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { delayMix: 0.0 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.3, chorusRate: 1.2, chorusDepth: 2.5, delayMix: 0.45, delayTime: 0.6, delayFeedback: 0.6, reverbMix: 0.5, reverbDecay: 0.92 }),
      '808': Object.assign(defaultFxParams(), { distOn: false, tone: 0.3, level: 0.8, master: 0.8, delayMix: 0.0, reverbMix: 0.4, reverbDecay: 0.85 }),
      'moog': Object.assign(defaultFxParams(), { chorusMix: 0.5, chorusRate: 0.8, chorusDepth: 4.0, delayMix: 0.25, delayTime: 0.8, delayFeedback: 0.4, reverbMix: 0.7, reverbDecay: 0.96 })
    },
    data: () => {
      const p = Array.from({ length: 7 }, () => new Pattern(64, 8));
      
      const I_303 = 0;
      const I_dx7 = 1;
      const I_808 = 2;
      const I_moog = 3;

      const BD = 36;
      const SD = 38;
      const CH = 42;

      const chords = [
        [45, 52, 55, 60], // Am9
        [41, 48, 52, 57], // Fmaj7
        [43, 48, 52, 55], // C/G
        [47, 50, 55, 59]  // G6/B
      ];
      const roots = [33, 29, 35, 31];

      const writeProgression = (pat, options) => {
        // Pad (Moog) on channels 0..3
        if (options.padVol > 0) {
          chords.forEach((chord, bar) => {
            const startRow = bar * 16;
            chord.forEach((note, idx) => {
              pat.set(startRow, idx, note, I_moog, options.padVol);
              pat.set(startRow + 15, idx, OFF, I_moog);
            });
          });
        }

        // Bass (Moog) on channel 5
        if (options.bassVol > 0) {
          roots.forEach((rootNote, bar) => {
            const startRow = bar * 16;
            pat.set(startRow, 5, rootNote, I_moog, options.bassVol);
            pat.set(startRow + 14, 5, OFF, I_moog);
          });
        }

        // Harp (DX7) on channel 4 (8th note staccato arpeggio)
        if (options.harpVol > 0) {
          chords.forEach((chord, bar) => {
            const startRow = bar * 16;
            const arpPattern = [0, 1, 2, 3, 2, 1, 0, 1];
            for (let step = 0; step < 8; step++) {
              const row = startRow + step * 2;
              const noteIdx = arpPattern[step];
              const note = chord[noteIdx] + 12 * options.harpOctave;
              pat.set(row, 4, note, I_dx7, options.harpVol);
              pat.set(row + 1, 4, OFF, I_dx7);
            }
          });
        }

        // Drums (808) on channels 6 and 7
        if (options.drums) {
          for (let bar = 0; bar < 4; bar++) {
            const startRow = bar * 16;
            pat.set(startRow, 6, BD, I_808, 0.75);
            pat.set(startRow + 10, 6, BD, I_808, 0.6);
            pat.set(startRow + 8, 7, SD, I_808, 0.55);
            pat.set(startRow + 2, 7, CH, I_808, 0.35);
            pat.set(startRow + 6, 7, CH, I_808, 0.35);
            pat.set(startRow + 12, 7, CH, I_808, 0.35);
            pat.set(startRow + 14, 7, CH, I_808, 0.35);
          }
        }
      };

      // ---- automation ----
      // A slow pad "filter breath" (moog cutoff) and an evolving FM brightness on
      // the harp (dx7 mod index). Both are inst-scope, so they ride the live voice
      // and reset cleanly at each note — the pad sweep rides its sustained chords.
      const CUT = targetByCode('moog', 'CUT');   // log 30..6000 Hz
      const MOD = targetByCode('dx7', 'MOD');     // FM mod index 0..12
      const padBreath = (pat, loHz, hiHz) => {
        const lo = normByte(CUT, loHz), hi = normByte(CUT, hiHz);
        for (let r = 0; r < 64; r++) {
          const s = 0.5 - 0.5 * Math.cos((r / 64) * Math.PI * 2);   // one open/close per pattern
          const byte = Math.round(lo + (hi - lo) * s);
          for (let ch = 0; ch < 4; ch++) pat.setFx(r, ch, CUT.id, byte);
        }
      };
      const harpBrighten = (pat, loIdx, hiIdx) => {
        const lo = normByte(MOD, loIdx), hi = normByte(MOD, hiIdx);
        for (let r = 0; r < 64; r++) pat.setFx(r, 4, MOD.id, Math.round(lo + (hi - lo) * (r / 63)));
      };

      writeProgression(p[0], { padVol: 0.55, bassVol: 0, harpVol: 0, drums: false, harpOctave: 1 });
      writeProgression(p[1], { padVol: 0.6, bassVol: 0.55, harpVol: 0, drums: false, harpOctave: 1 });
      writeProgression(p[2], { padVol: 0.6, bassVol: 0.6, harpVol: 0.5, drums: false, harpOctave: 1 });
      writeProgression(p[3], { padVol: 0.62, bassVol: 0.62, harpVol: 0.55, drums: true, harpOctave: 1 });
      writeProgression(p[4], { padVol: 0.65, bassVol: 0.65, harpVol: 0.6, drums: true, harpOctave: 2 });
      writeProgression(p[5], { padVol: 0.55, bassVol: 0.45, harpVol: 0.4, drums: false, harpOctave: 1 });
      writeProgression(p[6], { padVol: 0.4, bassVol: 0, harpVol: 0, drums: false, harpOctave: 1 });

      // Pad breathes wider, and the harp's FM grows brighter, as the track builds
      // to the p4 climax — then both ease back for the comedown and fade.
      padBreath(p[0], 240, 650);
      padBreath(p[1], 250, 800);
      padBreath(p[2], 280, 950);  harpBrighten(p[2], 2.0, 4.0);
      padBreath(p[3], 300, 1100); harpBrighten(p[3], 2.5, 5.0);
      padBreath(p[4], 350, 1500); harpBrighten(p[4], 3.0, 6.5);   // climax: widest sweep, brightest FM
      padBreath(p[5], 260, 750);  harpBrighten(p[5], 2.0, 3.5);
      padBreath(p[6], 220, 500);

      return {
        patterns: p,
        order: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 5, 5, 4, 4, 2, 6, 6],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Dextroamphetamine Suppository",
    bpm: 137,
    params: [
      { name: "Acid 303", type: "303", p0: [420, 0.85, 0.55, 0.55], p1: [1, 0.4, 0.4, 0] },
      {
        name: "Rave Stab",
        type: "dx7",
        p0: [1, 2, 2.2, 0.4],
        p1: [3, 0.5, 0.6, 2],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0,  decay: 0.5, mode: 0, sustain: 0.4, release: 0.3 },
          { coarse: 2.0, fine: 0, level: 75, detune: 3,  decay: 0.4, mode: 0, sustain: 0.3, release: 0.3 },
          { coarse: 3.0, fine: 0, level: 70, detune: -3, decay: 0.4, mode: 0, sustain: 0.3, release: 0.3 },
          { coarse: 1.0, fine: 0, level: 60, detune: 5,  decay: 0.6, mode: 0, sustain: 0.5, release: 0.4 },
          { coarse: 5.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.0, release: 0.3 },
          { coarse: 6.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.0, release: 0.3 }
        ]
      },
      { name: "808 Kit", type: "808", p0: [0, 0.55, 0.5, 0.7], p1: [0, 0, 0, 0] },
      { name: "Sub Bass", type: "moog", p0: [180, 0.6, 0.7, 0], p1: [5, 0.7, 0.5, 0.6], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { dist: 9.0, tone: 0.6, level: 0.9, master: 0.78, delayMix: 0.32, delayTime: 0.375, delayFeedback: 0.42, reverbMix: 0.15 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.3, chorusRate: 1.0, chorusDepth: 2.0, delayMix: 0.2, delayTime: 0.5, delayFeedback: 0.35, reverbMix: 0.25, reverbDecay: 0.85, level: 1.0, master: 1.3 }),
      '808': Object.assign(defaultFxParams(), { dist: 4.0, tone: 0.55, level: 1.0, master: 0.9 }),
      'moog': Object.assign(defaultFxParams(), { dist: 3.0, tone: 0.5, level: 1.0, master: 0.9, reverbMix: 0.1 })
    },
    data: () => {
      const I_303 = 0, I_dx7 = 1, I_808 = 2, I_moog = 3;
      const BD = 36, CP = 39, CH = 42, OH = 46, MT = 45, HT = 48;

      // Fun 8-bar progression (C major):
      //   Cmaj7 | Am7 | Dm7 | G7 | Em7 | A7 | Dm7→G7 | Cmaj7
      // A7 in bar 6 is the hook — a secondary dominant (V7/ii) that pulls
      // somewhere unexpected before the ii-V turnaround reels it home.
      // DX7 stab voicings are rootless (mid register); the sub bass owns the root.
      const chords = [
        [64, 67, 71], // Cmaj7  (E  G  B)
        [60, 64, 67], // Am7    (C  E  G)
        [65, 69, 72], // Dm7    (F  A  C)
        [59, 62, 65], // G7     (B  D  F)
        [55, 59, 62], // Em7    (G  B  D)
        [61, 64, 67], // A7     (C# E  G)  <-- the lift
        [65, 69, 72], // Dm7    (bar 7, first half)
        [64, 67, 71]  // Cmaj7
      ];
      const bar7b = [59, 62, 65];                          // G7 (bar 7, second half)
      const bassRoots = [36, 33, 38, 31, 40, 45, 38, 36];  // C2 A1 D2 G1 E2 A2 D2 C2
      const bar7bRoot = 31;                                // G1
      const acidRoots = [48, 45, 50, 43, 52, 45, 50, 48];  // an octave above the bass

      // 16-step squelchy acid riff: semitone offsets from the bar's acid root.
      const acidRiff = [0, 12, 0, 7, null, 0, 12, 3, 0, 7, null, 12, 0, 7, 0, 10];

      const writeDrums = (pat, opt) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          if (opt.kick) {
            pat.set(s + 0, 0, BD, I_808, 0.95);
            pat.set(s + 4, 0, BD, I_808, 0.9);
            pat.set(s + 8, 0, BD, I_808, 0.95);
            pat.set(s + 12, 0, BD, I_808, 0.9);
            if (opt.kickRoll) pat.set(s + 14, 0, BD, I_808, 0.6);
          }
          if (opt.clap) {
            pat.set(s + 4, 1, CP, I_808, 0.7);
            pat.set(s + 12, 1, CP, I_808, 0.7);
          }
          if (opt.hats) {
            for (let r = 2; r < 16; r += 4) pat.set(s + r, 2, CH, I_808, 0.4);
            if (opt.openHat) for (let r = 6; r < 16; r += 8) pat.set(s + r, 2, OH, I_808, 0.45);
          }
          if (opt.fill && bar === 7) {       // tom fill closing the phrase
            pat.set(s + 8, 1, MT, I_808, 0.6);
            pat.set(s + 10, 1, MT, I_808, 0.6);
            pat.set(s + 12, 1, HT, I_808, 0.65);
            pat.set(s + 14, 1, HT, I_808, 0.7);
          }
        }
      };

      const writeChords = (pat, vol, octave = 0) => {
        const stab = (n, ch, row, end, v) => { pat.set(row, ch, n + 12 * octave, I_dx7, v); pat.set(end, ch, OFF, I_dx7); };
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          if (bar === 6) {                   // bar 7: Dm7 then G7 (the quick two-step)
            chords[6].forEach((n, i) => stab(n, 5 + i, s, s + 7, vol));
            bar7b.forEach((n, i) => stab(n, 5 + i, s + 8, s + 15, vol));
          } else {                           // off-the-floor house stabs on beats 1 & 3
            chords[bar].forEach((n, i) => {
              stab(n, 5 + i, s, s + 7, vol);
              stab(n, 5 + i, s + 8, s + 15, vol * 0.85);
            });
          }
        }
      };

      const writeBass = (pat, vol, octave = 0) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          for (let step = 0; step < 8; step++) {            // driving 8th notes
            const row = s + step * 2;
            const root = (bar === 6 && step >= 4) ? bar7bRoot : bassRoots[bar];
            let note = root + 12 * octave;
            if (step % 4 === 3) note += 12;                 // octave pop
            pat.set(row, 3, note, I_moog, step % 2 === 0 ? vol : vol * 0.8);
            pat.set(row + 1, 3, OFF, I_moog);
          }
        }
      };

      const writeAcid = (pat, vol, octave = 0) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          const root = acidRoots[bar] + 12 * octave;
          for (let step = 0; step < 16; step++) {
            const off = acidRiff[step];
            if (off === null) continue;
            pat.set(s + step, 4, root + off, I_303, step % 4 === 0 ? vol : vol * 0.7);
            pat.set(s + step + 1, 4, OFF, I_303);           // staccato; next note overwrites
          }
        }
      };

      // Acid filter sweep: write a CUT automation command on every row of the 303
      // channel (4), a triangle LFO between 129 Hz and 844 Hz over `cycles` full
      // open/close passes per 128-row pattern. Bytes come from the registry's own
      // log-curve mapping so the endpoints are exact. Because the command shares
      // the row with each note, it overrides the note-on cutoff snapshot — so the
      // whole acid line breathes regardless of the per-note retriggers.
      const CUT = targetByCode('303', 'CUT');
      const SWEEP_LO = normByte(CUT, 129);
      const SWEEP_HI = normByte(CUT, 844);
      const writeAcidSweep = (pat, cycles) => {
        for (let r = 0; r < 128; r++) {
          const phase = ((r / 128) * cycles) % 1;           // 0..1 ramp per cycle
          const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;  // 0→1→0 triangle
          pat.setFx(r, 4, CUT.id, Math.round(SWEEP_LO + (SWEEP_HI - SWEEP_LO) * tri));
        }
      };

      const p = Array.from({ length: 7 }, () => new Pattern(128, 8));

      // p0 intro — pad + sub, hats only
      writeChords(p[0], 0.75); writeBass(p[0], 0.5);  writeDrums(p[0], { hats: true });
      // p1 build — kick + acid join; one slow filter-open over the whole pattern
      writeChords(p[1], 0.75); writeBass(p[1], 0.6);  writeAcid(p[1], 0.55); writeAcidSweep(p[1], 1);
      writeDrums(p[1], { kick: true, hats: true });
      // p2 main drop — everything; sweep wahs every 4 bars
      writeChords(p[2], 0.8);  writeBass(p[2], 0.7);  writeAcid(p[2], 0.7);  writeAcidSweep(p[2], 2);
      writeDrums(p[2], { kick: true, clap: true, hats: true, openHat: true });
      // p3 variation — acid up an octave + fill; faster sweep (every 2 bars)
      writeChords(p[3], 0.8);  writeBass(p[3], 0.7);  writeAcid(p[3], 0.7, 1); writeAcidSweep(p[3], 4);
      writeDrums(p[3], { kick: true, clap: true, hats: true, openHat: true, fill: true, kickRoll: true });
      // p4 breakdown — pad + acid only, no kick; one long filter open (tension)
      writeChords(p[4], 0.85);                         writeAcid(p[4], 0.6);  writeAcidSweep(p[4], 1);
      writeDrums(p[4], { hats: true });
      // p5 peak — full throttle, acid octave up, roll + fill; wide double sweep
      writeChords(p[5], 0.85); writeBass(p[5], 0.75); writeAcid(p[5], 0.75, 1); writeAcidSweep(p[5], 2);
      writeDrums(p[5], { kick: true, clap: true, hats: true, openHat: true, kickRoll: true, fill: true });
      // p6 outro — pad + sub fade, hats trailing
      writeChords(p[6], 0.6);  writeBass(p[6], 0.45); writeDrums(p[6], { hats: true });

      return {
        patterns: p,
        // intro→build→drop→variation→breakdown→drop→peak→breakdown→drop→peak→outro
        order: [0, 1, 2, 2, 3, 4, 2, 3, 5, 5, 4, 2, 3, 5, 6],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Feral Roomba Sabbath",
    bpm: 124,
    params: [
      { name: "Roomba 808", type: "808", p0: [0, 0.5, 0.5, 0.55], p1: [0, 0, 0, 0] },
      {
        name: "Feral Bass", type: "moog",
        p0: [260, 0.55, 0.6, 0], p1: [3, 0.85, 0.4, 0.55],
        p2: [2, 1, 1, 0.02], p3: [2, 2, 1, 0]   // square + saw + 16' sub, light glide
      },
      { name: "Vacuum Acid", type: "303", p0: [420, 0.78, 0.7, 0.5], p1: [1, 0.3, 0.35, 0] },
      {
        name: "Glass Bell", type: "dx7",
        p0: [1, 3.5, 3.0, 0.0], p1: [1, 0.7, 1.4, 1],
        ops: [
          { coarse: 1.0, fine: 0, level: 99, detune: 0,  decay: 1.6, mode: 0, sustain: 0.0, release: 1.3 },
          { coarse: 3.5, fine: 0, level: 72, detune: 2,  decay: 0.7, mode: 0, sustain: 0.0, release: 0.6 },
          { coarse: 7.0, fine: 0, level: 45, detune: -3, decay: 0.4, mode: 0, sustain: 0.0, release: 0.4 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.0, release: 0.5 },
          { coarse: 1.0, fine: 0, level: 0,  detune: 0,  decay: 0.5, mode: 0, sustain: 0.0, release: 0.5 }
        ]
      },
      {
        name: "Ghost Pad", type: "moog",
        p0: [300, 0.1, 0.3, 0.1], p1: [12, 0.9, 2.0, 2.0],
        p2: [1, 1, 0, 0], p3: [2, 2, 1, 0.05]   // saw + saw + 16' triangle, a touch of noise
      }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { dist: 6.0, tone: 0.55, level: 1.0, master: 0.85, delayMix: 0.25, delayTime: 0.33, delayFeedback: 0.4, reverbMix: 0.18 }),
      'dx7': Object.assign(defaultFxParams(), { chorusMix: 0.3, chorusRate: 0.8, chorusDepth: 2.5, delayMix: 0.3, delayTime: 0.44, delayFeedback: 0.45, reverbMix: 0.4, reverbDecay: 0.9, master: 0.9 }),
      '808': Object.assign(defaultFxParams(), { dist: 2.0, tone: 0.5, level: 1.0, master: 0.9, reverbMix: 0.12 }),
      'moog': Object.assign(defaultFxParams(), { dist: 2.0, tone: 0.5, level: 1.0, master: 0.85, chorusMix: 0.3, reverbMix: 0.35, reverbDecay: 0.9 })
    },
    data: () => {
      const I_808 = 0, I_bass = 1, I_acid = 2, I_bell = 3, I_pad = 4;
      const BD = 36, CP = 39, CH = 42, OH = 46, SD = 38;

      // 8-bar minor progression: Am Am F G | Am Am Dm E
      const bassRoots = [33, 33, 29, 31, 33, 33, 38, 28];          // A1 A1 F1 G1 A1 A1 D2 E1
      const padDyads  = [[57,64],[57,64],[53,60],[55,62],[57,64],[57,64],[62,69],[52,59]];
      const bellTri   = [[69,72,76],[69,72,76],[65,69,72],[67,71,74],[69,72,76],[69,72,76],[74,77,81],[64,68,71]];
      const acidRoots = [45, 45, 41, 43, 45, 45, 50, 40];
      const acidRiff  = [0, 12, 0, 7, null, 0, 12, 3, 0, 7, null, 12, 0, 7, 0, 10];

      const drums = (pat, o) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          if (o.kick) for (let b = 0; b < 16; b += 4) pat.set(s + b, 0, BD, I_808, b === 0 ? 0.96 : 0.88);
          if (o.clap) { pat.set(s + 4, 1, CP, I_808, 0.7); pat.set(s + 12, 1, CP, I_808, 0.7); }
          if (o.hats) {
            for (let b = 2; b < 16; b += 4) pat.set(s + b, 2, CH, I_808, 0.4);
            if (o.openHat) pat.set(s + 14, 2, OH, I_808, 0.45);
          }
          if (o.fill && bar === 7) for (let b = 8; b < 16; b += 2) pat.set(s + b, 1, SD, I_808, 0.5 + (b - 8) / 16);
        }
      };
      const bass = (pat, vol, oct = 0) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16, root = bassRoots[bar] + 12 * oct;
          for (let step = 0; step < 8; step++) {
            const row = s + step * 2;
            const n = root + (step % 4 === 3 ? 12 : 0);
            pat.set(row, 3, n, I_bass, step % 2 === 0 ? vol : vol * 0.8);
            pat.set(row + 1, 3, OFF, I_bass);
          }
        }
      };
      const pad = (pat, vol) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          padDyads[bar].forEach((n, i) => { pat.set(s, 6 + i, n, I_pad, vol); pat.set(s + 15, 6 + i, OFF, I_pad); });
        }
      };
      const bell = (pat, vol, oct = 0) => {
        const arp = [0, 1, 2, 1, 0, 2, 1, 2];
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16, tri = bellTri[bar];
          for (let step = 0; step < 8; step++) {
            const row = s + step * 2;
            pat.set(row, 5, tri[arp[step]] + 12 * oct, I_bell, vol);
            pat.set(row + 1, 5, OFF, I_bell);
          }
        }
      };
      const acid = (pat, vol, oct = 0) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16, root = acidRoots[bar] + 12 * oct;
          for (let step = 0; step < 16; step++) {
            const off = acidRiff[step];
            if (off === null) continue;
            pat.set(s + step, 4, root + off, I_acid, step % 4 === 0 ? vol : vol * 0.7);
            pat.set(s + step + 1, 4, OFF, I_acid);
          }
        }
      };

      // ---- automation ----
      const CUT3 = targetByCode('303', 'CUT'), RES3 = targetByCode('303', 'RES');
      const CUTm = targetByCode('moog', 'CUT'), MOD = targetByCode('dx7', 'MOD'), MRV = targetByCode('moog', 'RVM');
      const acidSweep = (pat, loHz, hiHz, cycles) => {
        const lo = normByte(CUT3, loHz), hi = normByte(CUT3, hiHz);
        for (let r = 0; r < 128; r++) { const ph = ((r / 128) * cycles) % 1; const t = ph < 0.5 ? ph * 2 : 2 - ph * 2; pat.setFx(r, 4, CUT3.id, Math.round(lo + (hi - lo) * t)); }
      };
      const acidScream = (pat, lo, hi) => {     // resonance climb on the drop
        const loB = normByte(RES3, lo), hiB = normByte(RES3, hi);
        for (let r = 0; r < 128; r++) pat.setFx(r, 4, RES3.id, Math.round(loB + (hiB - loB) * (r / 127)));
      };
      const bellBright = (pat, lo, hi) => {     // FM mod-index ramp
        const loB = normByte(MOD, lo), hiB = normByte(MOD, hi);
        for (let r = 0; r < 128; r++) pat.setFx(r, 5, MOD.id, Math.round(loB + (hiB - loB) * (r / 127)));
      };
      const padBreath = (pat, loHz, hiHz, chans) => {   // sine filter swell on the pad voices
        const lo = normByte(CUTm, loHz), hi = normByte(CUTm, hiHz);
        for (let r = 0; r < 128; r++) {
          const sn = 0.5 - 0.5 * Math.cos((r / 128) * Math.PI * 2);
          const b = Math.round(lo + (hi - lo) * sn);
          for (const ch of chans) pat.setFx(r, ch, CUTm.id, b);
        }
      };
      const revWash = (pat, ch, lo, hi) => {    // fx-scope reverb swell (self-resetting triangle)
        const loB = normByte(MRV, lo), hiB = normByte(MRV, hi);
        for (let r = 0; r < 128; r++) { const sn = 0.5 - 0.5 * Math.cos((r / 128) * Math.PI * 2); pat.setFx(r, ch, MRV.id, Math.round(loB + (hiB - loB) * sn)); }
      };

      const p = Array.from({ length: 7 }, () => new Pattern(128, 8));

      // p0 intro — pad + ghostly bell, no rhythm
      pad(p[0], 0.45); bell(p[0], 0.32); padBreath(p[0], 200, 600, [6, 7]);
      // p1 beat-in — kick, hats, bass join
      pad(p[1], 0.5); bass(p[1], 0.7); bell(p[1], 0.36); drums(p[1], { kick: true, hats: true });
      padBreath(p[1], 250, 750, [6, 7]);
      // p2 groove — full kit
      pad(p[2], 0.5); bass(p[2], 0.78); bell(p[2], 0.5); drums(p[2], { kick: true, clap: true, hats: true, openHat: true });
      padBreath(p[2], 280, 900, [6, 7]); bellBright(p[2], 2.0, 3.5);
      // p3 build — acid enters with a cutoff sweep
      pad(p[3], 0.52); bass(p[3], 0.8); bell(p[3], 0.55); acid(p[3], 0.6);
      drums(p[3], { kick: true, clap: true, hats: true, openHat: true });
      padBreath(p[3], 300, 1000, [6, 7]); bellBright(p[3], 2.5, 4.5); acidSweep(p[3], 150, 800, 2);
      // p4 drop — acid screams (resonance), bell at its brightest, octave bass
      pad(p[4], 0.55); bass(p[4], 0.85); bell(p[4], 0.6, 1); acid(p[4], 0.72);
      drums(p[4], { kick: true, clap: true, hats: true, openHat: true, fill: true });
      padBreath(p[4], 350, 1300, [6, 7]); bellBright(p[4], 3.0, 6.0); acidScream(p[4], 0.6, 0.95);
      // p5 breakdown — no drums; pad + bell drenched in a reverb wash (fx-scope on ch7)
      pad(p[5], 0.5); bell(p[5], 0.45);
      p[5].set(0, 4, OFF, I_acid);   // cut any acid tail ringing in from the drop
      padBreath(p[5], 250, 850, [6]); bellBright(p[5], 2.0, 4.0); revWash(p[5], 7, 0.35, 0.85);
      // p6 outro — pad + soft bell fade
      pad(p[6], 0.4); bell(p[6], 0.3); padBreath(p[6], 200, 480, [6, 7]);
      p[6].set(0, 4, OFF, I_acid);   // clean bell entrance into the outro

      return {
        patterns: p,
        // intro→beat→groove→build→drop→drop→build→drop→breakdown→groove→build→drop→drop→outro
        order: [0, 1, 2, 3, 4, 4, 3, 4, 5, 2, 3, 4, 4, 6],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Tinnitus Cathedral",
    bpm: 122,
    params: [
      { name: "808 Vault", type: "808", p0: [0, 0.45, 0.5, 0.5], p1: [0, 0, 0, 0] },
      { name: "Sine Sub", type: "303", p0: [400, 0.0, 0.0, 0.0], p1: [3, 0.3, 0.6, 0] },         // wave 3 = sine, clean sub
      { name: "Cathedral Acid", type: "303", p0: [500, 0.82, 0.7, 0.5], p1: [1, 0.3, 0.35, 0] }, // wave 1 = square
      { name: "Resonant Wind", type: "303", p0: [300, 0.9, 0.0, 0.0], p1: [4, 0.5, 1.5, 0] },    // wave 4 = noise, high reso → whistling filtered noise
      {
        name: "Vault Pad", type: "moog",
        p0: [350, 0.15, 0.3, 0.1], p1: [14, 0.9, 2.5, 2.5],
        p2: [1, 1, 0, 0], p3: [2, 2, 1, 0.08]
      }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { dist: 3.0, tone: 0.5, level: 1.0, master: 0.8, delayMix: 0.22, delayTime: 0.41, delayFeedback: 0.42, reverbMix: 0.32, reverbDecay: 0.92 }),
      'dx7': defaultFxParams(),
      '808': Object.assign(defaultFxParams(), { dist: 1.5, tone: 0.5, level: 1.0, master: 0.9, reverbMix: 0.16, reverbDecay: 0.85 }),
      'moog': Object.assign(defaultFxParams(), { dist: 1.5, tone: 0.5, level: 1.0, master: 0.8, chorusMix: 0.3, reverbMix: 0.6, reverbDecay: 0.96 })
    },
    data: () => {
      const I_808 = 0, I_sub = 1, I_acid = 2, I_noise = 3, I_pad = 4;
      const BD = 36, CP = 39, CH = 42, OH = 46;

      // 8-bar D-minor lament: Dm Dm Bb C | Dm Dm Gm A
      const subRoots  = [38, 38, 34, 36, 38, 38, 31, 33];   // D2 D2 Bb1 C2 D2 D2 G1 A1
      const acidRoots = [50, 50, 46, 48, 50, 50, 43, 45];
      const padDyads  = [[62,69],[62,69],[58,65],[60,67],[62,69],[62,69],[55,62],[57,64]];
      const acidRiff  = [0, 12, 0, 7, null, 10, 0, 3, 0, 7, null, 12, 0, 5, 0, 7];

      const drums = (pat, o) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          if (o.kick) for (let b = 0; b < 16; b += 4) pat.set(s + b, 0, BD, I_808, b === 0 ? 0.96 : 0.9);
          if (o.clap) { pat.set(s + 4, 1, CP, I_808, 0.65); pat.set(s + 12, 1, CP, I_808, 0.65); }
          if (o.hats) { for (let b = 2; b < 16; b += 4) pat.set(s + b, 2, CH, I_808, 0.38); if (o.openHat) pat.set(s + 14, 2, OH, I_808, 0.42); }
        }
      };
      const sub = (pat, vol) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16, root = subRoots[bar];
          for (let b = 0; b < 16; b += 4) { pat.set(s + b, 3, root, I_sub, vol); pat.set(s + b + 3, 3, OFF, I_sub); }
        }
      };
      const acid = (pat, vol, oct = 0) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16, root = acidRoots[bar] + 12 * oct;
          for (let step = 0; step < 16; step++) {
            const off = acidRiff[step];
            if (off === null) continue;
            pat.set(s + step, 4, root + off, I_acid, step % 4 === 0 ? vol : vol * 0.7);
            pat.set(s + step + 1, 4, OFF, I_acid);
          }
        }
      };
      const pad = (pat, vol) => {
        for (let bar = 0; bar < 8; bar++) {
          const s = bar * 16;
          padDyads[bar].forEach((n, i) => { pat.set(s, 6 + i, n, I_pad, vol); pat.set(s + 15, 6 + i, OFF, I_pad); });
        }
      };
      // The noise 303 is unpitched, so one sustained voice per pattern is enough —
      // the motion comes entirely from sweeping its cutoff (the resonant peak).
      const wind = (pat, vol) => { pat.set(0, 5, 36, I_noise, vol); };

      // ---- automation ----
      const CUT3 = targetByCode('303', 'CUT'), RES3 = targetByCode('303', 'RES');
      const CUTm = targetByCode('moog', 'CUT'), MRV = targetByCode('moog', 'RVM');
      const ramp = (pat, ch, tgt, loB, hiB, shape) => {
        for (let r = 0; r < 128; r++) {
          let f;
          if (shape === 'up') f = r / 127;
          else if (shape === 'down') f = 1 - r / 127;
          else f = 0.5 - 0.5 * Math.cos((r / 128) * Math.PI * 2);   // sine breath
          pat.setFx(r, ch, tgt.id, Math.round(loB + (hiB - loB) * f));
        }
      };
      const acidSweep = (pat, loHz, hiHz, cyc) => {
        const lo = normByte(CUT3, loHz), hi = normByte(CUT3, hiHz);
        for (let r = 0; r < 128; r++) { const ph = ((r / 128) * cyc) % 1; const t = ph < 0.5 ? ph * 2 : 2 - ph * 2; pat.setFx(r, 4, CUT3.id, Math.round(lo + (hi - lo) * t)); }
      };
      const acidScream = (pat, lo, hi) => ramp(pat, 4, RES3, normByte(RES3, lo), normByte(RES3, hi), 'up');
      const windRiser  = (pat, loHz, hiHz) => ramp(pat, 5, CUT3, normByte(CUT3, loHz), normByte(CUT3, hiHz), 'up');
      const windBreath = (pat, loHz, hiHz) => ramp(pat, 5, CUT3, normByte(CUT3, loHz), normByte(CUT3, hiHz), 'breath');
      const windFall   = (pat, loHz, hiHz) => ramp(pat, 5, CUT3, normByte(CUT3, loHz), normByte(CUT3, hiHz), 'down');
      const windHold   = (pat, hz) => { const b = normByte(CUT3, hz); for (let r = 0; r < 128; r++) pat.setFx(r, 5, CUT3.id, b); };
      const padBreath  = (pat, loHz, hiHz, chans) => { const lo = normByte(CUTm, loHz), hi = normByte(CUTm, hiHz); for (let r = 0; r < 128; r++) { const sn = 0.5 - 0.5 * Math.cos((r / 128) * Math.PI * 2); const v = Math.round(lo + (hi - lo) * sn); for (const ch of chans) pat.setFx(r, ch, CUTm.id, v); } };
      const revWash    = (pat, ch, lo, hi) => ramp(pat, ch, MRV, normByte(MRV, lo), normByte(MRV, hi), 'breath');

      const p = Array.from({ length: 7 }, () => new Pattern(128, 8));

      // p0 intro — pad + sub + drifting resonant wind
      pad(p[0], 0.45); sub(p[0], 0.5); wind(p[0], 0.3);
      padBreath(p[0], 200, 600, [6, 7]); windBreath(p[0], 200, 1000);
      // p1 beat-in — kick, hats, acid (filtered low), wind rising slowly
      pad(p[1], 0.5); sub(p[1], 0.6); acid(p[1], 0.45); wind(p[1], 0.25);
      drums(p[1], { kick: true, hats: true });
      padBreath(p[1], 250, 750, [6, 7]); acidSweep(p[1], 150, 600, 2); windBreath(p[1], 250, 1100);
      // p2 groove — full kit
      pad(p[2], 0.5); sub(p[2], 0.62); acid(p[2], 0.55); wind(p[2], 0.22);
      drums(p[2], { kick: true, clap: true, hats: true, openHat: true });
      padBreath(p[2], 280, 900, [6, 7]); acidSweep(p[2], 200, 900, 2); windBreath(p[2], 300, 1300);
      // p3 build — the noise wave whooshes upward into the drop (the showcase riser)
      pad(p[3], 0.52); sub(p[3], 0.7); acid(p[3], 0.6); wind(p[3], 0.32);
      drums(p[3], { kick: true, clap: true, hats: true, openHat: true });
      padBreath(p[3], 300, 1000, [6, 7]); acidSweep(p[3], 300, 1100, 4); windRiser(p[3], 150, 4000);
      // p4 drop — acid screams, sub solid, wind sits as a bright resonant sizzle
      pad(p[4], 0.55); sub(p[4], 0.72); acid(p[4], 0.72); wind(p[4], 0.26);
      drums(p[4], { kick: true, clap: true, hats: true, openHat: true });
      padBreath(p[4], 350, 1300, [6, 7]); acidScream(p[4], 0.6, 0.95); windHold(p[4], 1800);
      // p5 breakdown — no drums; pad + sub + a vast wind sweep, moog drowned in reverb
      pad(p[5], 0.5); sub(p[5], 0.5); wind(p[5], 0.36);
      padBreath(p[5], 250, 850, [6]); windBreath(p[5], 200, 3000); revWash(p[5], 7, 0.4, 0.85);
      // p6 outro — pad + sub fade, wind falling away
      pad(p[6], 0.4); sub(p[6], 0.45); wind(p[6], 0.25);
      padBreath(p[6], 200, 450, [6, 7]); windFall(p[6], 1200, 200);

      return {
        patterns: p,
        // intro→beat→groove→riser→drop→groove→riser→drop→breakdown→groove→riser→drop→drop→outro
        order: [0, 1, 2, 3, 4, 2, 3, 4, 5, 2, 3, 4, 4, 6],
        rowsPerBeat: 4
      };
    }
  },
  {
    name: "Frying pans. Who knew?",
    bpm: 128,
    // Kitchen-electro in A minor (i–VI–III–VII–i–VI–iv–V) that puts the new
    // per-channel pan to work *musically*: a DX7 bell arpeggio sprayed L↔R, two
    // 303s holding a hard-left/hard-right acid conversation, ping-pong hats, and
    // slow stereo washes in the breakdown. Drums are deliberately dry. 13 order
    // slots × 128 rows @ 128 BPM ≈ 3:15.
    params: [
      { name: "Skillet Kit", type: "808", p0: [0, 0.5, 0.5, 0.6], p1: [0, 0, 0, 0] },
      // Bell: mildly inharmonic FM with a little sustain so it rings, not clangs.
      {
        name: "Pan Bell", type: "dx7",
        p0: [1, 2, 3.6, 0.32], p1: [1, 0.5, 0.85, 3],
        ops: [
          { coarse: 1.0,  fine: 0, level: 99, detune: 0,  decay: 0.85, mode: 0, sustain: 0.25, release: 0.4 },
          { coarse: 3.0,  fine: 0, level: 78, detune: 6,  decay: 0.6,  mode: 0, sustain: 0.1,  release: 0.3 },
          { coarse: 4.99, fine: 0, level: 58, detune: -4, decay: 0.5,  mode: 0, sustain: 0.0,  release: 0.25 },
          { coarse: 7.0,  fine: 0, level: 40, detune: 3,  decay: 0.4,  mode: 0, sustain: 0.0,  release: 0.2 },
          { coarse: 9.0,  fine: 0, level: 0,  detune: 0,  decay: 0.5,  mode: 0, sustain: 0.0,  release: 0.2 },
          { coarse: 11.0, fine: 0, level: 0,  detune: 0,  decay: 0.5,  mode: 0, sustain: 0.0,  release: 0.2 }
        ]
      },
      { name: "Acid L", type: "303", p0: [300, 0.82, 0.62, 0.55], p1: [1, 0.32, 0.4, 0] },
      { name: "Acid R", type: "303", p0: [420, 0.85, 0.58, 0.5],  p1: [0, 0.3, 0.36, 0] },
      { name: "Cast-Iron Sub", type: "moog", p0: [140, 0.3, 0.8, 0.5], p1: [2, 0.92, 0.55, 0.9], p2: [2, 2, 0, 0], p3: [1, 1, 1, 0] },
      { name: "Greasy Lead", type: "moog", p0: [1300, 0.35, 0.5, 0.4], p1: [10, 0.5, 0.7, 0.6], p2: [1, 2, 1, 0.05], p3: [2, 2, 2, 0] }
    ],
    fxParams: {
      '303': Object.assign(defaultFxParams(), { dist: 6.0, tone: 0.6, level: 1.0, master: 0.8, delayMix: 0.24, delayFeedback: 0.4, reverbMix: 0.14 }),
      'dx7': Object.assign(defaultFxParams(), { distOn: false, level: 1.0, master: 0.78, delayMix: 0.3, delayFeedback: 0.45, reverbMix: 0.4, reverbDecay: 0.86 }),
      // Drums dry: distortion / delay / reverb / chorus / tremolo / width all off.
      '808': Object.assign(defaultFxParams(), { distOn: false, delayOn: false, reverbOn: false, chorusOn: false, tremoloOn: false, widthOn: false, master: 0.9 }),
      'moog': Object.assign(defaultFxParams(), { dist: 3.0, tone: 0.5, level: 1.0, master: 0.82, delayMix: 0.15, reverbMix: 0.28, reverbDecay: 0.85 }),
    },
    data: () => {
      const p = [];
      for (let i = 0; i < 9; i++) p.push(new Pattern(128, 8));

      const BD = 36, SD = 38, HH = 42, OH = 46, CLAP = 39;
      const I_808 = 0, I_bell = 1, I_acidL = 2, I_acidR = 3, I_sub = 4, I_lead = 5;
      // ch: 0 kick · 1 snare · 2 hats · 3 bell · 4 acid-L · 5 acid-R · 6 sub · 7 lead

      // 8-bar harmony (16 rows/bar): Am F C G Am F Dm E.
      const BASS = [33, 29, 36, 31, 33, 29, 38, 28];   // roots, sub octave
      const TRIAD = [
        [69, 72, 76], // Am  A C E
        [65, 69, 72], // F   F A C
        [72, 76, 79], // C   C E G
        [67, 71, 74], // G   G B D
        [69, 72, 76], // Am
        [65, 69, 72], // F
        [74, 77, 81], // Dm  D F A
        [76, 80, 83], // E   E G# B  (G# = leading tone)
      ];

      // --- pan automation (chan-scope PAN, engine-agnostic) ---
      const PAN = targetByCode('303', 'PAN');
      const pan = (pat, row, ch, v) => pat.setFx(row, ch, PAN.id, normByte(PAN, Math.max(0, Math.min(1, v))));
      const HOME = [0.5, 0.5, 0.5, 0.5, 0.15, 0.85, 0.5, 0.5];
      const setHome = (pat, pans) => { const a = pans || HOME; for (let c = 0; c < 8; c++) pan(pat, 0, c, a[c]); };
      const pingPong = (pat, ch, step, lo, hi, startRight) => {
        const L = (lo == null ? 0.08 : lo), H = (hi == null ? 0.92 : hi), s = step || 1;
        for (let r = 0; r < pat.rows; r += s) {
          const even = (Math.floor(r / s) % 2 === 0);
          pan(pat, r, ch, (even === !!startRight) ? H : L);
        }
      };
      const swirl = (pat, ch, cycles, lo, hi) => {
        const L = (lo == null ? 0.05 : lo), H = (hi == null ? 0.95 : hi), c = cycles || 1;
        for (let r = 0; r < pat.rows; r += 2) {
          const ph = (r / pat.rows) * c, tri = 1 - Math.abs(((ph % 1) * 2) - 1);
          pan(pat, r, ch, L + (H - L) * tri);
        }
      };
      const sweep = (pat, ch, cycles, lo, hi, phase) => {
        const c = cycles || 1, L = (lo == null ? 0.1 : lo), H = (hi == null ? 0.9 : hi), ph = phase || 0;
        for (let r = 0; r < pat.rows; r += 2) {
          const s = 0.5 + 0.5 * Math.sin(2 * Math.PI * (c * r / pat.rows) + ph);
          pan(pat, r, ch, L + (H - L) * s);
        }
      };

      // --- voices ---
      const drums = (pat, opt) => {
        const o = opt || {};
        const kick = o.kick !== false, snare = o.snare !== false, hats = o.hats !== false;
        const four = !!o.four, busy = !!o.busy;
        for (let r = 0; r < 128; r++) {
          const s = r % 16;
          if (kick) {
            if (four) { if (s % 4 === 0) pat.set(r, 0, BD, I_808, 0.96); }
            else if (s === 0 || s === 10 || (busy && s === 6)) pat.set(r, 0, BD, I_808, 0.95);
          }
          if (snare && (s === 4 || s === 12)) pat.set(r, 1, (s === 12 && busy) ? CLAP : SD, I_808, 0.8);
          if (hats) {
            if (s % 2 === 1) pat.set(r, 2, HH, I_808, 0.38);
            if (s === 2 || s === 10) pat.set(r, 2, OH, I_808, 0.48);
          }
        }
      };
      const bass = (pat, vol) => {
        const v = (vol == null ? 0.9 : vol);
        for (let bar = 0; bar < 8; bar++) {
          const r = bar * 16, R = BASS[bar];
          const hits = [[0, R], [3, R], [6, R + 12], [8, R], [11, R + 12], [14, R + 7]];
          hits.forEach(function (h) { pat.set(r + h[0], 6, h[1], I_sub, v); pat.set(r + h[0] + 1, 6, OFF, I_sub); });
        }
      };
      // One bar's chord, arpeggiated as a 303 acid lick on channel `ch`.
      const acidBar = (pat, ch, inst, bar, vol) => {
        const v = (vol == null ? 0.72 : vol), lo = TRIAD[bar].map(function (n) { return n - 24; });
        const seq = [[0, 0], [2, 2], [3, 1], [6, 0], [7, 2], [8, 0], [10, 1], [11, 2], [13, 0], [14, 1]];
        const r = bar * 16;
        seq.forEach(function (s) {
          const oct = (s[0] === 8 || s[0] === 13) ? 12 : 0;
          pat.set(r + s[0], ch, lo[s[1]] + oct, inst, v);
          pat.set(r + s[0] + 1, ch, OFF, inst);
        });
      };
      // The acid conversation: L answers R bar by bar (or both, when `both`).
      const acidCall = (pat, vol, both) => {
        for (let bar = 0; bar < 8; bar++) {
          if (both || bar % 2 === 0) acidBar(pat, 4, I_acidL, bar, vol);
          if (both || bar % 2 === 1) acidBar(pat, 5, I_acidR, bar, vol);
        }
      };
      // Bell arpeggio on the offbeats — chord tones rising, rings out.
      const bell = (pat, vol) => {
        const v = (vol == null ? 0.6 : vol);
        for (let bar = 0; bar < 8; bar++) {
          const r = bar * 16, t = TRIAD[bar];
          [2, 6, 10, 14].forEach(function (st, i) { pat.set(r + st, 3, t[i % 3] + (i >= 3 ? 12 : 0), I_bell, v); });
        }
      };
      // The hook: a hand-written lead melody [absStep, note, durRows].
      const LEAD = [
        [0, 76, 6], [6, 72, 4], [10, 74, 4], [14, 72, 2],
        [16, 69, 6], [22, 72, 4], [26, 77, 6],
        [32, 79, 6], [38, 76, 4], [40, 72, 4], [44, 74, 2],
        [48, 74, 6], [54, 71, 4], [58, 79, 6],
        [64, 76, 6], [70, 72, 4], [74, 69, 4], [78, 71, 2],
        [80, 69, 6], [86, 72, 4], [90, 65, 6],
        [96, 77, 4], [100, 74, 4], [104, 81, 6], [110, 79, 2],
        [112, 76, 6], [118, 80, 4], [122, 76, 6],
      ];
      const lead = (pat, vol) => {
        const v = (vol == null ? 0.7 : vol);
        LEAD.forEach(function (n) { pat.set(n[0], 7, n[1], I_lead, v); pat.set(n[0] + n[2], 7, OFF, I_lead); });
      };

      // ===== arrangement =====
      // p0 · intro — bell shimmer across the field + airy lead, no kick
      setHome(p[0]); bell(p[0], 0.6); drums(p[0], { kick: false, snare: false, hats: true });
      lead(p[0], 0.5); pingPong(p[0], 3, 2, 0.06, 0.94); pingPong(p[0], 2, 1);

      // p1 · build — kick + bass walk in
      setHome(p[1]); drums(p[1], { kick: true, snare: false, hats: true });
      bass(p[1], 0.85); bell(p[1], 0.62); lead(p[1], 0.6);
      pingPong(p[1], 3, 2, 0.06, 0.94); pingPong(p[1], 2, 1);

      // p2 · pre — the L/R acid conversation enters
      setHome(p[2]); drums(p[2], { kick: true, snare: true, hats: true });
      bass(p[2], 0.9); acidCall(p[2], 0.72); bell(p[2], 0.6);
      pingPong(p[2], 2, 1); pingPong(p[2], 3, 2, 0.06, 0.94);

      // p3 · DROP — the full hook
      setHome(p[3]); drums(p[3], { four: true, snare: true, hats: true, busy: true });
      bass(p[3], 0.95); acidCall(p[3], 0.74); lead(p[3], 0.72); bell(p[3], 0.6);
      pingPong(p[3], 2, 1); pingPong(p[3], 3, 2, 0.05, 0.95);

      // p4 · variation — both acids chatter, lead drifts across
      setHome(p[4]); drums(p[4], { four: true, snare: true, hats: true, busy: true });
      bass(p[4], 0.95); acidCall(p[4], 0.7, true); lead(p[4], 0.72); bell(p[4], 0.58);
      pingPong(p[4], 2, 1); pingPong(p[4], 3, 2, 0.05, 0.95); sweep(p[4], 7, 1, 0.25, 0.75);

      // p5 · breakdown — drums out; bell + lead glide opposite slow arcs
      setHome(p[5]); bell(p[5], 0.6); lead(p[5], 0.66); bass(p[5], 0.6);
      drums(p[5], { kick: false, snare: false, hats: true });
      swirl(p[5], 3, 1, 0.05, 0.95); sweep(p[5], 7, 0.5, 0.9, 0.1); pingPong(p[5], 2, 4);

      // p6 · DROP 2 — everything, tasteful triple stereo motion
      setHome(p[6]); drums(p[6], { four: true, snare: true, hats: true, busy: true });
      bass(p[6], 0.98); acidCall(p[6], 0.74); lead(p[6], 0.74); bell(p[6], 0.62);
      pingPong(p[6], 2, 1); pingPong(p[6], 3, 2, 0.04, 0.96, true); sweep(p[6], 7, 2, 0.3, 0.7);

      // p7 · outro — wind down, sparse bell + lead, gentle swirl
      setHome(p[7]); bell(p[7], 0.5); lead(p[7], 0.55); bass(p[7], 0.6);
      drums(p[7], { kick: true, snare: false, hats: true });
      swirl(p[7], 3, 1, 0.1, 0.9); pingPong(p[7], 2, 2);

      // p8 · tail — a final Am chord spread across the field, ringing out
      setHome(p[8], [0.5, 0.5, 0.5, 0.5, 0.2, 0.8, 0.5, 0.5]);
      p[8].set(0, 3, 69, I_bell, 0.7);                                   // A (centre)
      p[8].set(0, 4, 72, I_acidL, 0.5); p[8].set(48, 4, OFF, I_acidL);   // C (left)
      p[8].set(0, 5, 76, I_acidR, 0.5); p[8].set(48, 5, OFF, I_acidR);   // E (right)
      p[8].set(0, 6, 33, I_sub, 0.6);   p[8].set(112, 6, OFF, I_sub);    // A (sub)

      return {
        patterns: p,
        // intro·build·pre·DROP·DROP·var·breakdown·DROP2·DROP2·DROP·var·outro·tail
        order: [0, 1, 2, 3, 3, 4, 5, 6, 6, 3, 4, 7, 8],
        rowsPerBeat: 4,
        // Static base image: acids parked L/R, rest centred; playback moves it.
        pan: [0.5, 0.5, 0.5, 0.5, 0.15, 0.85, 0.5, 0.5],
      };
    }
  }
];
