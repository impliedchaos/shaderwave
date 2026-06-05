# ShaderWave — WebGL2 Synthesizer & Tracker

A classic-style music tracker whose instruments are synthesized **entirely on the
GPU**. Every audio sample is computed in a fragment shader, read back to the CPU,
and streamed to the audio device through a lock-free ring buffer.

## Run

The project is built with [Vite](https://vite.dev). In a WebGL2 browser:

```bash
npm install
npm run dev        # dev server with HMR → http://localhost:5173
npm run build      # production bundle → dist/
npm run preview    # serve the production build locally
npm run deploy     # build and deploy to the remote server
```

Then click the **▶** (Play) button. The `dist/` output is plain static files — host it anywhere
(GitHub Pages, S3, nginx…). No special headers are needed: audio is delivered to the
AudioWorklet via `postMessage` (no `SharedArrayBuffer`), so no cross-origin-isolation
(`COOP`/`COEP`) headers are required. The build uses a relative `base`, so it works
served from a domain root or a subpath.

### Controls

| Key                         | Action                                                        |
| --------------------------- | ------------------------------------------------------------- |
| **Z–M** / **S,D,G,H,J**    | Piano keys — write a note to the cursor cell & preview        |
| **Arrows**                  | Move cursor; **←/→** step note → instrument → volume → fx columns |
| **0–9** / **A–F**          | Set the inst/volume field (2-digit); on the fx-value column, enter a hex byte |
| **Enter** (fx command col)  | Open the parameter-target picker for the cell                 |
| **F**                       | Show / hide the automation (FX) column                        |
| **Shift+↑/↓**              | Nudge the note's volume ±5% (or the fx value byte ±1)         |
| **PageUp/Dn**, **Home/End** | Page / jump the cursor; **mouse wheel** scrolls the grid      |
| **Click+drag**              | Select a block of cells                                       |
| **Ctrl/⌘+C/X/V**           | Copy / cut / paste the selected block (note + automation)        |
| **Del**                     | Clear cell (or the automation command, in the fx columns)     |
| **=**                       | Note-off                                                      |
| **Space**                   | Play / Stop                                                   |
| **[ / ]**                   | Octave down / up                                              |
| **Ctrl/⌘+A**               | Select the whole pattern                                      |
| **Click a channel header**  | Mute / unmute that channel (outside the pan slider)           |
| **Drag a header pan slider**| Pan that channel left / right (snaps to centre)               |
| **?**                       | Open the help / shortcuts dialog                              |

The transport bar's **LEN** field sets the current pattern's row count.

### Instruments & the instrument table

The sidebar lists an **instrument table** — instances you play from. Each note in a
pattern references one. Use **+ Add** to add another instance of any engine type
(e.g. a second 303 with a different cutoff, or three DX7s on different patches);
right-click an instance to remove it. Each instance has its own color so duplicates
are distinguishable in the grid. Pick an instance and tweak its parameters in the
sidebar; a song shows only the instruments it uses.

## Instruments

### 303 — Acid Bass (Roland TB-303)

Saw/square oscillator through a 4-pole nonlinear ladder filter with downward
envelope sweep and accent. Parameters: **Cutoff**, **Reso**, **EnvMod**,
**Accent**, **Wave** (saw/square), **FiltDecay**, **AmpDecay**.

Modded to also allow triangle/sine/noise oscillators.

### 808 — Drum Machine (Roland TR-808)

Analytical drum synthesis — swept-sine kick/toms, sine+noise snare, metallic
hi-hats, clap, cowbell. Parameters: **Tone**, **Decay**, **Snappy**.

### Moog — Minimoog Model D

A faithful Model D voice: three oscillators with independent **waveform**
(triangle / saw / square / wide + narrow pulse) and **octave range** (32′–2′),
mixed into a 4-pole transistor **ladder filter** with mixer overdrive,
self-oscillation, and the Model D's uncompensated low-end loss as resonance
climbs. Analog character comes from per-voice oscillator **drift** (a static
detune plus a slow wander) and **exponential (RC-curve) contours** for the
filter and amp envelopes. Also: **glide** (portamento), a **noise** source, and
filter **keyboard tracking**.

Parameters: **Cutoff**, **Reso**, **EnvAmt**, **KbdTrack**, **Detune**,
**AmpSus**, **FiltDecay**, **AmpDecay**, per-oscillator **Wave** and **Oct**,
**Glide**, and **Noise**. Glide and drift are computed analytically so
oscillator phase stays continuous across render blocks with no extra state.

### DX7 — FM Synthesizer (Yamaha DX7)

6-operator FM synthesis with all 32 DX7 algorithms, operator-level envelope
control (per-operator **Decay**, **Sustain**, **Release**), individual
**Coarse**, **Fine**, **Detune**, **Level**, and **Mode** (ratio / fixed-Hz)
parameters, and operator feedback.

Patches are loaded from **DX7 `.syx` SysEx files** (packed 32-voice banks).
A ROM selector in the sidebar lets you browse 9 banks (ROM 1A–4B + Bass)
containing 288 factory and community patches total. Selecting a patch
automatically configures all 6 operators, algorithm, and feedback from the
SysEx data.

## Presets

Each instrument ships with curated presets (defined in `src/ui/presets.ts`)
selectable from a dropdown in the sidebar. Presets set both the synth parameters
and recommended effects settings (distortion, delay, reverb, chorus, etc.).
Loading a demo song also syncs the full UI to the song's instrument/effect state.

## Effects Chain

A second shader stage runs between the synth mix and the audio readback. All
effects are editable from the **Instrument FX** panel.

```
input → Distortion → Chorus → Tremolo → Delay → Reverb → Bitcrusher → Width → Master Out
```

Each effect is its own GPU pass over a `BLOCK × 1` stereo buffer; the chain runs
in a data-driven order (`DEFAULT_FX_ORDER` in `src/gl/effects.ts`), so the signal
flow can be rearranged just by reordering that list. A terminal master pass
applies the output gain and additively accumulates each instrument's result.

### Distortion — Boss DS-1 Emulation

Modelled after the Boss DS-1 diode hard-clipping circuit:
- **Dist** — drive amount (gain into the clipping stage)
- **Tone** — post-clip tilt EQ (dark ↔ bright)
- **Level** — output volume

### Chorus

Stereo chorus via modulated delay line:
- **Mix** — wet/dry blend
- **Rate** — LFO speed (Hz)
- **Depth** — modulation depth (ms)

### Tremolo

Auto-pan amplitude modulation:
- **Mix** — effect depth
- **Rate** — LFO speed (Hz)

### Delay

Stereo feedback delay stored in a persistent ping-pong ring texture (~2.7 s max):
- **Time** — delay length (s)
- **Feedback** — regeneration amount
- **Mix** — wet/dry blend

### Reverb

4-line FDN (Feedback Delay Network) with a Householder feedback matrix and
per-line damping lowpass:
- **Decay** — tail length
- **Damp** — high-frequency absorption
- **Send** — input send level
- **Mix** — wet/dry blend

### Bitcrusher

8-bit/16-bit digital downsampler/decimator:
- **Bits** — bit depth reduction (1–16 bits)
- **Rate** — sample rate decimation factor in Hz (100–22000 Hz)

### Stereo Width

Mid/side stereo width control. Values > 1.0 widen; < 1.0 narrow toward mono.

## Automation (FX Column)

Each pattern cell can carry one **effect command** in an optional automation
column — a parameter *target* plus a value. Toggle the column with the **FX Col**
button or **F** (shown by default). A command reads as a short code + two hex
digits, e.g. `CUT·A4`.

- **Set the target** — on the command sub-column, press **Enter** (or start
  typing a code) to open a picker of every parameter the channel's instrument can
  automate; arrow + Enter to choose, or type the 2-letter code to filter.
- **Set the value** — on the value sub-column, type two hex digits (`00`–`FF`),
  or **Shift+↑/↓** to nudge. The byte maps across the parameter's real range
  (log-scaled for cutoffs, linear elsewhere).

Three scopes, distinguished by colour in the grid:

- **Instrument params** (cyan) — cutoff, resonance, FM mod index, … written to
  that channel's live voice slot, so the change is per-channel and resets on the
  next note. A column of CUT commands is the classic acid filter sweep.
- **Effect params** (amber) — distortion, delay/reverb mix, … written to the
  instrument's shared FX chain, so the change is track-wide for that engine type.
- **Channel params** (cyan) — currently **PAN**. Per-channel and engine-agnostic
  (offered on every channel); the value reads as `L../C/R..`. The channel header's
  pan slider sets the base (saved with the song); a pan command overrides it for
  the rest of playback and reverts on stop.

Commands apply per row during playback, right after the row's note triggers
(so a command sharing a cell with a note overrides the note's snapshot). The
sidebar knobs follow the automation live and revert to the stored base on stop.
The registry lives in `src/tracker/automation.ts`; the stored value is a single
normalised byte — the same currency intended for future **MIDI CC** mapping.
The demo songs *Dextroamphetamine Suppository* and *Where'd I Put My Keys?* use
it for 303 cutoff sweeps.

## How It Works

```
AudioWorklet (audio thread)  ◄── postMessage blocks ──  main thread producer
   drains its block queue,                                renders BLOCK frames on GPU
   pulls 128-frame quanta                                 readPixels → post to worklet
```

The producer keeps ~`PREBUFFER_BLOCKS` blocks queued ahead, estimating depth as
(posted − consumed) from the worklet's periodic reports. No `SharedArrayBuffer`.

Per render block the GPU runs:

1. **One synth pass per instrument** → an audio texture `BLOCK × VOICES` (one row
   per voice). MRT also writes recursive filter state, ping-ponged across blocks.
2. **Mix pass** → sums all voice rows with gain + equal-power pan into one stereo
   row (`BLOCK × 1`).
3. **Effects pass** → one pass per effect over a `BLOCK × 1` stereo buffer, run in
   a data-driven order (distortion → chorus → tremolo → delay → reverb →
   bitcrusher → width → master).
4. **Readback** (`readPixels`) → interleaved stereo `Float32Array` → ring buffer.

The recursive ladder filter (303, Moog) can't be parallelised trivially: each
output sample recomputes its voice's filter from a checkpoint using carried-in
state. To keep that from being an O(N²) recompute per block, the ladder is
rendered in strips of `subBlock` samples (default 64), each picking up from the
previous strip's saved state — O(N·subBlock), and bit-identical to the old
single-pass render. See `synth-renderer.ts`.

## Layout

```
index.html                 app shell, tracker grid, sidebar controls (Vite entry)
vite.config.js             build config (relative base, worklet emitted as a file)
public/                    static assets copied verbatim (favicon, sysex banks)
src/constants.ts           shared sizes, note→freq, ring layout
src/main.ts                app init, song loading, UI sync
src/gl/                    context, program helpers, SynthRenderer, shaders/
  shaders/*.glsl             raw GLSL, imported as strings via Vite's ?raw
  shaders/synth-303.glsl       acid bass synth
  shaders/synth-808.glsl       drum machine
  shaders/synth-moog.glsl      Minimoog Model D voice
  shaders/synth-dx7.glsl       6-op FM (all 32 algorithms)
  shaders/fx-distortion.glsl   DS-1 distortion stage
  shaders/fx-chorus-*.glsl     chorus ring update + tap
  shaders/fx-tremolo.glsl      auto-pan tremolo stage
  shaders/fx-delay-*.glsl      stereo delay ring update + tap
  shaders/fx-fdn-*.glsl        FDN reverb ring update + tap
  shaders/fx-bitcrush.glsl     bit-depth / sample-rate crush stage
  shaders/fx-width.glsl        mid/side stereo width stage
  shaders/fx-master.glsl       master gain + additive accumulate
  shaders/mix.glsl             voice mixdown
  shaders/common.glsl          shared ADSR, noise, filter utilities (the prelude)
src/gl/effects.ts          per-effect pass pipeline (data-driven chain order)
src/audio/                 worklet.ts (classic script), pipeline.ts
src/tracker/               pattern, song (+ demo songs), engine (BPM clock), automation (param-target registry)
src/ui/                    tracker-view (canvas grid), controls (sidebar + SysEx loader), presets (instrument preset bank)
public/sysex/DX7/          .syx patch banks (ROM 1A–4B, Bass)
test/                      headless GLSL / render / audio harnesses
```

## Tests (headless Chrome + SwiftShader)

The harnesses are plain ES-module pages — serve them with the dev server
(`npm run dev`) and load over `localhost:5173`:

```bash
# shaders compile & link
google-chrome --headless=new --enable-unsafe-swiftshader --dump-dom \
  http://localhost:5173/test/glsl-check.html
# full GPU render path produces finite signal:  test/render-check.html
# live audio ring/worklet drains with no underruns:  test/audio-check.html
# drum spectrum / autocorrelation vs reference:   test/drum-analyze.html
# two instances of one engine render differently:  test/instance-check.html
# a drum sounds identical on every trigger:         test/onset-check.html
```

## Known Limitations / Next Steps

- Oscillator phase is derived from time-since-note-on; very long notes (>tens of
  minutes) will drift. Fix: carry phase in the state texture like the filter.
- Song is a single looping pattern; multi-pattern song order is modelled but has no
  editor UI.
- DX7 envelope is simplified ADSR; full rate/level 4-stage envelope not yet
  implemented.
- MIDI input, with CC messages mapped onto automation targets (the stored value
  byte is already CC-ready) and live recording of CC moves into the fx column.
- Save/load functionality to export and import song data as JSON.
- Instrument editor for creating and editing instrument patches from scratch.
