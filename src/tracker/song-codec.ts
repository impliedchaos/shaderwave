// Compact binary song codec + permalink encoding. Sits BENEATH the object model in
// song-io.ts: serializeSong/deserializeSong still map runtime ⇄ the SerializedSong
// object; this module only turns that object into bytes and back.
//
// Container ("SWB1") = a JSON *skeleton* (the SerializedSong with its heavy, regular
// arrays removed) followed by those arrays as raw typed-array *blobs*. The bulk data
// (pattern note/automation arrays + sample PCM) is 60–90% of a song and becomes raw
// bytes (no per-number JSON text, no base64); the small/irregular metadata (fx, mod,
// lfos, names) stays JSON, so adding an fx field never touches this codec.
//
//   ['SWB1' : 4]  [u32 skeletonLen]  [skeleton JSON]  [u32 blobCount]
//   [u32 × blobCount : blob byte lengths]  [blobs…]
//
// Blobs are pulled/reattached in ONE fixed traversal (patterns in order → notes, inst,
// vol, fxCmd, fxVal, then each autoTrack's data; then instruments in order → sample
// pcm), so the skeleton needs no indices and the dtype is known by position.
//
// Little-endian byte order is assumed (every browser; matches the existing base64 Int16
// sample encoding in serializeSample). decodeSongBytes() sniffs the input so legacy
// gzipped-JSON (IndexedDB bodies) and raw .shaderwave.json files keep loading.
import { deserializeSong } from './song-io.js';
import type { SerializedSong } from './song-io.js';

const MAGIC = 'SWB1';
const te = new TextEncoder();
const td = new TextDecoder();
const CAN_GZIP = typeof CompressionStream !== 'undefined';
// Share-URL length ceiling. The hash is never sent to a server (it's a fragment) and
// modern browsers handle very long URLs, so this only needs to fence off multi-MB
// sampler songs (whose PCM blows any reasonable link); rich pattern-only songs fit.
const URL_MAX = 64000;

// ── gzip (lifted here so song-store can share it) ───────────────────────────────
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!CAN_GZIP) return bytes;
  const buf = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(buf);
}
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(buf);
}

