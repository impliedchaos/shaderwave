# AGENTS.md — ShaderWave

A WebGL2 music tracker whose instruments are synthesized **entirely on the GPU**:
every audio sample is computed in a fragment shader, read back to the CPU, and
streamed to the audio device. Pure front-end, no backend, no framework — TypeScript
modules bundled by Vite.

For the deep architecture, instrument/effect descriptions, and the file-by-file
layout, read **`README.md`** (kept current) and **`design.md`**. This file is the
quick operational guide + the non-obvious gotchas. **To create songs** (demo tracks
or loadable files) read **`COMPOSING.md`** — a self-contained authoring guide (the
`SongDef`/`Pattern` API, per-engine param banks, automation/LFO codes, gotchas) so
you don't have to read the engine source; keep it current as instruments/effects grow.

## Memory

**`MEMORY.md`** (repo root) is the canonical, version-controlled agent memory. **Read it
at the start of every session** and keep it updated as you learn non-obvious facts —
gotchas, the *why* behind decisions, user feedback on how to work, ongoing-work status.
Prefer it over any per-user "scratch" memory (e.g. files under
`~/.claude/projects/*/memory/`): those are not shared with the team and are now retired
in favour of `MEMORY.md`. Don't record what the code or git history already makes
obvious.

## Commands

```bash
npm install
npm run dev        # Vite dev server + HMR → http://localhost:5173
npm run build      # production bundle → dist/  (also the fastest "does it compile" check)
npm run preview    # serve the built bundle
npm run deploy     # build and deploy to the remote server
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
npx esbuild your-check.ts --bundle --format=esm --loader:.glsl=text \
  --outfile=/tmp/run.mjs && node /tmp/run.mjs
```

`pure` modules (e.g. `src/tracker/automation.ts`, `src/audio/pipeline.ts`) import
nothing GLSL and run under node directly using `npx tsx`. **Always `rm` temp test files when done
and `git status` before committing** so they don't get swept into a commit.

## Architecture in one breath

- **GPU audio**: per render block (`BLOCK = 512` samples) each instrument renders a
  `BLOCK × VOICES` texture (one fragment = one sample of one voice), MRT also carries
  recursive filter state across blocks. Mixed → effects passes → `readPixels` →
  AudioWorklet queue. See `src/gl/synth-renderer.ts`.
- **Tracker ↔ voices**: channel index == voice index (8 channels, 8 voices, mono per
  channel). `src/tracker/engine.ts` schedules sample-accurate note triggers; the
  producer feeds the worklet strictly contiguous blocks (`src/audio/pipeline.ts`),
  so under CPU load you get silent underruns, never skipped/dropped blocks.
