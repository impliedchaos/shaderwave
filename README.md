# ShaderWave — WebGL2 Synthesizer & Tracker

A classic-style music tracker whose instruments are synthesized **entirely on the
GPU**. Every audio sample is computed in a fragment shader, read back to the CPU,
and streamed to the audio device through a lock-free ring buffer.

## Run

Any ordinary static webserver works — no special headers, no build step. Serve the
project root and open it in a WebGL2 browser, then click **▶ Play**. For example:

```bash
python3 -m http.server 8080      # → http://localhost:8080
# or:  npx serve .   ·   node server.js   ·   any static host (GitHub Pages, S3, nginx…)
```

`server.js` is included as a convenience but is **not** required: audio is delivered
to the AudioWorklet via `postMessage` (no `SharedArrayBuffer`), so the page needs no
cross-origin-isolation (`COOP`/`COEP`) headers.

- **Z–M / S,D,G,H,J** — piano keys (writes to the cursor cell + previews)
- **Arrows** — move cursor · **Del** — clear cell · **=** — note-off · **Space** — play/stop
- Pick an instrument and tweak its parameters in the sidebar.

## How it works

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
3. **Readback** (`readPixels`) → interleaved stereo `Float32Array` → ring buffer.

### Synths (`src/gl/shaders/`)
- **303** — saw/square + 4-pole nonlinear ladder filter, downward env sweep, accent.
- **808** — analytical drums (swept-sine kick/toms, sine+noise snare, metallic hats, clap, cowbell).
- **Moog** — 3 detuned saws → ladder, separate filter & amp ADSRs.
- **DX7** — 4-operator FM, 3 selectable algorithms, feedback.

### Effects chain (`src/gl/effects.js`, `fx-*` shaders)
A second shader stage runs between the synth mix and the audio readback:
**drive → stereo feedback delay → FDN reverb → mid/side width**, all editable from
the *Master FX* panel. Delay and reverb keep history in persistent ping-pong "ring"
textures. Because every delay length is kept ≥ `BLOCK`, the feedback taps always
read settled history, so each block stays fully parallel — no per-sample loop.
- **Delay** — one stereo ring (`w[n] = x[n] + fb·w[n-D]`), ~2.7s max.
- **Reverb** — 4-line FDN with a Householder feedback matrix + damping lowpass.

The recursive ladder filter (303, Moog) can't be parallelised trivially, so each
output sample recomputes its voice's filter from the block start using carried-in
state. It's O(N²) per block but trivial for the GPU at `BLOCK=512`. The clean O(N)
optimisation is a checkpoint/scan — noted for later.

## Layout
```
server.js                  dev server (COOP/COEP, MIME)
src/constants.js           shared sizes, note→freq, ring layout
src/gl/                    context, program helpers, SynthRenderer, shaders/
src/audio/                 worklet.js (classic script), pipeline.js
src/tracker/               pattern, song (+ demo), engine (BPM clock)
src/ui/                    tracker-view (canvas grid), controls (sidebar)
test/                      headless GLSL / render / audio harnesses
```

## Tests (headless Chrome + SwiftShader)
```bash
# shaders compile & link
google-chrome --headless=new --enable-unsafe-swiftshader --dump-dom \
  http://localhost:8080/test/glsl-check.html
# full GPU render path produces finite signal:  test/render-check.html
# live audio ring/worklet drains with no underruns:  test/audio-check.html
```

## Known limitations / next steps
- Oscillator phase is derived from time-since-note-on; very long notes (>tens of
  minutes) will drift. Fix: carry phase in the state texture like the filter.
- Song is a single looping pattern; multi-pattern song order is modelled but has no
  editor UI.
- O(N²) ladder recompute — replace with a checkpoint scan if profiling demands it.
```
