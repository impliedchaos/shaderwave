// Mod matrix — one LFO source can drive many targets simultaneously (the core
// of the matrix inversion done in 1.8.0), plus routing normalization.
import { test, assert } from './_harness.js';
import { Engine } from '../../src/tracker/engine.js';
import { TARGETS, denormUnit } from '../../src/tracker/automation.js';
import { defaultLfo, normalizeRouting, normalizeLfo } from '../../src/tracker/lfo.js';
import { BLOCK } from '../../src/constants.js';
import type { ModRouting } from '../../src/types.js';

const VOL = TARGETS.find((t) => t.code === 'VOL')!;     // global  → vd.master
const PAN = TARGETS.find((t) => t.code === 'PAN')!;     // chan    → panAuto[ch]

test('one source drives two targets in the same block', () => {
  const eng = new Engine(48000);
  eng.lfos = [{ ...defaultLfo(), shape: 0, sync: true, rateBeats: 4 }, defaultLfo()];
  // Both routings read source 0; different scopes so we can observe both outputs.
  const routes: ModRouting[] = [
    { source: 0, targetParamId: VOL.id, targetInstIdx: null, depth: 0.4, bipolar: true },
    { source: 0, targetParamId: PAN.id, targetInstIdx: 0, depth: 0.4, bipolar: true },
  ];
  eng.modRoutings = routes;
  eng.songMaster = denormUnit(VOL, 0.5);
  eng.channelPan[0] = 0.5;
  eng.bpm = 120;
  eng.playing = true;
  eng.startFrame = 0;
  eng._songBeats = 0;

  // Advance a few blocks so the sine source moves off its zero crossing.
  for (let b = 0; b < 8; b++) eng._applyLfos(b * BLOCK);

  assert(Math.abs(eng.vd.master - denormUnit(VOL, 0.5)) > 1e-4, 'VOL target moved off its base');
  assert(Number.isFinite(eng.panAuto[0]) && Math.abs(eng.panAuto[0] - 0.5) > 1e-4, 'PAN target moved off its base');
});

test('a depth-0 or unassigned routing is inert', () => {
  const eng = new Engine(48000);
  eng.lfos = [{ ...defaultLfo(), shape: 0 }, defaultLfo()];
  eng.modRoutings = [
    { source: 0, targetParamId: VOL.id, targetInstIdx: null, depth: 0, bipolar: true },   // depth 0
    { source: 0, targetParamId: -1, targetInstIdx: null, depth: 0.5, bipolar: true },      // unassigned
  ];
  const base = denormUnit(VOL, 0.5);
  eng.songMaster = base;
  eng.vd.master = base;
  eng.bpm = 120; eng.playing = true; eng.startFrame = 0; eng._songBeats = 0;
  for (let b = 0; b < 8; b++) eng._applyLfos(b * BLOCK);
  assert(eng.vd.master === base, 'inert routings leave the target untouched');
});

test('routing/LFO normalization fills partial records', () => {
  const r = normalizeRouting({ targetParamId: 5 });
  assert(r.source === 0 && r.depth === 0 && r.bipolar === true && r.targetInstIdx === null,
    'partial routing defaults');
  const l = normalizeLfo({ shape: 2 });
  assert(l.shape === 2 && l.sync === true && l.rateBeats === 4 && l.rateHz === 1, 'partial LFO defaults');
  // Undefined → full default (must never throw).
  assert(normalizeRouting(undefined).targetParamId === -1, 'undefined routing → default off');
});