// ── base64 helpers (chunked so large PCM doesn't blow the call stack) ────────────
function bytesToBin(u8: Uint8Array): string {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  return bin;
}
function binToBytes(bin: string): Uint8Array {
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function b64urlEncode(u8: Uint8Array): string {
  return btoa(bytesToBin(u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Uint8Array {
  return binToBytes(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
}

// Typed-array views must be aligned, and blob slices land at arbitrary byte offsets;
// `.slice()` copies into a fresh 0-aligned buffer, so these are always safe.
function toI16(u8: Uint8Array): number[] { return Array.from(new Int16Array(u8.slice().buffer)); }
function toF32(u8: Uint8Array): number[] { return Array.from(new Float32Array(u8.slice().buffer)); }

// ── binary container ─────────────────────────────────────────────────────────────
export function encodeSongBinary(doc: SerializedSong): Uint8Array {
  const blobs: Uint8Array[] = [];
  const i16 = (a: number[] | undefined) => blobs.push(new Uint8Array(Int16Array.from(a ?? []).buffer));
  const f32 = (a: number[] | undefined) => blobs.push(new Uint8Array(Float32Array.from(a ?? []).buffer));

  // Skeleton: rebuild without the heavy arrays (no deep-clone of the big PCM/arrays).
  const sk: any = {
    ...doc,
    patterns: doc.patterns.map((p) => ({
      rows: p.rows, channels: p.channels,
      autoTracks: p.autoTracks.map((a) => ({ scope: a.scope, instIdx: a.instIdx, paramId: a.paramId })),
    })),
    instruments: doc.instruments.map((i) => i.sample
      ? { ...i, sample: { name: i.sample.name, rootNote: i.sample.rootNote, loopStart: i.sample.loopStart, loopEnd: i.sample.loopEnd, loopMode: i.sample.loopMode, sr: i.sample.sr } }
      : i),
  };

  for (const p of doc.patterns) {
    i16(p.notes); i16(p.inst); f32(p.vol); i16(p.fxCmd); i16(p.fxVal);
    for (const a of p.autoTracks) i16(a.data);
  }
  for (const inst of doc.instruments) {
    if (inst.sample) blobs.push(binToBytes(atob(inst.sample.pcm)));   // raw Int16 bytes, no base64 bloat
  }

  const skBytes = te.encode(JSON.stringify(sk));
  const headerLen = 4 + 4 + skBytes.length + 4 + 4 * blobs.length;
  const total = headerLen + blobs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(te.encode(MAGIC), 0);
  dv.setUint32(4, skBytes.length, true);
  out.set(skBytes, 8);
  let off = 8 + skBytes.length;
  dv.setUint32(off, blobs.length, true); off += 4;
  for (const b of blobs) { dv.setUint32(off, b.length, true); off += 4; }
  for (const b of blobs) { out.set(b, off); off += b.length; }
  return out;
}

export function decodeSongBinary(bytes: Uint8Array): SerializedSong {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const skLen = dv.getUint32(4, true);
  const sk = JSON.parse(td.decode(bytes.subarray(8, 8 + skLen))) as SerializedSong;
  let off = 8 + skLen;
  const blobCount = dv.getUint32(off, true); off += 4;
  const lens: number[] = [];
  for (let i = 0; i < blobCount; i++) { lens.push(dv.getUint32(off, true)); off += 4; }
  let bi = 0, boff = off;
  const next = (): Uint8Array => { const len = lens[bi++]; const s = bytes.subarray(boff, boff + len); boff += len; return s; };

  for (const p of sk.patterns) {
    (p as any).notes = toI16(next()); (p as any).inst = toI16(next()); (p as any).vol = toF32(next());
    (p as any).fxCmd = toI16(next()); (p as any).fxVal = toI16(next());
    for (const a of p.autoTracks) (a as any).data = toI16(next());
  }
  for (const inst of sk.instruments) {
    if (inst.sample) (inst.sample as any).pcm = btoa(bytesToBin(next()));
  }
  return sk;
}

// ── universal decode: sniff gzip → SWB1 binary → legacy JSON; then validate/migrate ─
export async function decodeSongBytes(bytes: Uint8Array): Promise<SerializedSong> {
  let b = bytes;
  if (b[0] === 0x1f && b[1] === 0x8b) b = await gunzip(b);                       // gzip member
  const obj = (b[0] === 0x53 && b[1] === 0x57 && b[2] === 0x42 && b[3] === 0x31) // 'SWB1'
    ? decodeSongBinary(b)
    : JSON.parse(td.decode(b));
  return deserializeSong(obj);
}

// gzip(binary) — the body written to files and IndexedDB.
export async function encodeSongGz(doc: SerializedSong): Promise<Uint8Array> {
  return gzip(encodeSongBinary(doc));
}

// ── shared share-payload codec (used by both permalinks and gist bodies) ─────────
// A single base64url string of gzip(binary): URL-safe, line-safe (no '#'), so it
// drops into a URL hash or after a '#'-commented gist header alike.
export async function songToPayload(doc: SerializedSong): Promise<string> {
  return b64urlEncode(await encodeSongGz(doc));
}
export async function payloadToSong(payload: string): Promise<SerializedSong> {
  return decodeSongBytes(b64urlDecode(payload.trim()));
}

// ── permalinks ──────────────────────────────────────────────────────────────────
export async function buildShareUrl(doc: SerializedSong): Promise<{ url: string; tooBig: boolean }> {
  const url = location.origin + location.pathname + '#s=' + await songToPayload(doc);
  return { url, tooBig: url.length > URL_MAX };
}

export async function decodeShareHash(): Promise<SerializedSong | null> {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return null;
  try { return await payloadToSong(m[1]); }
  catch (e) { console.warn('Could not load shared song from URL:', e); return null; }
}
