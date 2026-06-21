// Help / shortcuts overlay. Content mirrors the README (keyboard controls,
// instruments, effects chain) plus a few things only the code knows (channel
// mute, select-all, right-click remove). Built lazily on first open and toggled
// with the ❔ button or the "?" key; Escape closes it.

const KEYBOARD = [
  ['Z – M', 'Piano keys (with S D G H J) — write a note at the cursor and preview it'],
  ['Q – O', 'Piano keys one octave up (2 3 5 6 7 9 black notes; I closes the octave on C)'],
  ['[  /  ]', 'Octave down / up'],
  ['Arrows', 'Move the cursor around the grid'],
  ['← / →', 'Step through the note → instrument → volume → effect sub-columns'],
  ['0 – 9', 'On the instrument / volume sub-column, type the value (two digits)'],
  ['0–5 · A', 'On the effect sub-column, pick a command, then type its 2-hex value'],
  ['Shift + ↑ / ↓', 'Nudge volume ±5% — the current note, or every note in the selection'],
  ['Ctrl / ⌘ + ↑ / ↓', 'Transpose ±1 semitone — the current note, or all selected (pitched instruments only)'],
  ['=', 'Write a note-off (release)'],
  ['Del / Backspace', 'Clear the cell — or the whole selection'],
  ['PageUp / PageDn', 'Page the cursor up / down'],
  ['Home / End', 'Jump to the first / last row'],
  ['Ctrl / ⌘ + A', 'Select the whole pattern'],
  ['Ctrl / ⌘ + C / X / V', 'Copy / cut / paste the selection (or cursor cell)'],
  ['Ctrl / ⌘ + L', 'Interpolate (ramp) values across a box-selection (automation tracks, or volume/FX columns)'],
  ['Esc', 'Clear the selection · close this dialog'],
  ['Space', 'Play / stop'],
];

const MOUSE = [
  ['Click + drag', 'Select a rectangular block of cells'],
  ['Shift + Click', 'Box-select from the previous cursor position to the clicked cell'],
  ['Mouse wheel', 'Scroll the pattern grid'],
  ['Click a channel header', 'Mute / unmute that channel (CH 1–8)'],
  ['Drag a knob up / down', 'Adjust a parameter — release snaps the preset list'],
  ['Right-click an instrument', 'Remove that instance from the table'],
];

// Instrument list comes straight from the registry (label + blurb per engine),
// so a newly-crafted instrument documents itself here automatically.
const INSTRUMENTS = REGISTRY.map((d) => [d.label, d.blurb]);

// Per-cell effect-column commands (derived from the command registry). Pitch
// effects are now click-free on every pitched engine (closed-form ones follow the
// change via the uPhaseOff correction); volume slide works on any. Slide into a
// note with 3 for a meend; 4 gives vibrato (gamak).
const PATTERN_FX = FX_CMDS.map((c) => [c.code.toString(16).toUpperCase(), c.label]);

const EFFECTS = [
  ['Distortion', 'Boss DS-1 style diode hard-clip — Dist, Tone, Level'],
  ['Overdrive', 'Ibanez TS9 Tube Screamer — bass-cut soft asymmetric clip + mid-hump — Drive, Tone, Level'],
  ['Filter', 'Resonant state-variable filter (per-sample) — Cutoff, Reso, Mode (LP/HP/BP), Mix. The marquee LFO/automation sweep target.'],
  ['Equalizer', '3-band (low shelf / peaking mid / high shelf) via per-sample crossover filters — Low, Mid, High gains + Low/High crossover frequencies'],
  ['Pitch Shifter', 'Granular octave pedal / scale-aware harmonizer — Pitch (voice 1) + Mix (dry/wet) + three Harmony voices (Harm/H3/H4 interval + level, 0 = off). Set Key+Scale and intervals snap diatonically to the played note (a "+2" = a third in key; Scale=Off = raw semitones, ±12 = octave). Spread fans the harmony voices across the stereo field. Dry + up to 4 pitched voices = a chord. Mono lines track best, dense chords warble.'],
  ['Vocoder', 'Channel vocoder (per-sample, up to 16 bands): a modulator instance’s spectral envelope shapes the carrier. Source (modulator instance), Bands, Q, Attack, Release, Mix, Unvoiced (sibilance passthrough), Formant (±12 st, pitch-independent). Use a BRIGHT carrier (saw/pulse).'],
  ['Compressor', 'Per-sample envelope follower, stereo-linked — Thresh, Ratio, Attack, Release, Makeup, Source (sidechain instance)'],
  ['Chorus', 'Modulated stereo delay line — Mix, Rate, Depth'],
  ['Tremolo', 'Auto-pan amplitude modulation — Mix, Rate'],
  ['Delay', 'Stereo feedback delay, ~2.7 s max — Time, Feedback, Mix'],
  ['Reverb', '4-line FDN with Householder feedback + damping — Decay, Damp, Send, Mix'],
  ['Bitcrusher', 'Bit-depth + sample-rate decimation, with dry/wet — Bits, Hz, Mix'],
  ['Width', 'Mid/side stereo width — >1 widens, <1 narrows toward mono'],
  ['Limiter', 'Transparent brick-wall (per-sample, ∞ ratio) — Ceiling, Release. Defaults dead last.'],
  ['Reorder', 'Each FX category header has ▲▼ to move that effect earlier/later in the chain — per instrument instance (e.g. comp before reverb on a pad, after on drums).'],
];

