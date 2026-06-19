// User-song persistence in IndexedDB. A small CRUD layer the app uses to keep a
// library of saved songs across reloads.
//
// Why IndexedDB (not localStorage): disk-scale capacity (vs ~5 MB), async writes
// off the main thread, and native binary storage — so song bodies are stored
// gzip-compressed (CompressionStream) and the future sampler can store audio bytes
// here too.
//
// The async/sync split that keeps callers simple: the tiny per-song METADATA
// (id/name/colour/timestamps) is loaded into an in-memory cache once at init(), so
// `list()`/`has()` stay SYNCHRONOUS for the UI; only the full bodies — `load`/
// `save`/`delete` — touch IndexedDB asynchronously.
import { encodeSongGz, decodeSongBytes } from './song-codec.js';
import type { SerializedSong } from './song-io.js';

export interface UserSongMeta {
  id: string;
  name: string;
  color: string;       // a representative colour (first instrument) for the list UI
  createdAt: number;
  updatedAt: number;
}

export interface SaveResult {
  ok: boolean;
  error?: string;      // human-readable reason on failure (e.g. quota exceeded)
}

const DB_NAME = 'shaderwave';
const DB_VERSION = 1;
const META_STORE = 'meta';     // small {id,name,color,…} records — all read at init
const BODY_STORE = 'bodies';   // { id, gz, data } — one gzipped song each, read on open
const DEFAULT_COLOR = '#7d8aa0';

// A stored body. New bodies are gzip(binary) (an ArrayBuffer); legacy bodies were
// gzip(JSON) (ArrayBuffer, gz:true) or raw JSON text (string, gz:false). All three
// are content-sniffed on read by decodeSongBytes, so `gz` is now informational only.
// All are structured-cloneable, so IndexedDB stores them directly.
interface BodyRecord { id: string; gz: boolean; data: ArrayBuffer | string }

// Promise-wrap a one-shot IDBRequest (used for readonly gets).
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// A stored body → raw bytes for decodeSongBytes (handles gzip-binary, gzip-JSON,
// and legacy raw-JSON-string bodies uniformly).
function bodyBytes(rec: BodyRecord): Uint8Array {
  return typeof rec.data === 'string' ? new TextEncoder().encode(rec.data) : new Uint8Array(rec.data);
}

export class SongStore {
  private db: IDBDatabase | null = null;
  private cache = new Map<string, UserSongMeta>();   // id → metadata, loaded at init
  private ready = false;

  // Open the database and load the metadata index into memory. Degrades to a no-op
  // store (sandboxed/private contexts) rather than throwing. Idempotent.
  async init(): Promise<void> {
    if (this.ready) return;
    try {
      this.db = await this._open();
      const all = await req(this.db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll());
      this.cache.clear();
      for (const m of all as UserSongMeta[]) this.cache.set(m.id, m);
    } catch (e) {
      this.db = null;   // unavailable — list() empty, save() reports failure, etc.
      console.warn('Song storage unavailable:', e);
    }
    this.ready = true;
  }

  private _open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') { rej(new Error('indexedDB unavailable')); return; }
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BODY_STORE)) db.createObjectStore(BODY_STORE, { keyPath: 'id' });
      };
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
  }

  available(): boolean { return !!this.db; }

  // Close the connection + drop the cache (lets a fresh init() reopen). Mainly for
  // tests/teardown; the app keeps one store open for its lifetime.
  close() {
    if (this.db) { this.db.close(); this.db = null; }
    this.cache.clear();
    this.ready = false;
  }

  createId(): string {
    return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // The saved-song index, newest first (synchronous — reads the in-memory cache).
  list(): UserSongMeta[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  has(id: string): boolean { return this.cache.has(id); }

  // Load + validate one song body. Returns null if absent/unparseable (and prunes a
  // stale metadata entry whose body has vanished).
  async load(id: string): Promise<SerializedSong | null> {
    if (!this.db) return null;
    try {
      const rec = await req(this.db.transaction(BODY_STORE, 'readonly').objectStore(BODY_STORE).get(id)) as BodyRecord | undefined;
      if (!rec) { this._forgetMeta(id); return null; }
      return await decodeSongBytes(bodyBytes(rec));
    } catch (e) {
      console.warn('Song load failed:', e);
      return null;
    }
  }

  // Write a song body (gzipped) + upsert its metadata. createdAt is preserved across
  // re-saves; updatedAt is bumped. The cache updates synchronously (so list() is
  // immediate); a failed write reverts the cache and reports the reason.
  async save(id: string, doc: SerializedSong): Promise<SaveResult> {
    if (!this.db) return { ok: false, error: 'Storage is unavailable.' };
    const prev = this.cache.get(id);
    const now = Date.now();
    const meta: UserSongMeta = {
      id,
      name: doc.name || 'Untitled',
      color: doc.instruments?.[0]?.color || DEFAULT_COLOR,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.cache.set(id, meta);   // reflect immediately for the UI
    try {
      const bytes = await encodeSongGz(doc);   // gzip(binary)
      const body: BodyRecord = { id, gz: true, data: bytes.buffer as ArrayBuffer };
      await this._tx([META_STORE, BODY_STORE], 'readwrite', (tx) => {
        tx.objectStore(META_STORE).put(meta);
        tx.objectStore(BODY_STORE).put(body);
      });
      return { ok: true };
    } catch (e) {
      if (prev) this.cache.set(id, prev); else this.cache.delete(id);   // roll back the cache
      const quota = e instanceof Error && /quota/i.test(e.name + e.message);
      return { ok: false, error: quota ? 'Out of browser storage space.' : 'Could not save the song.' };
    }
  }

  // Remove a song (cache updates synchronously; the IDB delete completes in the bg).
  async delete(id: string): Promise<void> {
    this.cache.delete(id);
    if (!this.db) return;
    try {
      await this._tx([META_STORE, BODY_STORE], 'readwrite', (tx) => {
        tx.objectStore(META_STORE).delete(id);
        tx.objectStore(BODY_STORE).delete(id);
      });
    } catch (e) { console.warn('Song delete failed:', e); }
  }

  // Drop a metadata entry whose body turned out to be missing (best-effort).
  private _forgetMeta(id: string) {
    if (!this.cache.has(id)) return;
    this.cache.delete(id);
    if (this.db) this._tx([META_STORE], 'readwrite', (tx) => tx.objectStore(META_STORE).delete(id)).catch(() => {});
  }

  // Run a transaction to completion (puts/deletes are issued synchronously in `fn`).
  private _tx(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> {
    return new Promise((res, rej) => {
      const tx = this.db!.transaction(stores, mode);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
      fn(tx);
    });
  }
}
