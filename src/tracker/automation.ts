// Automation / effect-command registry.
//
// Every automatable parameter is a "ParamTarget". A pattern cell can carry one
// target id + a normalized value byte (0x00..0xFF). The byte is the universal
// currency: it is what the grid stores, what the editor shows as 2 hex digits,
// and what an incoming MIDI CC (0..127, scaled <<1) will map to. denorm() turns
// it into the real engine value at playback time.
//
// Three scopes:
//   'inst' — a per-voice instrument param bank (p0/p1, index 0..3). Applied to
//            the live voice slot, so it automates only the channel it's on.
//   'fx'   — a key in that instrument-type's fxParams. The fx chain is shared by
//            ALL channels of an engine type, so an 'fx' command is track-wide for
//            that engine. The UI tints these differently to make that obvious.
//   'chan' — a per-channel mix parameter (pan). Not tied to an engine type, so it
//            shows up for every channel; applied channel-local like 'inst'.
//
// Target ids are the flat index into TARGETS and must stay append-only (they are
// persisted in patterns and will key MIDI-CC maps).
import type { InstrumentType, ParamTarget, RawTarget } from '../types.js';
import { DEFAULT_MASTER } from '../constants.js';
import { REGISTRY, byType } from '../instruments/index.js';

// fx-scope targets. `key` is a fxParams field; these apply to whichever engine
// type the channel's instrument is, and are shared across that type's channels.
const FX: RawTarget[] = [
  { code: 'LVL', label: 'Level',         key: 'master',        min: 0,     max: 2,     curve: 'lin' },
  { code: 'DRV', label: 'Distortion',    key: 'dist',          min: 0.001, max: 20,    curve: 'log' },
  { code: 'OVD', label: 'Overdrive',     key: 'odDrive',       min: 1,     max: 30,    curve: 'log' },
  { code: 'OVT', label: 'OD Tone',       key: 'odTone',        min: 0,     max: 1,     curve: 'lin' },
  { code: 'OVL', label: 'OD Level',      key: 'odLevel',       min: 0,     max: 1.5,   curve: 'lin' },
  { code: 'DLM', label: 'Delay Mix',     key: 'delayMix',      min: 0,     max: 1,     curve: 'lin' },
  { code: 'DLF', label: 'Delay Fbk',     key: 'delayFeedback', min: 0,     max: 0.9,   curve: 'lin' },
  { code: 'RVM', label: 'Reverb Mix',    key: 'reverbMix',     min: 0,     max: 1,     curve: 'lin' },
  { code: 'RVD', label: 'Reverb Decay',  key: 'reverbDecay',   min: 0,     max: 0.97,  curve: 'lin' },
  { code: 'CHM', label: 'Chorus Mix',    key: 'chorusMix',     min: 0,     max: 1,     curve: 'lin' },
  { code: 'WID', label: 'Width',         key: 'width',         min: 0,     max: 2,     curve: 'lin' },
  { code: 'BCB', label: 'Crush Bits',    key: 'bitcrushBits',  min: 4,     max: 33,    curve: 'lin' },
  { code: 'BCR', label: 'Crush Rate',    key: 'bitcrushRate',  min: 100,   max: 48000, curve: 'log', unit: 'Hz' },
  { code: 'BCM', label: 'Crush Mix',     key: 'bitcrushMix',   min: 0,     max: 1,     curve: 'lin' },
];

// fx on/off "stomp box" toggles (one per effect enable flag). byte 0 = off, any
// other value = on; the apply paths write a real boolean (works with both _on
// semantics — bitcrushOn truthy vs the others' !== false). Appended at the END of
// TARGETS so adding them never shifts existing ids.
const TOGGLES: RawTarget[] = [
  { code: 'DSO', label: 'Distortion On', key: 'distOn',     min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'OVO', label: 'Overdrive On',  key: 'odOn',       min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'CHO', label: 'Chorus On',     key: 'chorusOn',   min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'TRO', label: 'Tremolo On',    key: 'tremoloOn',  min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'DLO', label: 'Delay On',      key: 'delayOn',    min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'RVO', label: 'Reverb On',     key: 'reverbOn',   min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'WDO', label: 'Width On',      key: 'widthOn',    min: 0, max: 1, curve: 'lin', toggle: true },
  { code: 'BCO', label: 'Bitcrush On',   key: 'bitcrushOn', min: 0, max: 1, curve: 'lin', toggle: true },
];

