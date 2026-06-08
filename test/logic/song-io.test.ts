// Song save/load round-trip — the persistence path has no other net. Serialize a
// real demo song, JSON-cycle it, deserialize, and confirm the structural data
// (patterns, automation tracks, instrument params, LFOs/routings) survives. Also
// guards the version gate.
import { test, assert, assertEq } from './_harness.js';
import {
  serializeSong, deserializeSong, patternFromSerialized, SONG_FORMAT, SONG_FORMAT_VERSION,
} from '../../src/tracker/song-io.js';
import { DEMO_SONGS, loadSongInstruments } from '../../src/tracker/song.js';
import { defaultLfos, LFO_COUNT } from '../../src/tracker/lfo.js';
import type { SongIOInput } from '../../src/tracker/song-io.js';

// Build a SongIOInput out of a loaded demo song (mirrors what the app hands over).
function ioInput(songIdx: number): SongIOInput {
  const def = DEMO_SONGS[songIdx];
  const { instruments, data } = loadSongInstruments(def);
  return {
    name: def.name, author: '', note: '',
    bpm: data.bpm, rowsPerBeat: data.rowsPerBeat ?? 4,
    master: data.master ?? 1, pan: data.pan ?? new Array(8).fill(0.5),
    instruments, order: data.order, patterns: data.patterns,
    lfos: (data.lfos && data.lfos.length) ? data.lfos : defaultLfos(),
    modRoutings: data.modRoutings ?? [],
  };
}

test('round-trip preserves structure for a representative demo song', () => {
  const input = ioInput(0);
  const ser = serializeSong(input);
  const reloaded = deserializeSong(JSON.parse(JSON.stringify(ser)));

  assertEq(reloaded.format, SONG_FORMAT, 'format tag');
  assertEq(reloaded.version, SONG_FORMAT_VERSION, 'version');
  assertEq(reloaded.instruments.length, input.instruments.length, 'instrument count');
  assertEq(reloaded.patterns.length, input.patterns.length, 'pattern count');
  assertEq(reloaded.lfos!.length, LFO_COUNT, 'LFO sources present');

  // Instrument params survive.
  for (let i = 0; i < input.instruments.length; i++) {
    const a = input.instruments[i], b = reloaded.instruments[i];
    assertEq(b.type, a.type, `inst ${i} type`);
    for (let k = 0; k < 4; k++) assert(Math.abs(b.p0[k] - a.p0[k]) < 1e-3, `inst ${i} p0[${k}]`);
  }

  // Patterns rebuild and keep their notes + automation tracks.
  for (let p = 0; p < input.patterns.length; p++) {
    const orig = input.patterns[p];
    const rebuilt = patternFromSerialized(reloaded.patterns[p]);
    assertEq(rebuilt.notes.length, orig.notes.length, `pattern ${p} note count`);
    for (let i = 0; i < orig.notes.length; i++) assertEq(rebuilt.notes[i], orig.notes[i], `pattern ${p} note ${i}`);
    assertEq(rebuilt.autoTracks.length, orig.autoTracks.length, `pattern ${p} autoTrack count`);
    for (let t = 0; t < orig.autoTracks.length; t++) {
      assertEq(rebuilt.autoTracks[t].targetParamId, orig.autoTracks[t].targetParamId, `pattern ${p} track ${t} paramId`);
      assertEq(rebuilt.autoTracks[t].targetInstIdx, orig.autoTracks[t].targetInstIdx, `pattern ${p} track ${t} instIdx`);
    }
  }
});

test('deserialize rejects a newer format version', () => {
  let threw = false;
  try { deserializeSong({ format: SONG_FORMAT, version: SONG_FORMAT_VERSION + 1, patterns: [], order: [], instruments: [] }); }
  catch { threw = true; }
  assert(threw, 'a newer-version file must throw');
});

test('deserialize rejects a non-ShaderWave file', () => {
  let threw = false;
  try { deserializeSong({ format: 'something-else', version: 1 }); }
  catch { threw = true; }
  assert(threw, 'a foreign file must throw');
});

test('deserialize normalizes a partial LFO/routing set without throwing', () => {
  const ser = serializeSong(ioInput(0));
  const stripped = { ...JSON.parse(JSON.stringify(ser)), lfos: [{ shape: 1 }], modRoutings: [{ targetParamId: 3 }] };
  const out = deserializeSong(stripped);
  assertEq(out.lfos!.length, LFO_COUNT, 'partial lfos padded to LFO_COUNT');
  assert(out.modRoutings!.length === 1 && out.modRoutings![0].depth === 0, 'partial routing normalized');
});
