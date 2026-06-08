// SongStore (localStorage user-song library). Uses an in-memory KVStore stand-in
// so it runs under plain node, and stubs Date.now where ordering matters.
import { test, assert, assertEq } from './_harness.js';
import { SongStore } from '../../src/tracker/song-store.js';
import type { KVStore } from '../../src/tracker/song-store.js';
import type { SerializedSong } from '../../src/tracker/song-io.js';

// Minimal in-memory backend.
function memStore(): KVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

// A minimal document that survives deserializeSong (format/version + the three
// required arrays); migrate() fills lfos/modRoutings.
function doc(name: string, color = '#39ff14'): SerializedSong {
  return {
    format: 'shaderwave-song', version: 1, name,
    bpm: 120, rowsPerBeat: 4, master: 1, pan: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    instruments: [{ name: 'I', type: '303', color, p0: [400, 0.7, 0.5, 0.3], p1: [0, 0.3, 0.4, 0] }],
    order: [0],
    patterns: [{ rows: 4, channels: 8, notes: [], inst: [], vol: [], fxCmd: [], fxVal: [], autoTracks: [] }],
  } as SerializedSong;
}

test('song-store: save → list → load round-trip', () => {
  const s = new SongStore(memStore());
  const id = s.createId();
  assertEq(s.save(id, doc('Hello')).ok, true, 'save ok');
  const list = s.list();
  assertEq(list.length, 1, 'one song listed');
  assertEq(list[0].name, 'Hello', 'index carries the name');
  assertEq(list[0].color, '#39ff14', 'index carries the first-instrument colour');
  const loaded = s.load(id);
  assert(loaded !== null, 'loads back');
  assertEq(loaded!.name, 'Hello', 'loaded body has the right name');
});

test('song-store: re-save preserves createdAt, dedupes the index, bumps updatedAt', () => {
  const s = new SongStore(memStore());
  const id = s.createId();
  const realNow = Date.now;
  try {
    (Date as unknown as { now: () => number }).now = () => 1000;
    s.save(id, doc('v1'));
    const created = s.list()[0].createdAt;
    assertEq(created, 1000, 'createdAt stamped on first save');
    (Date as unknown as { now: () => number }).now = () => 5000;
    s.save(id, doc('v2'));
    const list = s.list();
    assertEq(list.length, 1, 'still one index entry (dedup by id)');
    assertEq(list[0].createdAt, 1000, 'createdAt preserved across re-save');
    assertEq(list[0].updatedAt, 5000, 'updatedAt bumped');
    assertEq(s.load(id)!.name, 'v2', 'body overwritten');
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }
});

test('song-store: list is newest-first', () => {
  const s = new SongStore(memStore());
  const realNow = Date.now;
  try {
    (Date as unknown as { now: () => number }).now = () => 1000;
    const a = s.createId(); s.save(a, doc('older'));
    (Date as unknown as { now: () => number }).now = () => 2000;
    const b = s.createId(); s.save(b, doc('newer'));
    const list = s.list();
    assertEq(list[0].id, b, 'newest first');
    assertEq(list[1].id, a, 'older second');
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }
});

test('song-store: delete removes body + index entry', () => {
  const s = new SongStore(memStore());
  const id = s.createId();
  s.save(id, doc('Doomed'));
  s.delete(id);
  assertEq(s.list().length, 0, 'gone from index');
  assertEq(s.load(id), null, 'body gone');
});

test('song-store: load prunes a stale index entry whose body vanished', () => {
  const back = memStore();
  const s = new SongStore(back);
  const id = s.createId();
  s.save(id, doc('Ghost'));
  back.map.delete('shaderwave:song:' + id);   // body disappears, index still lists it
  assertEq(s.load(id), null, 'missing body → null');
  assertEq(s.list().length, 0, 'stale index entry pruned on load');
});

test('song-store: quota failure is reported and rolls back (no orphan body)', () => {
  const back = memStore();
  // Throw a quota-style error on ANY setItem.
  back.setItem = () => { const e = new Error('exceeded the quota'); e.name = 'QuotaExceededError'; throw e; };
  const s = new SongStore(back);
  const res = s.save(s.createId(), doc('TooBig'));
  assertEq(res.ok, false, 'save reports failure');
  assert(/storage space/i.test(res.error || ''), 'quota message surfaced');
  assertEq(back.map.size, 0, 'nothing left behind (body rolled back)');
});

test('song-store: corrupt index is tolerated', () => {
  const back = memStore();
  back.map.set('shaderwave:songs:index', '{not json');
  const s = new SongStore(back);
  assertEq(s.list().length, 0, 'garbage index → empty list, no throw');
});

test('song-store: unavailable backend degrades gracefully', () => {
  const s = new SongStore(null);
  assertEq(s.available(), false, 'reports unavailable');
  assertEq(s.list().length, 0, 'list empty');
  assertEq(s.load('x'), null, 'load null');
  assertEq(s.save('x', doc('X')).ok, false, 'save fails cleanly');
  s.delete('x');   // must not throw
});
