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

// inst-scope targets, grouped by engine type. bank/index point into p0/p1.
const INST = {
  '303': [
    { code: 'CUT', label: 'Cutoff',       bank: 'p0', index: 0, min: 30, max: 4000, curve: 'log', unit: 'Hz' },
    { code: 'RES', label: 'Resonance',    bank: 'p0', index: 1, min: 0,  max: 0.98, curve: 'lin' },
    { code: 'ENV', label: 'Env Mod',      bank: 'p0', index: 2, min: 0,  max: 1,    curve: 'lin' },
    { code: 'ACC', label: 'Accent',       bank: 'p0', index: 3, min: 0,  max: 1,    curve: 'lin' },
    { code: 'WAV', label: 'Wave',         bank: 'p1', index: 0, min: 0,  max: 4,    curve: 'enum' },
    { code: 'FDC', label: 'Filter Decay', bank: 'p1', index: 1, min: 0.05, max: 1,  curve: 'lin', unit: 's' },
    { code: 'ADC', label: 'Amp Decay',    bank: 'p1', index: 2, min: 0.05, max: 1,  curve: 'lin', unit: 's' },
  ],
  'moog': [
    { code: 'CUT', label: 'Cutoff',       bank: 'p0', index: 0, min: 30, max: 6000, curve: 'log', unit: 'Hz' },
    { code: 'RES', label: 'Resonance',    bank: 'p0', index: 1, min: 0,  max: 0.95, curve: 'lin' },
    { code: 'FEN', label: 'Filter Env',   bank: 'p0', index: 2, min: 0,  max: 1,    curve: 'lin' },
    { code: 'DTC', label: 'Detune',       bank: 'p1', index: 0, min: 0,  max: 30,   curve: 'lin', unit: 'ct' },
    { code: 'SUS', label: 'Amp Sustain',  bank: 'p1', index: 1, min: 0,  max: 1,    curve: 'lin' },
    { code: 'FDC', label: 'Filter Decay', bank: 'p1', index: 2, min: 0.05, max: 2,  curve: 'lin', unit: 's' },
    { code: 'ADC', label: 'Amp Decay',    bank: 'p1', index: 3, min: 0.05, max: 2,  curve: 'lin', unit: 's' },
  ],
  'dx7': [
    { code: 'MOD', label: 'Mod Index',    bank: 'p0', index: 2, min: 0,  max: 12,   curve: 'lin' },
    { code: 'FBK', label: 'Feedback',     bank: 'p0', index: 3, min: 0,  max: 1,    curve: 'lin' },
    { code: 'MDD', label: 'Mod Decay',    bank: 'p1', index: 1, min: 0.05, max: 4,  curve: 'lin', unit: 's' },
    { code: 'AMD', label: 'Amp Decay',    bank: 'p1', index: 2, min: 0.05, max: 4,  curve: 'lin', unit: 's' },
  ],
  '808': [
    { code: 'TON', label: 'Tone',         bank: 'p0', index: 1, min: 0,  max: 1,    curve: 'lin' },
    { code: 'DEC', label: 'Decay',        bank: 'p0', index: 2, min: 0,  max: 1,    curve: 'lin' },
    { code: 'SNP', label: 'Snappy',       bank: 'p0', index: 3, min: 0,  max: 1,    curve: 'lin' },
  ],
};

// fx-scope targets. `key` is a fxParams field; these apply to whichever engine
// type the channel's instrument is, and are shared across that type's channels.
const FX = [
  { code: 'MST', label: 'FX Master',     key: 'master',        min: 0,     max: 1.5,   curve: 'lin' },
  { code: 'DRV', label: 'Distortion',    key: 'dist',          min: 0.001, max: 20,    curve: 'log' },
  { code: 'DLM', label: 'Delay Mix',     key: 'delayMix',      min: 0,     max: 1,     curve: 'lin' },
  { code: 'DLF', label: 'Delay Fbk',     key: 'delayFeedback', min: 0,     max: 0.9,   curve: 'lin' },
  { code: 'RVM', label: 'Reverb Mix',    key: 'reverbMix',     min: 0,     max: 1,     curve: 'lin' },
  { code: 'RVD', label: 'Reverb Decay',  key: 'reverbDecay',   min: 0,     max: 0.97,  curve: 'lin' },
  { code: 'CHM', label: 'Chorus Mix',    key: 'chorusMix',     min: 0,     max: 1,     curve: 'lin' },
  { code: 'WID', label: 'Width',         key: 'width',         min: 0,     max: 2,     curve: 'lin' },
];

// chan-scope targets. Per-channel mix params, engine-agnostic (offered on every
// channel). Pan is 0 = hard left, 0.5 = centre, 1 = hard right (equal-power in
// the mix shader).
const CHAN = [
  { code: 'PAN', label: 'Pan', key: 'pan', min: 0, max: 1, curve: 'lin', unit: 'pan' },
];

// Flatten into a stable, id-indexed table. Order = append-only.
export const TARGETS = [];
for (const type of ['303', 'moog', 'dx7', '808']) {
  for (const t of INST[type]) TARGETS.push({ ...t, scope: 'inst', type, id: TARGETS.length });
}
for (const t of FX) TARGETS.push({ ...t, scope: 'fx', type: '*', id: TARGETS.length });
for (const t of CHAN) TARGETS.push({ ...t, scope: 'chan', type: '*', id: TARGETS.length });

export function targetById(id) {
  return (id >= 0 && id < TARGETS.length) ? TARGETS[id] : null;
}

// Targets selectable for a given engine type: its own inst targets + all fx +
// all per-channel (chan) targets.
export function targetsForType(type) {
  return TARGETS.filter((t) => t.scope === 'fx' || t.scope === 'chan' || t.type === type);
}

export function targetByCode(type, code) {
  const up = code.toUpperCase();
  return targetsForType(type).find((t) => t.code === up) || null;
}

// Normalized byte (0..255) → real engine value.
export function denorm(t, byte) {
  const x = Math.max(0, Math.min(255, byte)) / 255;
  if (t.curve === 'log') {
    const lo = Math.max(1e-4, t.min);
    return lo * Math.pow(t.max / lo, x);
  }
  if (t.curve === 'enum') return Math.round(x * t.max);
  return t.min + (t.max - t.min) * x;
}

// Real engine value → normalized byte (for song authoring / future MIDI learn).
export function normByte(t, value) {
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
export function fmtValue(t, byte) {
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
