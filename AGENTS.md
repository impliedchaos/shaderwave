# AGENTS.md — ShaderWave

A WebGL2 music tracker whose instruments are synthesized **entirely on the GPU**:
every audio sample is computed in a fragment shader, read back to the CPU, and
streamed to the audio device. Pure front-end, no backend, no framework — vanilla
ES modules bundled by Vite.

For the deep architecture, instrument/effect descriptions, and the file-by-file
layout, read **`README.md`** (kept current) and **`design.md`**. This file is the
quick operational guide + the non-obvious gotchas.

## Commands

```bash
npm install
npm run dev        # Vite dev server + HMR → http://localhost:5173
npm run build      # production bundle → dist/  (also the fastest "does it compile" check)
npm run preview    # serve the built bundle
```

There is **no unit-test framework**. Verification is done two ways:

1. **`npm run build`** — catches JS/import errors fast. Note it does **not** compile
   GLSL (shaders compile on the GPU at runtime), so a green build ≠ working shaders.
2. **Headless harnesses** in `test/*.html` — plain ES-module pages run under headless
   Chrome + SwiftShader. They set `document.title` to `ALL_OK` / `DONE` on pass,
   `FAILED` / `ERROR` on failure. Serve with the dev server, then:
   ```bash
   (npx vite --port 5173 &) ; sleep 4
   google-chrome --headless=new --disable-gpu --enable-unsafe-swiftshader \
     --virtual-time-budget=10000 --dump-dom http://localhost:5173/test/glsl-check.html
   # read the <title> and the #out <pre> from the dumped DOM
   ```
   Key harnesses: `glsl-check` (all shaders compile/link), `render-check` (full GPU
   path produces finite, non-NaN audio), `instance-check`, `onset-check`,
   `drum-analyze`. `audio-check` needs a real audio device and won't pass headless.
   **SwiftShader is software-rendered, so it validates correctness, NOT performance.**

### Running project logic under plain Node

Shaders are imported as strings via Vite's `?raw` (e.g. `import X from './x.glsl?raw'`).
Plain `node` chokes on any module that transitively imports a `.glsl` file. To run
engine/song/automation logic headlessly, **bundle first with esbuild**:

```bash
npx esbuild your-check.mjs --bundle --format=esm --loader:.glsl=text \
  --outfile=/tmp/run.mjs && node /tmp/run.mjs
```

`pure` modules (e.g. `src/tracker/automation.js`, `src/audio/pipeline.js`) import
nothing GLSL and run under node directly. **Always `rm` temp test files when done
and `git status` before committing** so they don't get swept into a commit.

## Architecture in one breath

- **GPU audio**: per render block (`BLOCK = 512` samples) each instrument renders a
  `BLOCK × VOICES` texture (one fragment = one sample of one voice), MRT also carries
  recursive filter state across blocks. Mixed → effects passes → `readPixels` →
  AudioWorklet queue. See `src/gl/synth-renderer.js`.
- **Tracker ↔ voices**: channel index == voice index (8 channels, 8 voices, mono per
  channel). `src/tracker/engine.js` schedules sample-accurate note triggers; the
  producer feeds the worklet strictly contiguous blocks (`src/audio/pipeline.js`),
  so under CPU load you get silent underruns, never skipped/dropped blocks.
- **Instruments**: 4 engine types in `src/constants.js` `INSTRUMENTS = ['303','dx7','808','moog']`.
  A song's `params` is a table of *instances* (e.g. three separate 303s); a pattern
  cell's `inst` indexes that table. Each engine: `303` & `moog` use a recursive ladder
  (per-sample loop); `dx7` & `808` are closed-form.
- **Param banks** (per voice, `vec4` each): `uP0`/`uP1` for all engines; **Moog adds
  `uP2`/`uP3` + `uFreqFrom`**, declared in `common.glsl` / the moog shader and uploaded
  **only for moog** in the renderer (guarded like the dx7 op uniforms). `p.u('name')`
  returns null for absent uniforms → `gl.uniform*` is a silent no-op.
- **Effects** are per *engine type* (`fxParams['303']` etc.), shared by all instances/
  channels of that type — they operate on the summed instrument output.
- **Automation** (`src/tracker/automation.js`): per-cell effect commands. Each cell
  stores a `ParamTarget` id (`fxCmd`) + a normalized value byte 0–255 (`fxVal`). The
  byte is the universal currency (storage, 2-hex display, future MIDI CC). Three scopes:
  `inst` writes the live per-voice slot (channel-local); `fx` writes the shared
  `fxParams` (track-wide for that engine); `chan` writes a per-channel mix param
  (currently `PAN`, engine-agnostic so it's offered on every channel). Applied per row
  in `engine._applyAutomation`, after note triggers, so a command on a note's row
  overrides the note's snapshot.
- **Pan** is per channel (channel index == voice index). `engine.channelPan[]` is the
  base the header slider sets and a song persists via `data().pan` (read in `loadSong`);
  `engine.panAuto[]` holds a transient `chan`-automation override (cleared on play/stop).
  Both feed `vd.pan[]` each block — the mix shader (`mix.glsl`) already does equal-power
  pan from `uPan`, so the whole audio path is stereo end-to-end.

## Conventions & gotchas

- **Match surrounding style.** Comment density, naming, and idiom vary by file; mirror
  the file you're in. Demo songs (`src/tracker/demo-songs.js`) build patterns with small
  local helper closures in each song's `data()` — follow that pattern.
- **The recursive ladder is rendered in strips** (`synth-renderer.js` `this.subBlock`,
  default 64) to avoid O(BLOCK²) recompute. Any change there must keep output
  **bit-identical** — verify by A/B rendering `subBlock = BLOCK` (old single-pass) vs
  `64` and confirming `maxDiff ≈ 0`.
- **Noise hashing**: in `common.glsl`, the noise multiplier must not be a short-period
  rational. `1/π` is fatal (≈135 Hz buzz); use Dave Hoskins' `0.1031`. (See memory.)
- **Automation value precision**: endpoints are 8-bit, so e.g. 844 Hz on a log curve may
  land a few Hz off — that's expected quantization, not a bug. Use
  `normByte(target, realValue)` (from `automation.js`) when authoring exact-ish endpoints.
- **One fx command per cell.** Can't put two automation targets on the same `(row, ch)`.
  Put different targets on different channels/rows. `fx`-scope automation must sit on a
  cell whose channel has a *live voice of that engine type* (else `_channelType` resolves
  the wrong engine); `fx` changes persist until re-set, so reset them or use a
  self-returning ramp.
- **Presets** live in `src/ui/presets.js` (keyed by engine type). Preset matching compares
  `p0`/`p1` only; `loadPreset` applies `p2`/`p3` for moog (defaulting to classic when
  absent). DX7 patches come from SysEx ROMs, not presets.
- **Adding/removing a demo song**: edit the `DEMO_SONGS` array in `demo-songs.js`. Default
  song is "Antiseptik USA" (`src/main.js`); songs are referenced by name/dynamic index, so
  removal is safe. Verify all songs still `loadSongInstruments` after edits.

## Git

- Branch only if asked; the user directs commits/pushes explicitly.
- End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- The remote prints a jokey server-hook banner on push — it's not an error.