const MODULATION = [
  ['Automation tracks', 'Per-pattern lanes sequencing one parameter over the rows (2-hex bytes). Add with the + Auto Track button; scope is inst / fx / channel / global.'],
  ['Global LFOs', 'Four song-wide LFO sources (Sine/Tri/Square/Saw/S&H/Ramp/Wavetable/Pump, tempo-synced or free Hz). LFOs 0–2 are general; LFO 3 defaults to the Pump. Set in the Song Editor.'],
  ['Pump (LFO 3)', 'The Pump shape is a one-sided downward ducking envelope — full duck on the beat, swelling back. Route it to instruments\' Level (via the matrix) to sidechain them to the beat; leave the kick unrouted. It always ducks down (ignores the ± toggle).'],
  ['Mod matrix', 'Routings aim a target at an LFO source, each with its own depth/polarity — so one LFO can drive many parameters. Add rows in the Song Editor.'],
];

const RECORDING = [
  ['Record button', 'Arms live recording and starts playback (song mode, unless something\'s already playing). Click again — or press Stop — to disarm; the icon glows red while armed.'],
  ['Recording notes', 'While armed and playing, keyboard / MIDI notes land at the playhead on the cursor\'s channel (move the cursor to choose the channel) — the edit cursor stays put. Stopped, it\'s normal step-entry at the cursor.'],
  ['Recording automation', 'While armed, turning a parameter knob (or moving a MIDI CC) writes to that parameter\'s automation track at the playhead, creating the track if needed. The existing track is suppressed while you hold the knob so it can\'t fight you, and the value latches into every row you sweep over.'],
];

const STYLE = `
  #help-overlay { display: none; position: fixed; inset: 0; z-index: 1000;
    background: rgba(3, 5, 8, 0.9); align-items: center; justify-content: center;
    font-family: var(--font-ui); }
  #help-panel { background: var(--panel-solid); border: 2px solid var(--accent);
    box-shadow: 0 0 30px var(--accent-glow); border-radius: 12px;
    width: min(760px, 92vw); max-height: 86vh; display: flex; flex-direction: column; }
  #help-panel header { display: flex; align-items: center; justify-content: space-between;
    padding: 18px 24px; border-bottom: 1px solid var(--panel-border); }
  #help-panel header h2 { margin: 0; color: #fff; font-size: 18px; font-weight: 800;
    letter-spacing: 2px; text-transform: uppercase; font-family: var(--font-heading); }
  #help-body { padding: 8px 24px 24px; overflow-y: auto; }
  #help-body h3 { color: var(--accent); font-size: 12px; letter-spacing: 2px;
    text-transform: uppercase; font-family: var(--font-heading); margin: 22px 0 10px; }
  .help-row { display: grid; grid-template-columns: 220px 1fr; gap: 14px; padding: 5px 0;
    align-items: baseline; font-size: 13px; color: var(--text); }
  .help-row .k { color: var(--dim); text-align: right; }
  .help-row .k kbd { display: inline-block; background: #030508;
    border: 1px solid rgba(45, 60, 85, 0.7); border-radius: 5px; padding: 1px 7px;
    margin: 1px 2px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #fff; }
  .help-row .name { color: var(--accent); font-weight: 700; }
  #help-foot { padding: 14px 24px; border-top: 1px solid var(--panel-border);
    font-size: 12px; color: var(--dim); }
`;

