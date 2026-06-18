// Regression: a note carrying the ARPEGGIO effect column (cmd 0x0) that triggers
// part-way through a render block must not poison the voice with NaN.
//
// The bug (found via "Slide Into My Pitches"): a sample-accurate note-on lands
// fxStart > blockStart for any row not aligned to a 512-frame boundary (i.e. almost
// every row — only row 0 at frame 0 escapes). In _modulateVoices the arpeggio then
// evaluated steps[Math.floor(t / FX_ARP_SEC) % 3] with t < 0 → floor(neg) % 3 == -1 →
// steps[-1] === undefined → Math.pow(2, NaN) → NaN freq. That NaN flowed into freqPrev
// and the phaseOff accumulator, so the rest of the note rendered as a permanent click.
// Fix: clamp seconds-since-effect-start at 0 in _modulateVoices. These tests drive the
// real engine.advance() and assert the GPU-facing freq/phaseOff stay finite.
import { test, assert } from './_harness.js';
import { Engine } from '../../src/tracker/engine.js';
import { Pattern } from '../../src/tracker/pattern.js';
import { BLOCK } from '../../src/constants.js';
import type { SongData } from '../../src/types.js';

const SR = 48000;
const FX_ARP = 0x0;     // arpeggio command (raw code, as the demo songs author it)
const FX_VIB = 0x4;     // vibrato — also reads seconds-since-start

// Play a one-pattern song and report, per block over its first two rows, whether the
// arpeggio voice (ch0) ever went non-finite, plus whether its note actually triggered
// mid-block (so we know the test exercised the bug path, not a block-aligned escape).
function run(notes: Array<[row: number, note: number, cmd: number, val: number]>) {
  const eng = new Engine(SR);
  const pat = new Pattern(8, 8);
  for (const [row, note, cmd, val] of notes) {
    pat.set(row, 0, note, 0, 1);
    pat.setFx(row, 0, cmd, val);
  }
  const song = { rowsPerBeat: 4, bpm: 120, order: [0], patterns: [pat] } as unknown as SongData;
  eng.loadSong(song); eng.bpm = 120; eng.play('song');
  const row = eng.samplesPerRow;                 // 6000 @ 48k/120/4 → rows land mid-block
  let bad = 0, triggers = 0, midBlockTrigger = false, lastOn = -1;
  const maxRow = Math.max(...notes.map((n) => n[0]));
  const blocks = Math.ceil((maxRow + 2) * row / BLOCK) + 2;   // advance past the last note's row
  for (let b = 0; b < blocks; b++) {
    const vd = eng.advance(b * BLOCK);
    const f = vd.freq[0], ph = vd.phaseOff[0];
    if (!Number.isFinite(f) || !Number.isFinite(ph)) bad++;
    // Count each distinct note-on by its onFrame (a retrigger on a held voice keeps it
    // active, so an inactive→active edge would miss the second note).
    const on = eng.voices[0].onFrame;
    if (vd.active[0] && on !== lastOn) { triggers++; lastOn = on; if (on % BLOCK !== 0) midBlockTrigger = true; }
  }
  return { bad, triggers, midBlockTrigger };
}

// Single arpeggiated note on row 1 (frame 6000 → 368 into block 11, a mid-block trigger).
test('arpeggio note triggering mid-block stays finite (no NaN freq/phaseOff)', () => {
  const r = run([[1, 60, FX_ARP, 0x37]]);
  assert(r.midBlockTrigger, 'test setup: the arp note must trigger mid-block to exercise the bug');
  assert(r.bad === 0, `arp voice went non-finite on ${r.bad} block(s) — the negative-t NaN regressed`);
});

// The "Slide Into My Pitches" shape: a first arp note on the block-aligned row 0 (the
// case that always worked) followed by a second arp note on a mid-block row — the one
// that used to NaN and click for the rest of the pattern.
test('second arpeggiated note (mid-block) does not NaN after a clean first note', () => {
  const r = run([[0, 57, FX_ARP, 0x37], [4, 60, FX_ARP, 0x47]]);
  assert(r.triggers >= 2, `expected both notes to trigger, saw ${r.triggers}`);
  assert(r.bad === 0, `arp voice went non-finite on ${r.bad} block(s) — the second-note click regressed`);
});

// Vibrato also reads seconds-since-start; clamping must keep it finite too.
test('vibrato note triggering mid-block stays finite', () => {
  const r = run([[1, 60, FX_VIB, 0x83]]);
  assert(r.bad === 0, `vibrato voice went non-finite on ${r.bad} block(s)`);
});
