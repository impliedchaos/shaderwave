// User-instrument-preset persistence in IndexedDB. The same small CRUD shape as
// SongStore (src/tracker/song-store.ts) — a tiny in-memory metadata cache so the
// preset dropdown can list SYNCHRONOUSLY, with full bodies (gzipped JSON) read /
// written asynchronously. Kept in its OWN database (`shaderwave-presets`) so it
// can't collide with or trigger a version-migration of the song database.
//
// A stored body is exactly the `.json` import/export format — one `Preset` object
// (with its sample, if any, packed as base64 Int16 via serializeSample). So export
// is "read the body, download it" and import is "parse, validate, save".
import type { Preset, InstrumentType } from '../types.js';

export interface UserPresetMeta {
  id: string;
  type: InstrumentType;   // engine bucket — the dropdown lists only the selected engine's presets
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface PresetSaveResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const DB_NAME = 'shaderwave-presets';
const DB_VERSION = 1;
const META_STORE = 'meta';     // small {id,type,name,…} records — all read at init
const BODY_STORE = 'bodies';   // { id, gz, data } — one gzipped Preset each

interface BodyRecord { id: string; gz: boolean; data: ArrayBuffer | string }

const CAN_GZIP = typeof CompressionStream !== 'undefined';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function packBody(id: string, json: string): Promise<BodyRecord> {
  if (!CAN_GZIP) return { id, gz: false, data: json };
  const data = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return { id, gz: true, data };
}

async function unpackBody(rec: BodyRecord): Promise<string> {
  if (!rec.gz) return typeof rec.data === 'string' ? rec.data : new TextDecoder().decode(rec.data);
  const buf = rec.data as ArrayBuffer;
  return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export class PresetStore {
  private db: IDBDatabase | null = null;
  private cache = new Map<string, UserPresetMeta>();   // id → metadata, loaded at init
  private ready = false;

  // Open the database and load the metadata index. Degrades to a no-op store
  // (sandboxed/private contexts) rather than throwing. Idempotent.
  async init(): Promise<void> {
    if (this.ready) return;
    try {
      this.db = await this._open();
      const all = await req(this.db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll());
      this.cache.clear();
      for (const m of all as UserPresetMeta[]) this.cache.set(m.id, m);
    } catch (e) {
      this.db = null;
      console.warn('Preset storage unavailable:', e);
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

  createId(): string {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // User presets for one engine type, newest first (synchronous — in-memory cache).
  list(type: InstrumentType): UserPresetMeta[] {
    return [...this.cache.values()].filter((m) => m.type === type).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  metaFor(id: string): UserPresetMeta | undefined { return this.cache.get(id); }

  // Load one preset body. Returns null if absent/unparseable (and prunes a stale
  // metadata entry whose body has vanished).
  async load(id: string): Promise<Preset | null> {
    if (!this.db) return null;
    try {
      const rec = await req(this.db.transaction(BODY_STORE, 'readonly').objectStore(BODY_STORE).get(id)) as BodyRecord | undefined;
      if (!rec) { this._forgetMeta(id); return null; }
      return JSON.parse(await unpackBody(rec)) as Preset;
    } catch (e) {
      console.warn('Preset load failed:', e);
      return null;
    }
  }

  // Write a preset body (gzipped) + upsert metadata. A fresh save mints an id; pass
  // an existing id to overwrite. createdAt is preserved across re-saves.
  async save(preset: Preset, id = this.createId()): Promise<PresetSaveResult> {
    if (!this.db) return { ok: false, error: 'Storage is unavailable.' };
    if (!preset.type) return { ok: false, error: 'Preset is missing its engine type.' };
    const prev = this.cache.get(id);
    const now = Date.now();
    const meta: UserPresetMeta = {
      id,
      type: preset.type,
      name: preset.name || 'Untitled',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.cache.set(id, meta);   // reflect immediately for the UI
    try {
      const body = await packBody(id, JSON.stringify(preset));
      await this._tx([META_STORE, BODY_STORE], 'readwrite', (tx) => {
        tx.objectStore(META_STORE).put(meta);
        tx.objectStore(BODY_STORE).put(body);
      });
      return { ok: true, id };
    } catch (e) {
      if (prev) this.cache.set(id, prev); else this.cache.delete(id);   // roll back the cache
      const quota = e instanceof Error && /quota/i.test(e.name + e.message);
      return { ok: false, error: quota ? 'Out of browser storage space.' : 'Could not save the preset.' };
    }
  }

  // Rename keeps the body in sync (its `name` is the source for export filenames).
  async rename(id: string, name: string): Promise<PresetSaveResult> {
    const body = await this.load(id);
    if (!body) return { ok: false, error: 'Preset not found.' };
    return this.save({ ...body, name }, id);
  }

  async delete(id: string): Promise<void> {
    this.cache.delete(id);
    if (!this.db) return;
    try {
      await this._tx([META_STORE, BODY_STORE], 'readwrite', (tx) => {
        tx.objectStore(META_STORE).delete(id);
        tx.objectStore(BODY_STORE).delete(id);
      });
    } catch (e) { console.warn('Preset delete failed:', e); }
  }

  private _forgetMeta(id: string) {
    if (!this.cache.has(id)) return;
    this.cache.delete(id);
    if (this.db) this._tx([META_STORE], 'readwrite', (tx) => tx.objectStore(META_STORE).delete(id)).catch(() => {});
  }

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