import { el } from './dom.js';
import { REGISTRY } from '../instruments/index.js';
import { FX_CMDS } from '../tracker/fx.js';

let overlay: HTMLElement | null = null;
let open = false;

// Split a shortcut label like "Ctrl / ⌘ + C" into <kbd> chips, leaving the
// separators (/ +) as plain text between them.
function keyChips(label: string) {
  const span = document.createElement('span');
  const parts = label.split(/(\s*[/+]\s*)/);
  for (const part of parts) {
    if (/^\s*[/+]\s*$/.test(part)) {
      span.appendChild(document.createTextNode(part));
    } else if (part.length) {
      const kbd = document.createElement('kbd');
      kbd.textContent = part.trim();
      span.appendChild(kbd);
    }
  }
  return span;
}

function rowList(pairs: string[][], keyFmt: string) {
  const frag = document.createDocumentFragment();
  for (const [left, right] of pairs) {
    const row = document.createElement('div');
    row.className = 'help-row';
    const k = document.createElement('div');
    k.className = 'k';
    if (keyFmt === 'kbd') k.appendChild(keyChips(left));
    else { k.classList.add('name'); k.textContent = left; }
    const v = document.createElement('div');
    v.textContent = right;
    row.appendChild(k);
    row.appendChild(v);
    frag.appendChild(row);
  }
  return frag;
}

function section(title: string, pairs: string[][], keyFmt: string) {
  const h = document.createElement('h3');
  h.textContent = title;
  const body = el('help-body');
  body.appendChild(h);
  body.appendChild(rowList(pairs, keyFmt));
}

function build() {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.innerHTML = `
    <div id="help-panel" role="dialog" aria-label="Help and keyboard shortcuts">
      <header>
        <h2>ShaderWave · Help</h2>
        <button id="help-close" style="border-color: var(--panel-border); color: var(--dim);">Close</button>
      </header>
      <div id="help-body"></div>
      <div id="help-foot">A GPU-synthesized tracker — every sample is computed in a fragment shader. Press <kbd style="background:#030508;border:1px solid rgba(45,60,85,0.7);border-radius:5px;padding:1px 7px;font-family:'JetBrains Mono',monospace;color:#fff;">?</kbd> any time to reopen this.</div>
    </div>`;
  document.body.appendChild(overlay);

  section('Keyboard', KEYBOARD, 'kbd');
  section('Mouse', MOUSE, 'kbd');
  section('Instruments', INSTRUMENTS, 'name');
  section('Effect column  ·  per-cell command + 2-hex value', PATTERN_FX, 'kbd');
  section('Effects chain (reorderable per instrument)  ·  Comp → Filter → EQ → Pitch → Vocoder → OD → Dist → Chorus → Tremolo → Delay → Reverb → Bitcrush → Width → Limiter', EFFECTS, 'name');
  section('Modulation', MODULATION, 'name');
  section('Recording', RECORDING, 'name');

  // Backdrop click (outside the panel) and the Close button both dismiss.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeHelp(); });
  el('help-close').onclick = closeHelp;
}

export function openHelp() {
  if (!overlay) build();
  overlay!.style.display = 'flex';
  open = true;
}

export function closeHelp() {
  if (overlay) overlay.style.display = 'none';
  open = false;
}

// Wire the ❔ button and the global "?" / Escape keys. The keydown listener runs
// in the capture phase so that, while the modal is open, it swallows keys before
// the tracker's note-entry handler can see them.
export function initHelp() {
  const btn = document.getElementById('help');
  if (btn) btn.onclick = openHelp;

  // Deep link: ShaderWave#help opens straight into this dialog.
  if (location.hash === '#help') openHelp();

  document.addEventListener('keydown', (e) => {
    if (open) {
      if (e.code === 'Escape') closeHelp();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === '?') { e.preventDefault(); openHelp(); }
  }, true);
}
