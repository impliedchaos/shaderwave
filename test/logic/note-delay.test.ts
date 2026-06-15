// Note-trigger delay effect (FX_NOTE_DELAY = 0x5). A note on a cell carrying this
// command is deferred toward the NEXT note on its channel by val/255 of that
// interval: 0x00 fires on the row, 0x80 ≈ halfway, 0xFF ≈ just before the next note.
// Unlike the slide/vibrato effects this is a SCHEDULER effect — the trigger frame is
// pushed later (possibly into a later render block), and the voice keeps playing its
// previous note until the deferred trigger fires. These tests drive the real
// engine.advance() row clock and watch when the voice actually attacks.
import { test, assert, assertEq } from './_harness.js';
import { Engine } from '../../src/tracker/engine.js';
import { Pattern } from '../../src/tracker/pattern.js';
import { FX_NOTE_DELAY } from '../../src/tracker/fx.js';
import { BLOCK, noteToFreq } from '../../src/constants.js';
import type { SongData } from '../../src/types.js';

const SR = 48000;

// Run a one-pattern song with a delayed note at row 0 and the next note at row 4.
// Returns the interval, the per-row sample count, and the frame/freq at which ch0
// first attacks (= where the delayed note actually fires).
function runDelay(delayVal: number) {
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  pat.set(0, 0, 60, 0, 1);                       // C4 at row 0 …
  pat.setFx(0, 0, FX_NOTE_DELAY, delayVal);      // … but delayed
  pat.set(4, 0, 62, 0, 1);                       // next note at row 4 (the reference)
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  const spr = eng.samplesPerRow;                 // 6000 @ 48k/120/4
  const interval = 4 * spr;                       // rows 0→4
  let firstFrame = -1, firstFreq = -1;
  const blocks = Math.ceil((5 * spr) / BLOCK);
  for (let b = 0; b < blocks; b++) {
    eng.advance(b * BLOCK);
    if (eng.voices[0].active) { firstFrame = eng.voices[0].onFrame; firstFreq = eng.voices[0].freq; break; }
  }
  return { spr, interval, firstFrame, firstFreq };
}

// The engine's exact frame math for a delay value over a given interval.
function expectedDelay(val: number, interval: number) {
  return Math.min(Math.round((val / 255) * interval), Math.max(0, Math.round(interval) - 1));
}

test('note delay 0x00 triggers immediately on its row', () => {
  const { firstFrame, firstFreq } = runDelay(0x00);
  assertEq(firstFrame, 0, '0x00 fires at the row frame (0)');
  assert(Math.abs(firstFreq - noteToFreq(60)) < 1e-3, 'it is the delayed cell\'s own note (C4)');
});

test('note delay 0x80 triggers ~halfway to the next note', () => {
  const { interval, firstFrame, firstFreq } = runDelay(0x80);
  assertEq(firstFrame, expectedDelay(0x80, interval), '0x80 fires at ~half the inter-note interval');
  assert(firstFrame > interval * 0.45 && firstFrame < interval * 0.55, `frame ${firstFrame} sits near the midpoint of ${interval}`);
  assert(Math.abs(firstFreq - noteToFreq(60)) < 1e-3, 'still the delayed note (C4)');
});

test('note delay 0xFF schedules one sample before the next note (then the next note wins)', () => {
  // 0xFF lands at interval−1, i.e. the SAME block as the next note, which retriggers
  // the voice — so the delayed note is effectively swallowed ("delayed until the next
  // note"). That 1-sample trigger can't be observed after the block, so check the
  // scheduled (pending) frame directly right after the row fires.
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  pat.set(0, 0, 60, 0, 1); pat.setFx(0, 0, FX_NOTE_DELAY, 0xff);
  pat.set(4, 0, 62, 0, 1);
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  const interval = 4 * eng.samplesPerRow;
  eng.advance(0);                                 // row 0 fires → pushes the deferred trigger
  assertEq(eng._pending.length, 1, 'the delayed note is queued, not played on its row');
  assertEq(eng._pending[0].frame, Math.round(interval) - 1, '0xFF scheduled at interval − 1');
});

test('delayed note is NOT triggered on its own row (deferred, not immediate)', () => {
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  pat.set(0, 0, 60, 0, 1); pat.setFx(0, 0, FX_NOTE_DELAY, 0x80);
  pat.set(4, 0, 62, 0, 1);
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  eng.advance(0);                                 // covers frame 0 (row 0 fires here)
  assert(!eng.voices[0].active, 'channel 0 stays silent on row 0 — the note was deferred');
});

test('the previous note sustains through the gap until the delayed note fires', () => {
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  pat.set(0, 0, 50, 0, 1);                        // note A (no fx) — plays on row 0
  pat.set(2, 0, 60, 0, 1); pat.setFx(2, 0, FX_NOTE_DELAY, 0x80);   // delayed note B at row 2
  pat.set(6, 0, 62, 0, 1);                        // next note C at row 6 (B's reference)
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  const spr = eng.samplesPerRow;
  const bDelay = 2 * spr + expectedDelay(0x80, 4 * spr);   // B fires here (row2 + half of rows 2→6)

  // Probe mid-gap: well after row 2's frame but before B's deferred trigger.
  const probe = 2 * spr + spr;                    // one row past row 2
  assert(probe < bDelay, 'probe is before the delayed trigger');
  for (let f = 0; f <= probe; f += BLOCK) eng.advance(f);
  assert(eng.voices[0].active, 'voice is playing in the gap');
  assert(Math.abs(eng.voices[0].freq - noteToFreq(50)) < 1e-3, 'it is STILL note A — the gap was not silenced');

  // Now run past B's trigger and confirm it became note B.
  const blocks = Math.ceil((bDelay + 2 * BLOCK) / BLOCK);
  for (let b = 0; b < blocks; b++) eng.advance(b * BLOCK);
  assert(Math.abs(eng.voices[0].freq - noteToFreq(60)) < 1e-3, 'after the deferred trigger it is note B');
});
