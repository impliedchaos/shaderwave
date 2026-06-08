// Undo/redo history — a stack of whole-document snapshots.
//
// The app serializes the entire editable document to a `SerializedSong` (the same
// object the Save button writes to a file), so we reuse that as the snapshot unit:
// undo/redo just restore a previously-captured snapshot via the normal load path.
// This keeps the history correct by construction (anything Save persists, undo
// restores) at the cost of holding N full copies in memory — bounded by `limit`.
//
// Coalescing: a streaming gesture (a knob *drag*, two-digit field entry) should be
// ONE undo step, not dozens. The app tags each `push` with a gesture string and may
// call `replacePresent` instead when continuing the same gesture within a short
// window — see App.markDirty.
import type { SerializedSong } from './song-io.js';

export class History {
  private past: SerializedSong[] = [];
  private future: SerializedSong[] = [];
  private present: SerializedSong | null = null;
  private limit: number;

  constructor(limit = 60) { this.limit = limit; }

  // Seed the baseline WITHOUT creating an undo step (song load / new / switch).
  reset(snapshot: SerializedSong) {
    this.present = snapshot;
    this.past.length = 0;
    this.future.length = 0;
  }

  // Record a new state: the previous present becomes an undo step, redo is cleared.
  // `markDirty` calls this AFTER the mutation, so `present` still holds the
  // pre-edit state and `snapshot` is the post-edit state.
  push(snapshot: SerializedSong) {
    if (this.present) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = snapshot;
    this.future.length = 0;
  }

  // Fold a continuing gesture into the current step (no new undo entry).
  replacePresent(snapshot: SerializedSong) {
    if (this.present === null) { this.push(snapshot); return; }
    this.present = snapshot;
    this.future.length = 0;
  }

  hasBaseline() { return this.present !== null; }
  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  // Step back one snapshot, returning the state to restore (or null if none).
  undo(): SerializedSong | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    if (this.present) this.future.push(this.present);
    this.present = prev;
    return prev;
  }

  // Step forward one snapshot, returning the state to restore (or null if none).
  redo(): SerializedSong | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    if (this.present) this.past.push(this.present);
    this.present = next;
    return next;
  }
}