// chan-scope targets. Per-channel mix params, engine-agnostic (offered on every
// channel). Pan is 0 = hard left, 0.5 = centre, 1 = hard right (equal-power in
// the mix shader).
const CHAN: RawTarget[] = [
  { code: 'PAN', label: 'Pan', key: 'pan', min: 0, max: 1, curve: 'lin', unit: 'pan' },
];

// global-scope targets. Song-level properties.
const GLOBAL: RawTarget[] = [
  { code: 'BPM', label: 'BPM', key: 'bpm', min: 40, max: 300, curve: 'lin', unit: 'bpm' },
  // max chosen so byte 0x80 (128) denormalizes to exactly DEFAULT_MASTER:
  // denorm = max·(128/255), so max = DEFAULT_MASTER·255/128. A neutral 0x80 cell
  // then equals the un-automated default for any default value; 0xFF ≈ 2× it.
  { code: 'VOL', label: 'Volume', key: 'master', min: 0, max: DEFAULT_MASTER * 255 / 128, curve: 'lin' },
];

// Flatten into a stable, id-indexed table. Order = append-only: target ids are
// persisted in patterns, so the inst block is FROZEN to the original four engines
// in their historical order (303, moog, dx7, 808 — NOT registry/INSTRUMENTS
// order), with any later-registered engines appended after. Never reorder/insert.
// Each engine's inst-targets come from its descriptor (`autoTargets`).
const AUTO_ORDER = ['303', 'moog', 'dx7', '808'];
const autoTypes = [
  ...AUTO_ORDER.filter((t) => byType(t)),
  ...REGISTRY.map((d) => d.type).filter((t) => !AUTO_ORDER.includes(t)),
];

