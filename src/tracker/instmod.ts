// Per-instrument modulation matrix — each instrument INSTANCE owns a small fixed
// bank of sources (2 LFOs + 1 mod envelope) plus routes wiring a source to one of
// that instance's own params (inst bank, fx, or pitch). Unlike the song-wide LFOs
// in lfo.ts, the source config lives inline and the target is implicitly the owner,
// so the whole matrix serializes per-instrument and drops into a preset with no
// song-pool index to remap. Evaluated on the CPU per render block in
// Engine._applyInstMod (no shader); see src/types.ts for the data shapes.
import type { InstrumentMod, ModEnv, ModSource } from '../types.js';
import { defaultLfo, normalizeLfo } from './lfo.js';

// Fixed source layout: sources[0..1] are LFOs, sources[2] is the mod envelope.
export const INST_LFO_COUNT = 2;
export const INST_ENV_COUNT = 1;
export const INST_SOURCE_COUNT = INST_LFO_COUNT + INST_ENV_COUNT;
export const INST_MOD_MAX_ROUTES = 8;          // UI/sanity cap on matrix rows
// Source-slot labels for the UI (index → display name).
export const INST_SOURCE_LABELS = ['LFO 1', 'LFO 2', 'Env'];

export function defaultModEnv(): ModEnv {
  return { a: 0.01, d: 0.3, s: 0.6, r: 0.4 };
}

export function defaultModSource(kind: ModSource['kind']): ModSource {
  return { kind, retrigger: false, lfo: defaultLfo(), env: defaultModEnv() };
}

// A fresh matrix: two LFOs + one envelope, NO routes (so it's inert until the
// user wires something — instances stay bit-identical to before).
export function defaultInstMod(): InstrumentMod {
  const sources: ModSource[] = [];
  for (let i = 0; i < INST_LFO_COUNT; i++) sources.push(defaultModSource('lfo'));
  for (let i = 0; i < INST_ENV_COUNT; i++) sources.push(defaultModSource('env'));
  return { sources, routes: [] };
}

export function cloneInstMod(m: InstrumentMod): InstrumentMod {
  return {
    sources: m.sources.map((s) => ({ kind: s.kind, retrigger: s.retrigger, lfo: { ...s.lfo }, env: { ...s.env } })),
    routes: m.routes.map((r) => ({ ...r })),
  };
}

function normalizeEnv(raw: Partial<ModEnv> | undefined): ModEnv {
  const d = defaultModEnv();
  if (!raw) return d;
  return {
    a: raw.a ?? d.a,
    d: raw.d ?? d.d,
    s: raw.s ?? d.s,
    r: raw.r ?? d.r,
  };
}

// Coerce a possibly-partial/legacy matrix into the canonical fixed layout (used by
// song load / preset apply so older or hand-edited files can't throw). The slot
// KIND is fixed by position — we keep whatever config a slot carried but force its
// kind, so the 2-LFO-then-env contract always holds.
export function normalizeInstMod(raw: Partial<InstrumentMod> | undefined): InstrumentMod {
  const base = defaultInstMod();
  if (!raw) return base;
  const srcIn = Array.isArray(raw.sources) ? raw.sources : [];
  base.sources = base.sources.map((slot, i) => {
    const r = srcIn[i] as Partial<ModSource> | undefined;
    return {
      kind: slot.kind,                       // slot kind is fixed by position
      retrigger: r?.retrigger ?? false,
      lfo: normalizeLfo(r?.lfo),
      env: normalizeEnv(r?.env),
    };
  });
  base.routes = (Array.isArray(raw.routes) ? raw.routes : [])
    .slice(0, INST_MOD_MAX_ROUTES)
    .map((r) => ({
      source: Math.max(0, Math.min(INST_SOURCE_COUNT - 1, r?.source ?? 0)),
      targetParamId: r?.targetParamId ?? -1,
      depth: r?.depth ?? 0,
      bipolar: r?.bipolar ?? true,
    }));
  return base;
}

// Whether a matrix carries anything worth persisting (any wired route). Lets the
// serializer omit `mod` for the common untouched instance, keeping files lean.
export function instModHasContent(m: InstrumentMod | undefined): boolean {
  return !!m && m.routes.some((r) => r.targetParamId >= 0 && r.depth !== 0);
}

// Dedicated mod-envelope level in [0,1] for a voice. `t` = seconds since note-on,
// `tRel` = seconds since note-off (negative while the note is still held). Release
// eases from the level the envelope had reached AT the moment of note-off (computed
// from t - tRel, the held duration), so a key-up mid-attack doesn't jump.
export function modEnvValue(env: ModEnv, t: number, tRel: number): number {
  if (t <= 0) return 0;
  if (tRel < 0) return adLevel(env, t);                 // held: attack → decay → sustain
  const rel = Math.max(1e-4, env.r);
  if (tRel >= rel) return 0;
  return adLevel(env, t - tRel) * (1 - tRel / rel);     // release from the level at key-up
}

// Attack/decay/sustain level (no release) at `x` seconds since note-on.
function adLevel(env: ModEnv, x: number): number {
  const a = Math.max(1e-4, env.a);
  if (x < a) return x / a;                               // attack 0 → 1
  const d = Math.max(1e-4, env.d);
  const s = Math.max(0, Math.min(1, env.s));
  if (x < a + d) return 1 - (1 - s) * ((x - a) / d);     // decay 1 → s
  return s;                                              // sustain
}
