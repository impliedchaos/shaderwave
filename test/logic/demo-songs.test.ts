// Every demo song must load cleanly. This is the audit script from MEMORY.md made
// permanent: loadSongInstruments must not throw, must leave no holes in the
// instrument table, and every automation / mod-matrix target must point at an
// in-range instance whose engine type matches the param. A common past bug was an
// inst-scope track carrying a stale channel number instead of an instrument index.
import { test, assert } from './_harness.js';
import { DEMO_SONGS, loadSongInstruments } from '../../src/tracker/song.js';
import { targetById } from '../../src/tracker/automation.js';

test('every demo song loads without throwing', () => {
  for (const def of DEMO_SONGS) {
    let ok = true;
    try { loadSongInstruments(def); } catch (e) { ok = false; throw new Error(`${def.name} threw: ${(e as Error).message}`); }
    assert(ok, `${def.name} loaded`);
  }
});

test('loaded instrument tables have no holes and patterns index in range', () => {
  for (const def of DEMO_SONGS) {
    const { instruments, data } = loadSongInstruments(def);
    assert(instruments.length >= 1, `${def.name}: at least one instrument`);
    for (let i = 0; i < instruments.length; i++) {
      assert(instruments[i] && typeof instruments[i].type === 'string', `${def.name}: instrument ${i} is not a hole`);
    }
    for (const pat of data.patterns) {
      for (let i = 0; i < pat.inst.length; i++) {
        assert(pat.inst[i] >= 0 && pat.inst[i] < instruments.length, `${def.name}: cell instrument index in range`);
      }
    }
  }
});

test('inst/fx automation + routing targets are in range and type-correct', () => {
  for (const def of DEMO_SONGS) {
    const { instruments, data } = loadSongInstruments(def);
    const checkInstTarget = (paramId: number, instIdx: number | null, where: string) => {
      const t = targetById(paramId);
      if (!t || (t.scope !== 'inst' && t.scope !== 'fx')) return;   // chan/global don't bind an instance
      assert(instIdx !== null && instIdx >= 0 && instIdx < instruments.length,
        `${def.name}: ${where} targetInstIdx ${instIdx} out of range`);
      if (t.scope === 'inst') {
        assert(instruments[instIdx!].type === t.type,
          `${def.name}: ${where} inst target type ${t.type} ≠ instrument ${instruments[instIdx!].type}`);
      }
    };
    for (const pat of data.patterns) {
      for (const trk of pat.autoTracks) checkInstTarget(trk.targetParamId, trk.targetInstIdx, 'autoTrack');
    }
    for (const r of data.modRoutings ?? []) checkInstTarget(r.targetParamId, r.targetInstIdx, 'modRouting');
  }
});