export const TARGETS: ParamTarget[] = [];
for (const type of autoTypes) {
  const def = byType(type);
  if (!def) continue;
  for (const t of def.autoTargets) TARGETS.push({ ...t, scope: 'inst', type, id: TARGETS.length });
}
for (const t of FX) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });
for (const t of CHAN) TARGETS.push({ ...t, scope: 'chan', type: '*', id: TARGETS.length });
for (const t of GLOBAL) TARGETS.push({ ...t, scope: 'global', type: '*', id: TARGETS.length });
// fx on/off toggles — appended LAST so ids stay stable when this group grows.
for (const t of TOGGLES) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Resonant filter fx targets — appended AFTER the toggles (id-stable). New fx
// targets MUST go at the very end so they never shift existing CHAN/GLOBAL/TOGGLE
// ids (persisted in patterns). All fx-scope, so they auto-appear in the automation
// picker AND the LFO routing dropdown (cutoff is the marquee LFO sweep target).
const FX_FILTER_TARGETS: RawTarget[] = [
  { code: 'FLO', label: 'Filter On',     key: 'filterOn',     min: 0,  max: 1,     curve: 'lin', toggle: true },
  { code: 'FLC', label: 'Filter Cutoff', key: 'filterCutoff', min: 20, max: 18000, curve: 'log', unit: 'Hz' },
  { code: 'FLR', label: 'Filter Reso',   key: 'filterReso',   min: 0,  max: 1,     curve: 'lin' },
  { code: 'FLM', label: 'Filter Mix',    key: 'filterMix',    min: 0,  max: 1,     curve: 'lin' },
];
for (const t of FX_FILTER_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Dynamics (compressor + limiter) fx targets — appended at the very end (id-stable).
const FX_DYN_TARGETS: RawTarget[] = [
  { code: 'CMO', label: 'Comp On',       key: 'compOn',       min: 0,   max: 1,   curve: 'lin', toggle: true },
  { code: 'CMT', label: 'Comp Thresh',   key: 'compThresh',   min: -60, max: 0,   curve: 'lin', unit: 'dB' },
  { code: 'CMR', label: 'Comp Ratio',    key: 'compRatio',    min: 1,   max: 20,  curve: 'log' },
  { code: 'CMA', label: 'Comp Attack',   key: 'compAttack',   min: 0.1, max: 100, curve: 'log', unit: 'ms' },
  { code: 'CML', label: 'Comp Release',  key: 'compRelease',  min: 5,   max: 500, curve: 'log', unit: 'ms' },
  { code: 'CMK', label: 'Comp Makeup',   key: 'compMakeup',   min: 0,   max: 24,  curve: 'lin', unit: 'dB' },
  { code: 'LMO', label: 'Limiter On',    key: 'limitOn',      min: 0,   max: 1,   curve: 'lin', toggle: true },
  { code: 'LMC', label: 'Limiter Ceil',  key: 'limitCeil',    min: -24, max: 0,   curve: 'lin', unit: 'dB' },
  { code: 'LMR', label: 'Limiter Rel',   key: 'limitRelease', min: 5,   max: 500, curve: 'log', unit: 'ms' },
];
for (const t of FX_DYN_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Equalizer fx targets — appended at the very end (id-stable).
const FX_EQ_TARGETS: RawTarget[] = [
  { code: 'EQO', label: 'EQ On',        key: 'eqOn',       min: 0,    max: 1,     curve: 'lin', toggle: true },
  { code: 'EQL', label: 'EQ Low',       key: 'eqLow',      min: -24,  max: 12,    curve: 'lin', unit: 'dB' },
  { code: 'EQM', label: 'EQ Mid',       key: 'eqMid',      min: -24,  max: 12,    curve: 'lin', unit: 'dB' },
  { code: 'EQH', label: 'EQ High',      key: 'eqHigh',     min: -24,  max: 12,    curve: 'lin', unit: 'dB' },
  { code: 'EQC', label: 'EQ Low Cut',   key: 'eqLowFreq',  min: 50,   max: 1000,  curve: 'log', unit: 'Hz' },
  { code: 'EQD', label: 'EQ High Cut',  key: 'eqHighFreq', min: 1000, max: 10000, curve: 'log', unit: 'Hz' },
];
for (const t of FX_EQ_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Vocoder fx targets — appended at the very end (id-stable). Source is a discrete
// instance index, intentionally NOT automatable (like the compressor's compSource).
const FX_VOC_TARGETS: RawTarget[] = [
  { code: 'VCO', label: 'Vocoder On',  key: 'vocoderOn',  min: 0,   max: 1,   curve: 'lin', toggle: true },
  { code: 'VCB', label: 'Voc Bands',   key: 'vocBands',   min: 1,   max: 16,  curve: 'lin' },
  { code: 'VCQ', label: 'Voc Q',       key: 'vocQ',       min: 0.5, max: 16,  curve: 'log' },
  { code: 'VCA', label: 'Voc Attack',  key: 'vocAttack',  min: 0.1, max: 100, curve: 'log', unit: 'ms' },
  { code: 'VCR', label: 'Voc Release', key: 'vocRelease', min: 5,   max: 500, curve: 'log', unit: 'ms' },
  { code: 'VCM', label: 'Voc Mix',     key: 'vocMix',     min: 0,   max: 1,   curve: 'lin' },
  { code: 'VCU', label: 'Voc Unvoiced', key: 'vocUnvoiced', min: 0, max: 1,   curve: 'lin' },
  { code: 'VCF', label: 'Voc Formant', key: 'vocFormant', min: -12, max: 12, curve: 'lin', unit: 'st' },
];
for (const t of FX_VOC_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Distortion Tone + Level fx targets — appended at the very end (id-stable). The
// distortion drive (`dist`/DRV) has always been targetable, but its `tone`/`level`
// were never exposed, so they were missing from automation AND both LFO matrices.
// Ranges mirror the fx-panel sliders (tone 0..1, level 0..2). fx-scope → they
// auto-appear in the automation picker, the global-LFO dropdown, and the
// per-instrument mod matrix.
const FX_DIST_TARGETS: RawTarget[] = [
  { code: 'DTN', label: 'Dist Tone',  key: 'tone',  min: 0, max: 1, curve: 'lin' },
  { code: 'DTL', label: 'Dist Level', key: 'level', min: 0, max: 2, curve: 'lin' },
];
for (const t of FX_DIST_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Remaining continuous fx params that had no target — appended at the very end
// (id-stable). Fills the gaps surfaced by the FxParams-vs-targets audit: tremolo
// had NO continuous target at all (only its on/off), chorus only had Mix, reverb
// only Mix+Decay, delay only Mix+Feedback. Ranges mirror the fx-panel sliders.
// (compSource/vocSource stay OUT — discrete instance indices, not continuous.)
const FX_MISC_TARGETS: RawTarget[] = [
  { code: 'DLT', label: 'Delay Time',    key: 'delayTime',   min: 0.02, max: 1.2,  curve: 'lin', unit: 's' },
  { code: 'RVP', label: 'Reverb Damp',   key: 'reverbDamp',  min: 0,    max: 0.95, curve: 'lin' },
  { code: 'RVS', label: 'Reverb Send',   key: 'reverbSend',  min: 0,    max: 1,    curve: 'lin' },
  { code: 'CHR', label: 'Chorus Rate',   key: 'chorusRate',  min: 0.1,  max: 5,    curve: 'lin', unit: 'Hz' },
  { code: 'CHD', label: 'Chorus Depth',  key: 'chorusDepth', min: 0.5,  max: 5,    curve: 'lin' },
  { code: 'TRM', label: 'Tremolo Mix',   key: 'tremoloMix',  min: 0,    max: 1,    curve: 'lin' },
  { code: 'TRR', label: 'Tremolo Rate',  key: 'tremoloRate', min: 0.5,  max: 15,   curve: 'lin', unit: 'Hz' },
  { code: 'FMD', label: 'Filter Mode',   key: 'filterMode',  min: 0,    max: 2,    curve: 'enum' },
];
for (const t of FX_MISC_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Pitch modulation targets — one per PITCHED engine (drum/pitchless excluded).
// inst-scope but handled specially in Engine._applyInstMod (these modulate the
// voice frequency for vibrato, not a param bank). Kept LAST: they're a per-engine
// dynamic block, so their ids can shift as engines are (de)registered — fine,
// since ONLY the per-instrument mod matrix references them (a 2.5.0 addition) and
// no static fx/inst id depends on them. Deliberately kept out of the automation
// picker + global-LFO dropdown (targetsForType excludes them via `t.pitch`) —
// pitch automation would fight note triggers.
for (const type of autoTypes) {
  const def = byType(type);
  if (!def || def.drum || def.pitchless) continue;
  TARGETS.push({ code: 'PCH', label: 'Pitch', min: -12, max: 12, curve: 'lin', unit: 'st', scope: 'inst', type, id: TARGETS.length, pitch: true });
}

// Mod-SOURCE targets — appended at the very end (id-stable). Each addresses one
// knob of a per-instrument mod source SLOT (0 LFO1 · 1 LFO2 · 2 Env), so they are
// engine-agnostic (type '*'). Applied bespoke by the engine (NOT via denorm), like
// pitch: `rate` is an octave shift on the LFO period; `wtpos`/`amount`/a/d/s/r are
// additive within [min,max]. Routable ONLY by the two mod matrices (per-instrument
// self-targeting + the global LFO matrix) — kept out of the automation picker.
const MODSRC_TARGETS: RawTarget[] = [
  { code: 'L1R', label: 'LFO 1 Rate',    min: 0, max: 1, curve: 'lin', modSlot: 0, modField: 'rate' },
  { code: 'L1W', label: 'LFO 1 WtPos',   min: 0, max: 1, curve: 'lin', modSlot: 0, modField: 'wtpos' },
  { code: 'L1M', label: 'LFO 1 Amount',  min: 0, max: 2, curve: 'lin', modSlot: 0, modField: 'amount' },
  { code: 'L2R', label: 'LFO 2 Rate',    min: 0, max: 1, curve: 'lin', modSlot: 1, modField: 'rate' },
  { code: 'L2W', label: 'LFO 2 WtPos',   min: 0, max: 1, curve: 'lin', modSlot: 1, modField: 'wtpos' },
  { code: 'L2M', label: 'LFO 2 Amount',  min: 0, max: 2, curve: 'lin', modSlot: 1, modField: 'amount' },
  { code: 'EnA', label: 'Env Attack',    min: 0.001, max: 2, curve: 'lin', unit: 's', modSlot: 2, modField: 'a' },
  { code: 'EnD', label: 'Env Decay',     min: 0.001, max: 2, curve: 'lin', unit: 's', modSlot: 2, modField: 'd' },
  { code: 'EnS', label: 'Env Sustain',   min: 0, max: 1, curve: 'lin', modSlot: 2, modField: 's' },
  { code: 'EnR', label: 'Env Release',   min: 0.001, max: 4, curve: 'lin', unit: 's', modSlot: 2, modField: 'r' },
  { code: 'EnM', label: 'Env Amount',    min: 0, max: 2, curve: 'lin', modSlot: 2, modField: 'amount' },
];
for (const t of MODSRC_TARGETS) TARGETS.push({ ...t, scope: 'modsrc', type: '*', id: TARGETS.length });

// Pitch-shifter fx targets — appended at the very end (id-stable), AFTER the modsrc
// block, so every existing id (incl. the persisted modsrc/pitch ids) is unchanged.
// fx-scope → they auto-appear in the automation picker + both LFO matrices. (Sweep
// PSH for a portamento/dive; PSM to swell the octave in.)
const FX_PITCH_TARGETS: RawTarget[] = [
  { code: 'PSH', label: 'Pitch Shift', key: 'pitchShift',  min: -24, max: 24, curve: 'lin', unit: 'st' },
  { code: 'PSM', label: 'Pitch Mix',   key: 'pitchMix',    min: 0,   max: 1,  curve: 'lin' },
  { code: 'PH2', label: 'Harmony',     key: 'pitchVoice2', min: -24, max: 24, curve: 'lin', unit: 'st' },
  { code: 'PHL', label: 'Harm Level',  key: 'pitchV2Level', min: 0,  max: 1,  curve: 'lin' },
];
for (const t of FX_PITCH_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

// Pitch-shifter harmony voices 3 & 4, stereo spread — appended after the original
// pitch block (still id-stable; existing ids above are untouched). Intervals are
// semitones when Scale=Off, else diatonic scale steps (same as voices 1 & 2).
const FX_PITCH2_TARGETS: RawTarget[] = [
  { code: 'PH3', label: 'Harmony 3',   key: 'pitchVoice3', min: -24, max: 24, curve: 'lin', unit: 'st' },
  { code: 'PL3', label: 'Harm 3 Lvl',  key: 'pitchV3Level', min: 0,  max: 1,  curve: 'lin' },
  { code: 'PH4', label: 'Harmony 4',   key: 'pitchVoice4', min: -24, max: 24, curve: 'lin', unit: 'st' },
  { code: 'PL4', label: 'Harm 4 Lvl',  key: 'pitchV4Level', min: 0,  max: 1,  curve: 'lin' },
  { code: 'PSP', label: 'Pitch Spread', key: 'pitchSpread', min: 0,  max: 1,  curve: 'lin' },
];
for (const t of FX_PITCH2_TARGETS) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });

export function targetById(id: number): ParamTarget | null {
  return (id >= 0 && id < TARGETS.length) ? TARGETS[id] : null;
}

// Targets selectable for a given engine type: its own inst targets + all fx +
// all per-channel (chan) targets + all global targets.
export function targetsForType(type: InstrumentType): ParamTarget[] {
  return TARGETS.filter((t) => !t.pitch && t.scope !== 'modsrc' && (t.scope === 'fx' || t.scope === 'chan' || t.scope === 'global' || t.type === type));
}

// Targets the per-instrument modulation matrix can route to: this engine's own
// inst params (incl. its pitch target) + all fx params + the mod-source knobs
// (modsrc) of this instance's own sources (self-targeting; the UI hides a route's
// own slot). Excludes chan/global, which are song-scope and belong to the
// global-LFO matrix instead.
export function instModTargetsForType(type: InstrumentType): ParamTarget[] {
  return TARGETS.filter((t) => t.scope === 'fx' || t.scope === 'modsrc' || (t.scope === 'inst' && t.type === type));
}

// The mod-source knob targets (LFO/env rate/wtpos/amount/adsr), for both matrices'
// "target a source" sections. Engine-agnostic; ordered by source slot.
export function modSrcTargets(): ParamTarget[] {
  return TARGETS.filter((t) => t.scope === 'modsrc');
}

export function targetByCode(type: InstrumentType, code: string): ParamTarget | null {
  const up = code.toUpperCase();
  return targetsForType(type).find((t) => t.code === up) || null;
}

// Normalized byte (0..255) → real engine value.
export function denorm(t: ParamTarget, byte: number): number {
  if (t.toggle) return byte > 0 ? 1 : 0;   // stomp box: 0 = off, anything else = on
  const x = Math.max(0, Math.min(255, byte)) / 255;
  if (t.curve === 'log') {
    const lo = Math.max(1e-4, t.min);
    return lo * Math.pow(t.max / lo, x);
  }
  if (t.curve === 'enum') return Math.round(x * t.max);
  return t.min + (t.max - t.min) * x;
}

// Real value → normalized position in [0,1] (UNROUNDED, unlike normByte which
// rounds to a byte). Used by the LFO to find a target's center without quantizing
// it to 8-bit; pairs with denormUnit for the inverse.
export function normUnit(t: ParamTarget, value: number): number {
  if (t.curve === 'log') {
    const lo = Math.max(1e-4, t.min);
    return Math.log(Math.max(lo, value) / lo) / Math.log(t.max / lo);
  }
  if (t.curve === 'enum') return t.max ? value / t.max : 0;
  return (t.max === t.min) ? 0 : (value - t.min) / (t.max - t.min);
}

// Normalized position [0,1] → real value (unrounded inverse of normUnit).
export function denormUnit(t: ParamTarget, x: number): number {
  const xx = Math.max(0, Math.min(1, x));
  if (t.curve === 'log') {
    const lo = Math.max(1e-4, t.min);
    return lo * Math.pow(t.max / lo, xx);
  }
  if (t.curve === 'enum') return Math.round(xx * t.max);
  return t.min + (t.max - t.min) * xx;
}

// Real engine value → normalized byte (for song authoring / future MIDI learn).
export function normByte(t: ParamTarget, value: number): number {
  if (t.toggle) return value > 0 ? 255 : 0;
  let x;
  if (t.curve === 'log') {
    const lo = Math.max(1e-4, t.min);
    x = Math.log(Math.max(lo, value) / lo) / Math.log(t.max / lo);
  } else if (t.curve === 'enum') {
    x = t.max ? value / t.max : 0;
  } else {
    x = (value - t.min) / (t.max - t.min);
  }
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

// Human-readable value, for tooltips/picker (e.g. "2.1kHz", "0.62").
export function fmtValue(t: ParamTarget, byte: number): string {
  if (t.toggle) return byte > 0 ? 'On' : 'Off';
  const v = denorm(t, byte);
  if (t.curve === 'enum') return String(v);
  if (t.unit === 'pan') {
    const d = Math.round((v - 0.5) * 200); // -100 (L) .. +100 (R)
    return d === 0 ? 'C' : (d < 0 ? 'L' + -d : 'R' + d);
  }
  if (t.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(1) + 'kHz' : Math.round(v) + 'Hz';
  if (t.unit) return v.toFixed(2) + t.unit;
  return v.toFixed(2);
}
