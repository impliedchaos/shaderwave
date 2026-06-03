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
```

Then click **▶ Play**. The `dist/` output is plain static files — host it anywhere
(GitHub Pages, S3, nginx…). No special headers are needed: audio is delivered to the
AudioWorklet via `postMessage` (no `SharedArrayBuffer`), so no cross-origin-isolation
(`COOP`/`COEP`) headers are required. The build uses a relative `base`, so it works
served from a domain root or a subpath.

### Controls

| Key                         | Action                                                        |
| --------------------------- | ------------------------------------------------------------- |
| **Z–M** / **S,D,G,H,J**    | Piano keys — write a note to the cursor cell & preview        |
| **Arrows**                  | Move cursor; **←/→** step note → instrument → volume columns  |
| **0–9**                     | On the instrument / volume column, set that field (2-digit)   |
| **Shift+↑/↓**              | Nudge the note's volume ±5%                                   |
| **PageUp/Dn**, **Home/End** | Page / jump the cursor; **mouse wheel** scrolls the grid      |
| **Click+drag**              | Select a block of cells                                       |
| **Ctrl/⌘+C/X/V**           | Copy / cut / paste the selected block (or cursor cell)        |
| **Del**                     | Clear cell                                                    |
| **=**                       | Note-off                                                      |
| **Space**                   | Play / Stop                                                   |
| **[ / ]**                   | Octave down / up                                              |

The transport bar's **LEN** field sets the current pattern's row count.

### Instruments & the instrument table

The sidebar lists an **instrument table** — instances you play from. Each note in a
pattern references one. Use **+ Add** to add another instance of any engine type
(e.g. a second 303 with a different cutoff, or three DX7s on different patches);
right-click an instance to remove it. Each instance has its own color so duplicates
are distinguishable in the grid. Pick an instance and tweak its parameters in the
sidebar; a song shows only the instruments it uses.

## Instruments

### 303 — Acid Bass

Saw/square oscillator through a 4-pole nonlinear ladder filter with downward
envelope sweep and accent. Parameters: **Cutoff**, **Reso**, **EnvMod**,
**Accent**, **Wave** (saw/square), **FiltDecay**, **AmpDecay**.

### 808 — Drum Machine

Analytical drum synthesis — swept-sine kick/toms, sine+noise snare, metallic
hi-hats, clap, cowbell. Parameters: **Tone**, **Decay**, **Snappy**.

### Moog — Analog Polysynth

3 detuned saw oscillators into a ladder filter with separate filter & amp
ADSRs. Parameters: **Cutoff**, **Reso**, **EnvAmt**, **Detune**, **AmpSus**,
**FiltDecay**, **AmpDecay**.

### DX7 — FM Synthesizer

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

Each instrument ships with curated presets selectable from a dropdown in the
sidebar. Presets set both the synth parameters and recommended effects settings
(distortion, delay, reverb, chorus, etc.). Loading a demo song also syncs the
full UI to the song's instrument/effect state.

## Effects Chain

A second shader stage runs between the synth mix and the audio readback. All
effects are editable from the **Master FX** panel.

```
input → Distortion → Chorus → Tremolo → Delay → Reverb → Width → Master Out
```

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

### Stereo Width

Mid/side stereo width control. Values > 1.0 widen; < 1.0 narrow toward mono.

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
3. **Effects pass** → distortion, chorus, tremolo, delay, reverb, width.
4. **Readback** (`readPixels`) → interleaved stereo `Float32Array` → ring buffer.

The recursive ladder filter (303, Moog) can't be parallelised trivially, so each
output sample recomputes its voice's filter from the block start using carried-in
state. It's O(N²) per block but trivial for the GPU at `BLOCK=512`. The clean O(N)
optimisation is a checkpoint/scan — noted for later.

## Layout

```
index.html                 app shell, tracker grid, sidebar controls (Vite entry)
vite.config.js             build config (relative base, worklet emitted as a file)
public/                    static assets copied verbatim (favicon, sysex banks)
src/constants.js           shared sizes, note→freq, ring layout
src/main.js                app init, song loading, UI sync
src/gl/                    context, program helpers, SynthRenderer, shaders/
  shaders/*.glsl             raw GLSL, imported as strings via Vite's ?raw
  shaders/synth-303.glsl       acid bass synth
  shaders/synth-808.glsl       drum machine
  shaders/synth-moog.glsl      analog polysynth
  shaders/synth-dx7.glsl       6-op FM (all 32 algorithms)
  shaders/fx-output.glsl       distortion, chorus, tremolo, width, master
  shaders/fx-delay-update.glsl stereo delay ring
  shaders/fx-fdn-update.glsl   FDN reverb
  shaders/mix.glsl             voice mixdown
  shaders/common.glsl          shared ADSR, noise, filter utilities (the prelude)
src/gl/effects.js          effects chain orchestration
src/audio/                 worklet.js (classic script), pipeline.js
src/tracker/               pattern, song (+ demo songs), engine (BPM clock)
src/ui/                    tracker-view (canvas grid), controls (sidebar + SysEx loader)
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
- O(N²) ladder recompute — replace with a checkpoint scan if profiling demands it.
- DX7 envelope is simplified ADSR; full rate/level 4-stage envelope not yet
  implemented.
