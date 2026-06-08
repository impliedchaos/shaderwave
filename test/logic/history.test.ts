// Undo/redo history semantics. The History stores opaque snapshots (it never
// inspects their fields), so we use tiny tagged stand-ins cast to the snapshot
// type — this isolates the stack logic from serialization.
import { test, assert, assertEq } from './_harness.js';
import { History } from '../../src/tracker/history.js';
import type { SerializedSong } from '../../src/tracker/song-io.js';

// A labelled stand-in snapshot.
const S = (id: string) => ({ id } as unknown as SerializedSong);
const id = (s: SerializedSong | null) => (s as unknown as { id: string } | null)?.id ?? null;

test('history: nothing to undo/redo at the baseline', () => {
  const h = new History();
  h.reset(S('a'));
  assert(!h.canUndo(), 'no undo at baseline');
  assert(!h.canRedo(), 'no redo at baseline');
  assertEq(id(h.undo()), null, 'undo returns null at baseline');
});

test('history: push then undo restores the PRE-edit state', () => {
  const h = new History();
  h.reset(S('a'));          // baseline (present = a)
  h.push(S('b'));           // edit → present = b, a is the undo step
  assert(h.canUndo(), 'can undo after a push');
  assertEq(id(h.undo()), 'a', 'undo returns the pre-edit snapshot');
  assert(h.canRedo(), 'can redo after an undo');
  assert(!h.canUndo(), 'no further undo (back at baseline)');
});

test('history: redo replays the undone edit; a new push clears redo', () => {
  const h = new History();
  h.reset(S('a'));
  h.push(S('b'));
  h.push(S('c'));           // a → [a,b] past, present = c
  assertEq(id(h.undo()), 'b', 'undo 1 → b');
  assertEq(id(h.undo()), 'a', 'undo 2 → a');
  assertEq(id(h.redo()), 'b', 'redo 1 → b');
  h.push(S('d'));           // new edit while redo (c) was pending → redo cleared
  assert(!h.canRedo(), 'a fresh push clears the redo stack');
  assertEq(id(h.undo()), 'b', 'undo after the new push → b');
});

test('history: replacePresent folds a gesture into one step (no new undo)', () => {
  const h = new History();
  h.reset(S('a'));
  h.push(S('b1'));          // gesture starts: a is the undo baseline
  h.replacePresent(S('b2'));
  h.replacePresent(S('b3')); // still one gesture
  assertEq(id(h.undo()), 'a', 'undo jumps past the whole coalesced gesture');
  assert(!h.canUndo(), 'the gesture was a single step');
});

test('history: reset clears both stacks', () => {
  const h = new History();
  h.reset(S('a'));
  h.push(S('b'));
  h.undo();                 // b now in redo
  h.reset(S('x'));          // load a different document
  assert(!h.canUndo() && !h.canRedo(), 'reset wipes undo + redo');
});

test('history: stack is bounded by the limit (oldest dropped)', () => {
  const h = new History(3);
  h.reset(S('0'));
  for (let i = 1; i <= 6; i++) h.push(S(String(i)));   // far past the cap
  // present = 6; undo as far as possible and confirm it never exceeds the cap.
  let steps = 0;
  while (h.canUndo()) { h.undo(); steps++; }
  assertEq(steps, 3, 'no more than `limit` undo steps are retained');
});
