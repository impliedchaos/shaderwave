// SongStore (IndexedDB user-song library). Runs under node via the fake-indexeddb
// polyfill (registers global indexedDB/IDBKeyRange/…). Node 24 also has
// CompressionStream, so the gzip pack/unpack path is exercised for real here.
import 'fake-indexeddb/auto';
import { test, assert, assertEq } from './_harness.js';
import { SongStore } from '../../src/tracker/song-store.js';
import type { SerializedSong } from '../../src/tracker/song-io.js';

function deleteDB(name = 'shaderwave'): Promise<void> {
  return new Promise((res) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => res(); r.onerror = () => res(); r.onblocked = () => res();
  });
}

// A fresh, isolated store per test (closes the prior connection so the DB can be
// dropped without a delete-blocked stall).
let cur: SongStore | null = null;
async function freshStore(): Promise<SongStore> {
  if (cur) cur.close();
  cur = null;
  await deleteDB();
  const s = new SongStore();
  await s.init();
  cur = s;
  return s;
}

// A minimal document that survives deserializeSong; migrate() fills lfos/modRoutings.
function doc(name: string, color = '#39ff14'): SerializedSong {
  return {
    format: 'shaderwave-song', version: 1, name,
    bpm: 120, rowsPerBeat: 4, master: 1, pan: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    instruments: [{ name: 'I', type: '303', color, p0: [400, 0.7, 0.5, 0.3], p1: [0, 0.3, 0.4, 0] }],
    order: [0],
    patterns: [{ rows: 4, channels: 8, notes: [], inst: [], vol: [], fxCmd: [], fxVal: [], autoTracks: [] }],
  } as SerializedSong;
}

test('song-store: save → list → load round-trip (through gzip)', async () => {
  const s = await freshStore();
  assertEq(s.available(), true, 'store opened');
  const id = s.createId();
  assertEq((await s.save(id, doc('Hello'))).ok, true, 'save ok');
  const list = s.list();
  assertEq(list.length, 1, 'one song listed');
  assertEq(list[0].name, 'Hello', 'index carries the name');
  assertEq(list[0].color, '#39ff14', 'index carries the first-instrument colour');
  const loaded = await s.load(id);
  assert(loaded !== null, 'loads back');
  assertEq(loaded!.name, 'Hello', 'loaded body decompresses to the right doc');
});

test('song-store: list is synchronous after a save (in-memory cache)', async () => {
  const s = await freshStore();
  const id = s.createId();
  await s.save(id, doc('Cached'));
  // No await here — list() must reflect the save immediately from the cache.
  assertEq(s.list().length, 1, 'cache updated synchronously');
  assert(s.has(id), 'has() sees it');
});

test('song-store: re-save preserves createdAt, dedupes, bumps updatedAt', async () => {
  const s = await freshStore();
  const id = s.createId();
  const realNow = Date.now;
  try {
    (Date as unknown as { now: () => number }).now = () => 1000;
    await s.save(id, doc('v1'));
    assertEq(s.list()[0].createdAt, 1000, 'createdAt stamped on first save');
    (Date as unknown as { now: () => number }).now = () => 5000;
    await s.save(id, doc('v2'));
    const list = s.list();
    assertEq(list.length, 1, 'still one entry (dedup by id)');
    assertEq(list[0].createdAt, 1000, 'createdAt preserved');
    assertEq(list[0].updatedAt, 5000, 'updatedAt bumped');
    assertEq((await s.load(id))!.name, 'v2', 'body overwritten');
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }
});

test('song-store: list is newest-first', async () => {
  const s = await freshStore();
  const realNow = Date.now;
  try {
    (Date as unknown as { now: () => number }).now = () => 1000;
    const a = s.createId(); await s.save(a, doc('older'));
    (Date as unknown as { now: () => number }).now = () => 2000;
    const b = s.createId(); await s.save(b, doc('newer'));
    const list = s.list();
    assertEq(list[0].id, b, 'newest first');
    assertEq(list[1].id, a, 'older second');
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }
});

test('song-store: persists across a reopen (survives a "reload")', async () => {
  const s = await freshStore();
  const id = s.createId();
  await s.save(id, doc('Persistent'));
  s.close();
  const s2 = new SongStore();
  await s2.init();
  cur = s2;
  assertEq(s2.list().length, 1, 'index reloaded from IndexedDB');
  assertEq((await s2.load(id))!.name, 'Persistent', 'body reloaded');
});

test('song-store: delete removes body + index entry', async () => {
  const s = await freshStore();
  const id = s.createId();
  await s.save(id, doc('Doomed'));
  await s.delete(id);
  assertEq(s.list().length, 0, 'gone from index');
  assertEq(await s.load(id), null, 'body gone');
});

test('song-store: load prunes a stale index entry whose body vanished', async () => {
  const s = await freshStore();
  const id = s.createId();
  await s.save(id, doc('Ghost'));
  // Delete the body directly (a second connection), leaving the metadata behind.
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const o = indexedDB.open('shaderwave', 1); o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
  });
  await new Promise<void>((res) => {
    const tx = db.transaction('bodies', 'readwrite'); tx.objectStore('bodies').delete(id);
    tx.oncomplete = () => res(); tx.onerror = () => res();
  });
  db.close();
  assertEq(await s.load(id), null, 'missing body → null');
  assert(!s.has(id), 'stale index entry pruned on load');
});

test('song-store: unavailable backend degrades gracefully', async () => {
  const real = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
  try {
    const s = new SongStore();
    await s.init();
    assertEq(s.available(), false, 'reports unavailable');
    assertEq(s.list().length, 0, 'list empty');
    assertEq(await s.load('x'), null, 'load null');
    assertEq((await s.save('x', doc('X'))).ok, false, 'save fails cleanly');
    await s.delete('x');   // must not throw
  } finally {
    (globalThis as { indexedDB?: unknown }).indexedDB = real;
  }
});
