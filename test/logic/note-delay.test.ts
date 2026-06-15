// Note-trigger delay effect (FX_NOTE_DELAY = 0x5) — for swing / humanized "drunken"
// timing. A note on a cell carrying this command is pushed later WITHIN ITS OWN STEP
// by val/255 of one row: 0x00 fires on the beat, 0x80 ≈ half a step, 0xFF ≈ a full
// step. Unlike the slide/vibrato effects this is a SCHEDULER effect — the trigger
// frame is moved later (possibly into a later render block), and the voice keeps
// playing its previous note until the deferred trigger fires. These tests drive the
// real engine.advance() row clock and watch when the voice actually attacks.
import { test, assert, assertEq } from './_harness.js';
import { Engine } from '../../src/tracker/engine.js';
import { Pattern } from '../../src/tracker/pattern.js';
import { FX_NOTE_DELAY } from '../../src/tracker/fx.js';
import { BLOCK, noteToFreq } from '../../src/constants.js';
import type { SongData } from '../../src/types.js';

const SR = 48000;

// The engine's exact frame math: val/255 of one row, capped a hair under a full row.
function expectedDelay(val: number, row: number) {
  return Math.min(Math.round((val / 255) * row), Math.max(0, Math.round(row) - 1));
}

// Run a one-pattern song with a delayed note at row 0; the next note (row 4) is far
// away and must NOT affect the delay (the delay is one step, not the note interval).
// Returns the per-row sample count and the frame/freq at which ch0 first attacks.
function runDelay(delayVal: number) {
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  pat.set(0, 0, 60, 0, 1);                       // C4 at row 0 …
  pat.setFx(0, 0, FX_NOTE_DELAY, delayVal);      // … delayed within its step
  pat.set(4, 0, 62, 0, 1);                       // a later note — irrelevant to the delay
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  const row = eng.samplesPerRow;                 // 6000 @ 48k/120/4
  let firstFrame = -1, firstFreq = -1;
  const blocks = Math.ceil((2 * row) / BLOCK);
  for (let b = 0; b < blocks; b++) {
    eng.advance(b * BLOCK);
    if (eng.voices[0].active) { firstFrame = eng.voices[0].onFrame; firstFreq = eng.voices[0].freq; break; }
  }
  return { row, firstFrame, firstFreq };
}

test('note delay 0x00 triggers immediately on its row', () => {
  const { firstFrame, firstFreq } = runDelay(0x00);
  assertEq(firstFrame, 0, '0x00 fires at the row frame (0)');
  assert(Math.abs(firstFreq - noteToFreq(60)) < 1e-3, 'it is the cell\'s own note (C4)');
});

test('note delay 0x80 triggers half a step late (independent of the next note)', () => {
  const { row, firstFrame, firstFreq } = runDelay(0x80);
  assertEq(firstFrame, expectedDelay(0x80, row), '0x80 fires at ~half of ONE row');
  assert(firstFrame > row * 0.45 && firstFrame < row * 0.55, `frame ${firstFrame} is mid-step of ${row}, not mid-song`);
  assert(Math.abs(firstFreq - noteToFreq(60)) < 1e-3, 'still the delayed note (C4)');
});

test('note delay 0xFF triggers nearly a full step late (capped under one row)', () => {
  const { row, firstFrame } = runDelay(0xff);
  assertEq(firstFrame, expectedDelay(0xff, row), '0xFF lands one sample under a full row');
  assertEq(firstFrame, Math.round(row) - 1, 'i.e. row − 1, always < one step');
});

test('delayed note is NOT triggered on its own row (deferred, not immediate)', () => {
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  pat.set(0, 0, 60, 0, 1); pat.setFx(0, 0, FX_NOTE_DELAY, 0x80);
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
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  const row = eng.samplesPerRow;
  const bDelay = 2 * row + expectedDelay(0x80, row);   // B fires here (row 2 + half a step)

  // Probe just after row 2 but before B's deferred trigger.
  const probe = 2 * row + Math.round(row * 0.25);
  assert(probe < bDelay, 'probe is before the delayed trigger');
  for (let f = 0; f <= probe; f += BLOCK) eng.advance(f);
  assert(eng.voices[0].active, 'voice is playing in the gap');
  assert(Math.abs(eng.voices[0].freq - noteToFreq(50)) < 1e-3, 'STILL note A — the gap was not silenced');

  // Run past B's trigger and confirm it became note B.
  const blocks = Math.ceil((bDelay + 2 * BLOCK) / BLOCK);
  for (let b = 0; b < blocks; b++) eng.advance(b * BLOCK);
  assert(Math.abs(eng.voices[0].freq - noteToFreq(60)) < 1e-3, 'after the deferred trigger it is note B');
});