- **Instruments**: a **registry** of engine descriptors in `src/instruments/` (one file
  per engine — `i303`, `idx7`, `i808`, `imoog`, `itanpura`, `ie8e`, `igroove`, `itabla`,
  `ipipi`, `iguitar` — listed in `index.ts`'s `REGISTRY`). `constants.ts` re-exports `INSTRUMENTS` from it; every per-engine table
  (param defs, presets, automation targets, defaults, help) derives from the descriptor.
  **Adding an engine = one descriptor + one `.glsl` + one `REGISTRY` line** (append at the
  end — automation target ids are persisted). A song's `params` is a table of *instances*
  (e.g. three separate 303s); a pattern cell's `inst` indexes that table. Each engine:
  `303` & `moog` use a recursive ladder (per-sample loop, `recursive: true`); `dx7`, `808`
  & `tanpura` are closed-form. See MEMORY.md for the full plug-in notes.
- **Param banks** (per voice, `vec4` each): `uP0`/`uP1`/`uP2`/`uP3` + `uFreqFrom` are
  **universal** — declared in `common.glsl` and uploaded for *every* engine (shaders that
  don't reference one strip the uniform → `p.u()` returns null → `gl.uniform*` is a silent
  no-op). So a new engine gets 16 param floats with zero new plumbing. DX7's 6-operator
  banks (`uOpA–D`) stay engine-specific, uploaded via the descriptor's `uploadVoiceUniforms`
  hook.
- **Effects**: the chain is a data-driven registry (`FX_EFFECTS` in `src/gl/effects.ts`)
  — each effect is an `FxEffectDef` (params + shader(s) + `init(gl)` → process closure);
  `EffectsChain` is a generic runner; `defaultFxParams()`/order derive from it. Adding an
  effect = one descriptor (+ `.glsl`), like the instrument registry. The chains run **per
  INSTRUMENT instance**: each instance owns its `fx` (`InstrumentInstance.fx`) AND a chain
  (`SynthRenderer.instFx[k]`, lazily built, keyed by instance index). Voices route to their
  instance's chain via `vd.instId[v]`; voices of one instance (e.g. a chord across channels)
  sum into ONE chain (no reverb multiplication), and two instances of the same engine can
  sound completely different. The app feeds per-instance params via `renderer.setInstrumentFx
  (instruments.map(i => i.fx))`; fx-scope automation and presets write `instance.fx`. Demos
  author fx per engine TYPE (`SongDef.fxParams`); `loadSongInstruments` clones it onto each
  instance. Saved songs store fx per instrument (song format v2; v1 per-type is migrated).
- **Effect column** (per-cell note articulations — slides/vibrato/arp/volume-slide, distinct
  from automation tracks): `Pattern.fxCmd`/`fxVal`, command set in `src/tracker/fx.ts`,
  modulated per render block in `engine._modulateVoices` (`3xx`+note is the no-retrigger
  meend). Smooth pitch only on the phase-accumulating engines (303, moog). See MEMORY.md.
- **Automation** (`src/tracker/automation.ts` + `Pattern.autoTracks`): dedicated
  per-pattern **tracks**, each sequencing one `ParamTarget` over the rows as an
  `Int16Array` (`-1` = hold, `0–255` = a normalized value byte — the universal
  currency for storage, 2-hex display, and MIDI-CC recording). `pattern.getOrCreate
  AutoTrack(instIdx, paramId)` derives scope from the param (single source of truth).
  Four scopes: `inst` targets an instrument *instance* — instance-wide, applied to
  live voices and merged on note-on via `autoLive` (never the pristine base params;
  reset on play/stop); `fx` writes the engine type's shared `fxParams` (track-wide,
  resolved from the targeted instance's type); `chan` writes a per-channel mix param
  (`PAN`; `targetInstIdx` is reused as the channel index); `global` is song-wide
  (`BPM`, `VOL`→`vd.master`). Applied per row in `engine._applyAutomation`, after note
  triggers. `targetInstIdx` is remapped wherever instruments shift (`loadSongInstruments`
  prune, `removeInstrument`). `autoTracks` is a parallel structure — every path that
  copies/remaps a pattern handles it (clone, `resize`, copy/paste).
- **Pan** is per channel (channel index == voice index). `engine.channelPan[]` is the
  base the header slider sets and a song persists via `data().pan` (read in `loadSong`);
  `engine.panAuto[]` holds a transient `chan`-automation override (cleared on play/stop).
  Both feed `vd.pan[]` each block — the mix shader (`mix.glsl`) does equal-power pan
  from `uPan`, so the whole audio path is stereo end-to-end. **Reverb decode must keep
  both stereo taps zero-sum** (`fx-fdn-tap.glsl`) or the mono reverb send leaks into one
  channel (was a +4.6 dB right bias).
- **Global volume** is `vd.master` — the render-level output gain, baked into the audio
  (so it affects recordings), default `DEFAULT_MASTER` (`constants.ts`). Per-song
  (`SongData.master`, applied in `loadSong`; absent → default, so New Song resets it).
  Base lives in `engine.songMaster`, restored on play/stop; `engine.setMaster()` is the
  Song Editor knob's setter. Distinct from the monitor-only playback slider
  (`pipeline.setVolume`, post-analyser so it's not in exports). The `VOL` target's `max`
  is derived (`DEFAULT_MASTER*255/128`) so automation byte `0x80` == the default.

## Conventions & gotchas

- **Match surrounding style.** Comment density, naming, and idiom vary by file; mirror
  the file you're in. Demo songs (`src/tracker/demo-songs.ts`) build patterns with small
  local helper closures in each song's `data()` — follow that pattern.
- **The recursive ladder is rendered in strips** (`synth-renderer.ts` `this.subBlock`,
  default 64) to avoid O(BLOCK²) recompute. Any change there must keep output
  **bit-identical** — verify by A/B rendering `subBlock = BLOCK` (old single-pass) vs
  `64` and confirming `maxDiff ≈ 0`.
- **Noise hashing**: in `common.glsl`, the noise multiplier must not be a short-period
  rational. `1/π` is fatal (≈135 Hz buzz); use Dave Hoskins' `0.1031`. (See memory.)
- **Automation value precision**: endpoints are 8-bit, so e.g. 844 Hz on a log curve may
  land a few Hz off — that's expected quantization, not a bug. Use
  `normByte(target, realValue)` (from `automation.ts`) when authoring exact-ish endpoints.
- **One track per target.** A track is keyed by `(scope, targetInstIdx, paramId)`;
  `getOrCreateAutoTrack` dedupes on that. `fx`-scope changes persist until re-set, so
  reset them or use a self-returning ramp. `inst`-scope is instance-*wide* (every channel
  playing that instance moves together) — distinct from the old per-channel FX model.
- **Demo-song automation targets an instrument *index*, not a channel.** A common past
  bug: passing a channel number to `getOrCreateAutoTrack('inst', …)`. Out-of-range indices
  are now ignored by `loadSongInstruments` (no crash), but the value still won't land —
  pass the instrument the channel actually plays.
- **Presets** live in `src/ui/presets.ts` (keyed by engine type). Preset matching compares
  `p0`/`p1` only; `loadPreset` applies `p2`/`p3` for moog (defaulting to classic when
  absent). DX7 patches come from SysEx ROMs, not presets.
- **Adding/removing a demo song**: edit the `DEMO_SONGS` array in `demo-songs.ts` (see
  **`COMPOSING.md`** for the full authoring guide — `SongDef`/`Pattern` API, param banks,
  automation/LFO codes). Default song is "Antiseptik USA" (`src/main.ts`); songs are referenced
  by name/dynamic index, so removal is safe. Verify all songs still `loadSongInstruments` after edits.

## Git

- Branch only if asked; the user directs commits/pushes explicitly.
- End commit messages with:
  `Co-Authored-By: ` and then the name of the agent and model it's using.
- Before pushing, increment the patch version in `package.json`. If it's a larger change increment the minor version, and if there are breaking changes, increment the major version. **Adding a demo song is only a patch bump** (it's content, not an engine change) — don't bump the minor version for it.
- The remote prints a jokey server-hook banner on push — it's not an error.
