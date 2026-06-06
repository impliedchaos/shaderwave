// DX7 — 6-operator FM. Closed-form in t (no recursion). Unlike the other engines
// its voice config is a 6-operator structure, not flat param banks: it carries a
// bespoke sidebar editor (operator selector + SysEx-ROM browser, customControls)
// and uploads its own per-voice operator uniforms (uOpA..uOpD) via the hook
// below. Presets come from .syx ROMs at runtime, so `presets` is empty.
import type { InstrumentDef } from '../types.js';
import shader from '../gl/shaders/synth-dx7.glsl?raw';

export const idx7: InstrumentDef = {
  type: 'dx7',
  name: 'DX7',
  short: 'DX7',
  label: 'DX7 — FM Synthesizer',
  blurb: '6-operator FM with all 32 algorithms and per-operator envelopes, loaded from .syx SysEx banks (288 patches across 9 ROMs).',
  shader,
  customControls: true,
  defaults: {
    p0: [1, 2, 3.0, 0.3],
    p1: [1, 0.6, 0.9, 3],
    ops: [
      { coarse: 1.0, fine: 0, level: 99, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.25 },
      { coarse: 2.0, fine: 0, level: 99, detune: 0, decay: 0.6, mode: 0, sustain: 0.7, release: 0.25 },
      { coarse: 3.0, fine: 0, level: 60, detune: 0, decay: 0.9, mode: 0, sustain: 0.7, release: 0.25 },
      { coarse: 4.0, fine: 0, level: 80, detune: 0, decay: 0.4, mode: 0, sustain: 0.7, release: 0.25 },
      { coarse: 5.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.7, release: 0.25 },
      { coarse: 6.0, fine: 0, level: 0,  detune: 0, decay: 0.5, mode: 0, sustain: 0.7, release: 0.25 },
    ],
  },
  // Algorithm/feedback are global; the rest are per-operator (driven by the
  // operator-selector UI). Consumed by the generic knob loop in controls.ts.
  paramDefs: [
    { label: 'Algo', type: 'global', bank: 'p1', i: 0, min: 1, max: 32, step: 1 },
    { label: 'Feedback', type: 'global', bank: 'p0', i: 3, min: 0, max: 1.5, step: 0.01 },
    { label: 'Op Mode', type: 'op', key: 'mode', min: 0, max: 1, step: 1 },
    { label: 'Op Coarse', type: 'op', key: 'coarse', min: 0.5, max: 31, step: 0.5 },
    { label: 'Op Fine', type: 'op', key: 'fine', min: 0, max: 99, step: 1 },
    { label: 'Op Level', type: 'op', key: 'level', min: 0, max: 99, step: 1 },
    { label: 'Op Detune', type: 'op', key: 'detune', min: -7, max: 7, step: 1 },
    { label: 'Op Decay', type: 'op', key: 'decay', min: 0.05, max: 4, step: 0.01 },
    { label: 'Op Sustain', type: 'op', key: 'sustain', min: 0, max: 1, step: 0.01 },
    { label: 'Op Release', type: 'op', key: 'release', min: 0.05, max: 4, step: 0.01 },
  ],
  autoTargets: [
    { code: 'MOD', label: 'Mod Index', bank: 'p0', index: 2, min: 0,    max: 12, curve: 'lin' },
    { code: 'FBK', label: 'Feedback',  bank: 'p0', index: 3, min: 0,    max: 1,  curve: 'lin' },
    { code: 'MDD', label: 'Mod Decay', bank: 'p1', index: 1, min: 0.05, max: 4,  curve: 'lin', unit: 's' },
    { code: 'AMD', label: 'Amp Decay', bank: 'p1', index: 2, min: 0.05, max: 4,  curve: 'lin', unit: 's' },
  ],
  // Per-voice operator banks, packed [v*6 + op] into vec4 arrays by the engine.
  // Tolerate a voice-data record without operator banks (minimal test harnesses).
  uploadVoiceUniforms: (gl, prog, vd) => {
    if (!vd.dx7Ops) return;
    gl.uniform4fv(prog.u('uOpA[0]'), vd.dx7Ops.A);   // (coarse, fine, level, detune)
    gl.uniform4fv(prog.u('uOpB[0]'), vd.dx7Ops.B);   // (mode, sustain, release, decay)
    gl.uniform4fv(prog.u('uOpC[0]'), vd.dx7Ops.C);   // (r1, r2, r3, r4)
    gl.uniform4fv(prog.u('uOpD[0]'), vd.dx7Ops.D);   // (l1, l2, l3, l4)
  },
};
