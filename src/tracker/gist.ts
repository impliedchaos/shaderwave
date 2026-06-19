// Durable song sharing via secret GitHub Gists — fully serverless (GitHub Pages-
// friendly): writes use the PUBLISHER's own Personal Access Token; reads are
// anonymous off the gist CDN. See MEMORY.md / ROADMAP.md for the why (and why OAuth
// Device Flow is a dead end — no CORS at github.com).
//
// A published gist is one text file: a human-readable '#'-commented header followed
// by the song as a single base64url payload line (same payload the #s= permalink
// uses — see songToPayload/payloadToSong). The base64url alphabet has no '#', so the
// loader splits header from payload by simply dropping leading '#'/blank lines.
//
// SECURITY: the PAT is the user's OWN classic token scoped to `gist` ONLY (a leak can
// touch only their gists, nothing else). It lives in localStorage — same XSS exposure
// as any same-origin store; we never eval/innerHTML gist content, only base64/binary-
// decode it, so a hostile gist yields at worst a malformed song (caught), not code.
import { songToPayload, payloadToSong } from './song-codec.js';
import type { SerializedSong } from './song-io.js';

const API = 'https://api.github.com/gists';
const TOKEN_KEY = 'shaderwave-gist-token';
export const TOKEN_PAGE = 'https://github.com/settings/tokens/new?scopes=gist&description=ShaderWave';
const FILENAME = 'song.shaderwave';
const MAX_PAYLOAD = 900_000;   // gist content is ~1 MB-practical; fence off huge sampler songs

// ── token (localStorage; try/catch for private mode, like theme.ts) ──────────────
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string): void {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode — fine */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode — fine */ }
}

export interface GistMeta { version: string; name: string; author?: string }

// Build the '#'-commented header. `loadUrl` is filled on the second (PATCH) pass once
// the gist id exists; omitted on the initial create. (Exported for the test harness.)
export function buildGistHeader(meta: GistMeta, loadUrl?: string): string {
  const lines = [`# ShaderWave v${meta.version}`, `# Song: ${meta.name || 'Untitled'}`];
  if (meta.author) lines.push(`# By: ${meta.author}`);
  if (loadUrl) lines.push(`# Open ▶ ${loadUrl}`);
  return lines.join('\n') + '\n';
}

// Strip the header: the payload is the first non-'#', non-blank line.
export function stripGistHeader(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return '';
}

function loadUrlFor(id: string): string {
  return location.origin + location.pathname + '#gist=' + id;
}

// ── write (authenticated) ────────────────────────────────────────────────────────
export class GistError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function api(method: string, url: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'GitHub rejected the token (is it a classic token with the "gist" scope?).'
      : res.status === 403 ? 'GitHub refused the request (rate limit or token permissions).'
      : `GitHub returned ${res.status}.`;
    throw new GistError(msg, res.status);
  }
  return res.json();
}

// Publish a song as a NEW secret gist. Two calls: create (to learn the id), then PATCH
// to inject the now-known one-click "Open" link into the header. Returns the load URL.
export async function publishGist(doc: SerializedSong, meta: GistMeta, token: string): Promise<string> {
  const payload = await songToPayload(doc);
  if (payload.length > MAX_PAYLOAD) {
    throw new GistError('This song is too big to publish to a gist (large sample). Save it to a file and share that instead.');
  }
  const description = `ShaderWave song: ${meta.name || 'Untitled'}`;
  const created = await api('POST', API, token, {
    public: false,                                  // secret: unlisted, link-readable
    description,
    files: { [FILENAME]: { content: buildGistHeader(meta) + payload } },
  });
  const id: string = created.id;
  const loadUrl = loadUrlFor(id);
  // Backfill the deep-load link now that we have the id. Non-fatal if it fails — the
  // gist already loads; it just wouldn't carry the clickable link in its header.
  try {
    await api('PATCH', `${API}/${id}`, token, {
      files: { [FILENAME]: { content: buildGistHeader(meta, loadUrl) + payload } },
    });
  } catch (e) { console.warn('Gist published but header backfill failed:', e); }
  return loadUrl;
}

// ── read (anonymous) ──────────────────────────────────────────────────────────────
async function fetchGistPayload(id: string): Promise<string> {
  // One anonymous discovery GET (counts against the 60/hr unauth limit); the raw file
  // is then fetched from the gist CDN, which doesn't.
  const res = await fetch(`${API}/${id}`, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) throw new GistError(`Couldn't fetch the gist (${res.status}).`, res.status);
  const meta = await res.json();
  const file: any = Object.values(meta.files || {})[0];
  if (!file) throw new GistError('Gist has no files.');
  const text: string = file.truncated && file.raw_url ? await (await fetch(file.raw_url)).text() : file.content;
  return stripGistHeader(text);
}

// #gist=<id> → song (transient). Returns null (and logs) on any failure.
export async function decodeGistHash(): Promise<SerializedSong | null> {
  const m = location.hash.match(/^#gist=([0-9a-fA-F]+)$/);
  if (!m) return null;
  try { return await payloadToSong(await fetchGistPayload(m[1])); }
  catch (e) { console.warn('Could not load shared gist:', e); return null; }
}
