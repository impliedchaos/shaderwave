// User-song persistence in localStorage. A small CRUD layer the app uses to keep
// a library of saved songs across reloads (Phase 2 of the undo/persistence work).
//
// Layout — two kinds of key so the boot path is cheap:
//   shaderwave:songs:index  → JSON array of UserSongMeta (id/name/color/timestamps),
//                             read once on startup to populate the song list.
//   shaderwave:song:<id>    → the full SerializedSong (minified) for one song,
//                             read only when that song is actually opened.
// Keeping bodies out of the index means listing N songs doesn't parse N×~300 KB.
//
// The backend is injectable (defaults to window.localStorage) so this module is
// testable under plain node, and so a future swap to IndexedDB is localized here.
import { deserializeSong } from './song-io.js';
import type { SerializedSong } from './song-io.js';

// The slice of the Storage API we use (localStorage satisfies it structurally;
// a test can pass a tiny in-memory stand-in).
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

const INDEX_KEY = 'shaderwave:songs:index';
const BODY_PREFIX = 'shaderwave:song:';
const DEFAULT_COLOR = '#7d8aa0';

function defaultBackend(): KVStore | null {
  try {
    // `localStorage` access can throw in sandboxed/privacy contexts — guard it.
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class SongStore {
  private store: KVStore | null;

  constructor(store: KVStore | null = defaultBackend()) {
    this.store = store;
  }

  // Is persistence usable at all? (false in sandboxed contexts / when storage is off.)
  available(): boolean { return !!this.store; }

  // A short, collision-resistant id for a new user song.
  createId(): string {
    return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // The saved-song index, newest first. Tolerates a missing/corrupt index (→ []).
  list(): UserSongMeta[] {
    if (!this.store) return [];
    let arr: unknown;
    try { arr = JSON.parse(this.store.getItem(INDEX_KEY) || '[]'); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out = arr.filter((m): m is UserSongMeta =>
      !!m && typeof m === 'object' && typeof (m as UserSongMeta).id === 'string');
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  has(id: string): boolean { return this.list().some((m) => m.id === id); }

  // Load + validate one song body. Returns null if absent or unparseable (and, if
  // the index still references a now-missing body, prunes that stale entry).
  load(id: string): SerializedSong | null {
    if (!this.store) return null;
    const raw = this.store.getItem(BODY_PREFIX + id);
    if (raw == null) { this._removeFromIndex(id); return null; }
    try {
      return deserializeSong(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  // Write a song body + upsert its index entry. createdAt is preserved across
  // re-saves; updatedAt is bumped. Quota/again-throwing failures are caught and
  // reported (and the half-written body rolled back) rather than thrown.
  save(id: string, doc: SerializedSong): SaveResult {
    if (!this.store) return { ok: false, error: 'Storage is unavailable.' };
    const bodyKey = BODY_PREFIX + id;
    const hadBody = this.store.getItem(bodyKey);
    try {
      this.store.setItem(bodyKey, JSON.stringify(doc));
      const index = this.list();
      const now = Date.now();
      const prev = index.find((m) => m.id === id);
      const meta: UserSongMeta = {
        id,
        name: doc.name || 'Untitled',
        color: doc.instruments?.[0]?.color || DEFAULT_COLOR,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      const next = index.filter((m) => m.id !== id);
      next.push(meta);
      this.store.setItem(INDEX_KEY, JSON.stringify(next));
      return { ok: true };
    } catch (err) {
      // Roll back so a quota failure can't leave an orphaned/partial body.
      try {
        if (hadBody == null) this.store.removeItem(bodyKey);
        else this.store.setItem(bodyKey, hadBody);
      } catch { /* nothing more we can do */ }
      const quota = err instanceof Error && /quota/i.test(err.name + err.message);
      return { ok: false, error: quota ? 'Out of browser storage space.' : 'Could not save the song.' };
    }
  }

  // Remove a song body + its index entry.
  delete(id: string): void {
    if (!this.store) return;
    try { this.store.removeItem(BODY_PREFIX + id); } catch { /* ignore */ }
    this._removeFromIndex(id);
  }

  private _removeFromIndex(id: string) {
    if (!this.store) return;
    const next = this.list().filter((m) => m.id !== id);
    try { this.store.setItem(INDEX_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
}
