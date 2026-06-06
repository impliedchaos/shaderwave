# MEMORY.md — ShaderWave agent memory

Durable, project-local notes for AI agents working on this repo. This file is the
**canonical memory** — read it at the start of a session and keep it updated as you
learn non-obvious facts. It is version-controlled, so prefer it over any per-user
scratch memory. Don't record what the code/git history already makes obvious; record
the *why*, the gotchas, and decisions that aren't derivable from the source.

Entry types: **project** (ongoing work/goals/constraints), **feedback** (how the user
wants you to work — include the why), **reference** (external pointers), **user**.

---

## How the user wants you to work

### Check if the dev server is already running — AND NEVER `pkill` IT — `feedback`
Before starting the Vite dev server (`npx vite --port 5173`) for headless harnesses or
anything else, **always check whether one is already running first**
(`curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/`, or `pgrep -af vite` /
`lsof -i:5173`) and reuse it. **NEVER kill vite** — not with `pkill -f vite`, not with
`pkill -f "vite --port 5173"` (that still nukes the user's own server when port 5173 was
already taken and theirs bound elsewhere, or vice-versa), not any pattern. This has
burned the user ~10 times and they are (rightly) furious about it.
- **Why:** the user runs their own long-lived dev server; killing it interrupts their work,
  and redundant launches piling up frustrated them.
- **How to apply:** (1) probe port 5173 first; if something answers, REUSE it and run the
  harness — do not launch your own. (2) If you must spawn one, run it on a *different*
  port (e.g. `--port 5199`) and, to stop it, kill **only the exact PID you captured**
  (`SERVER_PID=$!`), never a `pkill` pattern. (3) When in doubt, leave it running and move on.

### Don't run the headless harness for demo-song changes — `feedback`
For demo-song edits (`src/tracker/demo-songs.ts`), verify with **`npm run build` only** (fast
typecheck). Do NOT launch headless Chrome / `render-check` / `vinyl-analyze` etc. just to
check a song — the SwiftShader GPU render is **brutal on the user's laptop**, and they prefer
to audition songs themselves in their own browser.
- **Why:** headless render harnesses peg the user's machine; they're happy to listen/test.
- **How to apply:** song/content changes → `npm run build`, then hand off for the user to
  audition. Reserve `render-check`/headless runs for actual engine/shader changes where
  finite-output verification genuinely matters (and even then, keep it minimal).

---

## Current work

### Automation-tracks review + fix plan (`feature/automation-tracks`) — `project`
Gemini migrated per-cell `fxCmd`/`fxVal` automation to dedicated per-pattern
`AutoTrack[]`. Compiles clean, all 16 demo songs load. **Commit `fe40fc8` is only
scaffolding** (types + new `global` BPM/MST scope) and still drives the engine off old
`fxCmd`; the actual migration lives in the **uncommitted working tree** — that's where
the bugs are. Reviewed 2026-06-05; user will request the fix later (usage-limit gated).

**🔴 The fix that matters — inst-scope automation corrupts instrument base params:**
`src/tracker/engine.ts:462-463` `_applyAutomation` writes `instr.p0/instr.p1` (the
instance's BASE arrays) directly. `_writeParams` (engine.ts:243) snapshots note-on from
those same arrays, and nothing restores them — `stop()` clears `panAuto`/`autoLive` but
not base. Proven headlessly: a cutoff sweep moves instance cutoff 400→2999 and leaves it
there after `stop()`. Corrupts sidebar display, compounds across plays, hits every
channel using that instance.
**Fix:** write the override to `autoLive` (already cleared on `play()`, already read by
the sidebar at `main.ts:1017`) + live voices, and have `_writeParams` merge `autoLive` on
note-on. Do NOT touch `instr.p0/p1`. Mirrors the old self-healing model (old code wrote
transient `vd.p0`, re-snapshotted from pristine base). Infra already present; just remove
the base write.

**🟡 engine.ts:449-461** — Gemini's stream-of-consciousness comments ("Wait...", "Let's
assume...") committed verbatim; logic works but make them real comments or delete.

**🟢 minor:** `main.ts:281` stale "legacy FX column" comment (path gone);
`pattern.ts:13` comment `vol // 0.0..1.0 byte 0..255` is wrong (float 0..1) and ctor
default silently changed 1→0.8.

**Systemic demo-song bug (FIXED 2026-06-05):** when the inst-automation model moved
from per-cell/per-channel to per-instrument-instance, the demo songs were NOT updated —
`getOrCreateAutoTrack('inst', X, …)` kept passing the old **channel number** (or a `ch`
loop var) as `X`, which is now an **instrument index**. 6 songs were wonky (Gooner,
Where'd I Put My Keys?, Diabetic Foot, Dextroamphetamine, Feral Roomba, Tinnitus); an
out-of-range X (e.g. 4 in a 4-instrument song) made `loadSongInstruments` build an
`undefined` hole in `instruments[]`, which crashed `_openAutoTrackPicker` (the
"+ Auto Track dialog won't open" repro: Dextroamphetamine, pattern #1). Fixes:
1. `loadSongInstruments` now ignores out-of-range `targetInstIdx` (no hole; remaps to 0).
2. `pattern.getOrCreateAutoTrack(instIdx, paramId)` — dropped the explicit `scope` arg;
   scope is now DERIVED from the paramId via `targetById` (kills scope-desync bugs like
   Gooner's `MRV` fx-param passed as `'inst'`). All call sites updated (demo songs +
   main.ts MIDI).
3. Remapped every demo inst/fx track to the correct instrument instance. Note: inst-scope
   is instance-wide (affects all channels playing that instance), which cleanly collapsed
   the old per-channel pad-sweep loops (e.g. Diabetic's `for ch 0..3`) to one track.
Audit script (esbuild+node): for each song, flag inst/fx tracks whose `targetInstIdx` is
out-of-range or whose instrument type ≠ the param's `type`. Re-run if touching automation.

**`autoTracks` is a parallel pattern structure — every path that copies/remaps patterns
or instruments must handle it.** Bugs found where it was forgotten (all FIXED 2026-06-05):
`engine.removeInstrument` (didn't shift inst/fx `targetInstIdx` like it shifts `pat.inst`
cells → tracks retargeted the wrong instrument); arranger **Clone pattern** (copied
notes/inst/vol but not autoTracks → clone lost all automation); block copy/paste
(`_copyBlock`/`_pasteBlock` read out-of-bounds for track columns and paste `break`'d at
the channel boundary → automation excluded; now handled positionally like the Delete
key, ClipCell gained an optional `auto` field). Paths already correct: `pattern.resize`,
`loadSongInstruments` prune/remap. (Also fixed: cut/paste never called `view.draw()`.)
When adding fields to Pattern, grep for every `new Pattern`, `.notes.set`, and
instrument-index remap and confirm the new field is handled.

After fixing, suggest squashing into one coherent commit so `fe40fc8` isn't left
half-migrated. Verify with `npm run build` and the esbuild+node song-load loop
(`loadSongInstruments(s)` over `DEMO_SONGS` — pass the song object, NOT `s.data()`;
`params` is a sibling of `data()`). Good parts to keep: new `fx` apply uses targeted
`instr.type` (cleaner than old `_channelType`); global/chan/inst all wired in picker;
song.ts prune/remap + pattern.resize() handle tracks.

### Review of Gemini's MIDI + phase-drift + DX7-envelope work — `project`
Reviewed 2026-06-05 (commits `84d9fd1` dx7 envelope, `8bcc3be` phase drift + MIDI).
Build + `glsl-check` + `render-check` all green.

- **DX7 native envelope (`84d9fd1`): correct, ship-ready.** `env4`/`envPre4` in
  `common.glsl` (linear 4-stage rate/level; release freezes pre-release level via
  `envPre4(t-tRel)`). Engine fallback reconstructs exact ADSR from legacy
  `decay`/`sustain`/`release` (`r3=0`→instant hold), so old DX7 ROM patches still work.
  `uOpC`/`uOpD` uploads guarded by `it.name==='dx7'`. Doubles DX7 uniform footprint
  (now `uOpA..uOpD`) — fine, just noted.
- **Phase-drift fix (`8bcc3be`): sound approach, correct.** MRT phase carry (2 extra
  render targets, ping-ponged). Strip bit-identical invariant holds by reasoning
  (`fract(fract(x)+y)==fract(x+y)`) but is NOT harness-verified — no A/B subBlock
  harness exists; worth adding one. DX7 carry algebra verified continuous (`t_carry=
  (x+1)/SR` from col 511; continuous across block + first-block→held seam).
  **Defect (being fixed): early-return paths** (`!voiceLive`, `t<0`) in
  synth-303/moog/dx7/808 don't write `outPhase`/`outPhase2` (dx7 also skips `outState`,
  but dx7 never uses outState anyway) → undefined values with 4 draw buffers bound.
  Masked today (note-on resets phase; carry checkpoint is always col BLOCK-1) but UB.
- **MIDI (`8bcc3be`, patched by automation rework): functional, rough edges.** Good:
  clean status UI, `onmidimessage=` re-attach (no dup handlers), vel-0=note-off,
  `(val<<1)|(val>>6)` full-range 7→8-bit. Issues (being fixed): (1) **CC record
  silently drops when no matching AutoTrack exists** (`main.ts` ~279-293) and the
  comment falsely cites a "legacy FX column" that the rework deleted; (2) CC→target
  map `cc>=70?cc-70:cc-1` is undocumented + collision-prone (CC1 and CC70 both →
  target 0); (3) live CC apply targets `cursor.ch`, not the selected instrument's
  channel (matches existing live-edit model).

---

## Reference / domain knowledge

### Effect column (per-cell note articulations) — `project`
Classic tracker effect column (added 0.8.0): a 4th per-cell sub-column (note·inst·vol·**fx**)
holding `cmd`+2-hex-`val`. **Distinct from automation tracks** — these are transient note
articulations (slides/vibrato), NOT param sweeps. Command set + helpers in
`src/tracker/fx.ts` (`FX_CMDS`, `fxChar`, `fxByKey`); the numeric code doubles as the
display nibble so it must stay 0..15 and match the typing key. Codes: `0` arp, `1`/`2`
pitch slide, `3` tone-porta (meend, no re-attack), `4` vibrato (gamak), `A` volume slide.

- **Storage:** `Pattern.fxCmd`/`fxVal` (Int16Array, fxCmd fill **-1** = none). Parallel
  arrays like notes/inst/vol — every clone/resize/clipboard path must carry them (resize,
  arranger Clone, `_copyBlock`/`_pasteBlock`+`ClipCell`, `clear()` wipes them).
- **Engine:** per-`Voice` fx state (`fxCmd/fxVal/fxStart/targetFreq`); `_applyCell` (called
  by `_triggerCells`) handles note+fx, with `3xx`+note as the no-retrigger meend special
  case; `_modulateVoices(blockStart)` runs each block (after `_refreshVoiceData`) and
  overrides `vd.freq`/`vd.vel`. Tuning consts at top of engine.ts (`FX_SLIDE` etc.).
- **WHY block-rate works with no shader changes:** modulation updates `vd.freq` once per
  BLOCK (~93 Hz). Smooth ONLY on phase-accumulating engines (303 `synth-303.glsl:33`, moog
  `synth-moog.glsl:109` — both `fract(phase + freq/SR)` from `uPrevPhase`). Closed-form
  engines (tanpura/dx7/808, `sin(2π·f·t)` from absolute t) STEP/click on per-block pitch
  changes → pitch fx are scoped to the leads; volume slide (vel) works everywhere. Pitch fx
  on closed-form engines need a per-voice pitch uniform applied to phase (future phase).
- **UI:** `tracker-view.ts` 4th sub-column (`COL_X/COL_W/COL_TEXT_PAD` 4 entries, `CH_W`
  124, `maxCol` 3); cmd amber / val cyan. Instrument column shows the numeric instance index
  (not short name) while `cursor.col===1`. Input in `main.ts._handleFxEdit` (col 3): a
  command key (0-4,A) sets cmd + arms `_hexEntry{col:3}`, next two hex digits fill val +
  auto-advance; Delete at col 3 clears only the fx. Note entry is skipped at col 3.

### Instrument registry — the plug-in system (`src/instruments/`) — `project`
Instruments are now data-driven descriptors, not scattered `if (type === …)` branches.
**`src/instruments/REGISTRY`** (in `index.ts`) is the single source of truth; one
`InstrumentDef` per engine (`i303.ts`, `idx7.ts`, `i808.ts`, `imoog.ts`, `itanpura.ts`,
`ie8e.ts`, `igroove.ts`, `itabla.ts`) co-locates its
shader, defaults, `paramDefs` (sidebar knobs), `autoTargets` (automation), `presets`,
help label/blurb, and flags (`recursive`, `drum`, `customControls`, `uploadVoiceUniforms`).
Everything derives from it: `constants.INSTRUMENTS` re-exports `index.INSTRUMENTS`;
`automation.TARGETS`, `presets.PRESETS`, `demo-songs.defaultParams/makeFx`, `help`, and
`synth-renderer` (maps `REGISTRY`) all read the registry. **Adding an engine that fits the
universal banks = one descriptor + one `.glsl` + one line in `REGISTRY`.** `InstrumentType`
is now `string` (open set), not a closed union.

Non-obvious constraints (don't break these):
- **`uP2`/`uP3`/`uFreqFrom` are now UNIVERSAL banks** declared in `common.glsl` (not the
  moog shader) and uploaded for *every* engine unconditionally in `synth-renderer`. Shaders
  that don't use them strip the uniform → `prog.u()` is null → silent no-op. So a new engine
  has 16 param floats (p0–p3) + freqFrom with zero new plumbing. DX7 operator banks
  (`uOpA–D`) stay bespoke behind `def.uploadVoiceUniforms` (must guard `if(!vd.dx7Ops)return`
  — minimal test harnesses build a vd without it).
- **Automation target ids are persisted in patterns, so `TARGETS` order is FROZEN.**
  `automation.ts` seeds inst-targets via `AUTO_ORDER = ['303','moog','dx7','808']` (the
  historical order — NOT registry/INSTRUMENTS order `303,dx7,808,moog`), then appends any
  newer engines. **Append new engines at the END of `REGISTRY`; never reorder/insert** or
  every saved/demo pattern's automation retargets. Verified ids: 303=0–6, moog=7–13,
  dx7=14–17, 808=18–20 (32 total with FX/CHAN/GLOBAL).
- Descriptors import only `../types.js` (type-only) + their `.glsl?raw` — **never** import
  `constants`/`engine`/`ui` (would cycle, since `constants` re-exports from `index.ts`).
- Refactor was behaviour-preserving: `render-check` byte-identical pre/post, all 16 demo
  songs load, glsl-check green. Tanpura, then **888State (`e8e`)**, were added through this
  registry. **E8E** is a closed-form 3-osc additive synth with an 8-bit quantizer; banks:
  p0=ADSR, p1=(detune2, detune3, bits, drive) — the automatable ones — p2=(wave1/2/3, oscs),
  p3=(level1/2/3, pulseWidth). Waves: 0 sine 1 saw 2 square 3 tri 4 noise; the Wave1–3 sidebar
  knobs render the name via `E8E_WAVES` in `controls.ts` (same `formatFn` path as 303/moog).
- **`groove`** (Locked Groove, short `GRV`) is a closed-form vinyl-noise texture: hiss +
  aperiodic grain crackle + dust pops + motor rumble + a **rotation-locked defect layer**
  (defects recur every revolution: P=(60/RPM)·SR samples; rev=floor(frame/P), phi=fract(frame/P);
  ~8 hashed-angle slots, drift-migrated and per-rev breathing; `Cycle` blends random↔locked).
  Banks: p0=(hiss,crackle,pop,wear) p1=(cycle,tone,rumble,drift) p2=(rpm,defects,color,fade).
  Play as a drone (pitch ignored, vel=level). **GLSL gotcha learned here:** `smooth` is a
  RESERVED keyword in GLSL ES 3.00 (interpolation qualifier) — can't be a variable name.
  Also: `glsl-check` passed this typo but `render-check` caught it — trust render-check (the
  real GPU compile path) as authoritative for shader validity, not glsl-check alone.
  **Tuned by reference-matching (like the 808):** downloaded CC0 vinyl recordings (Freesound),
  measured their stats, matched the synth. `test/vinyl-analyze.html` renders the synth and
  prints click-rate / spectral-tilt / rotation-autocorr with the reference TARGETS in its
  header (LP @33⅓ #263996: ~18 clicks/s, centroid ~3kHz, low-tilted, period 1.8s, ac~0.10);
  it's self-contained (no committed audio — refs are downloaded to a temp dir and removed).
  Key sound lessons: vinyl clicks are NOISY broadband bursts (a clean damped cosine reads as
  a tonal "water drop"); the hiss floor must be DARK (steep low-tilt) not bright white; clicks
  ride ~20dB above the floor (crest); deep <150Hz rumble gives the warmth. Click detection must
  high-pass first (first-difference) or loud rumble hides the transients.

### 808 drum reference tuning + the analysis harness — `project`
The 808 snare and clap (`src/gl/shaders/synth-808.glsl`) were tuned to objectively match
real TR-808 reference recordings, not by ear (which failed repeatedly).

**Reference samples** (Tidal Cycles Dirt-Samples repo, raw download):
- Clap: `https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/808/CP.WAV`
- Snare: `https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/808sd/SD0050.WAV`

**Target metrics measured from the real samples:**
- Snare: spectral centroid ≈ **858 Hz**, BODY-dominated (tonal partials 150–330 Hz at
  near-100%), modest noise; body decays ≈ -20 dB @ 70 ms.
- Clap: spectral centroid ≈ **1949 Hz**, narrow band 500–2400 Hz peaking ~1100 Hz, almost
  nothing > 3.5 kHz; 3 fast bursts (~10 ms apart) + long tail (-40 dB @ ~300 ms).

**Analysis harness:** `test/drum-analyze.html` renders each drum's raw voice (pre-FX) and
prints spectral centroid + autocorrelation + log-band spectrum + a 2ms/char envelope
sparkline. Run headless via Chrome+SwiftShader and grep the CONSOLE output. A high
autocorrelation peak is EXPECTED for the snare (tonal/body-dominated) but signals a bug
for noise-based sounds. GOTCHA fixed: the harness must set `vd.onRel[0] = -bs` per block so
t advances across blocks; with onRel fixed at 0 it rendered only the first ~10ms looped.
With the corrected harness: snare centroid ~834 Hz (vs 858 ref) and clap ~1675 Hz. The
envelope sparkline is the key tool for the clap: it must show 3 distinct bursts at
0/12/24 ms, then a delayed louder "spread" tail.

**Onset-locked noise (important):** the 808 drums must seed noise on
`rel = float(x) - uOnRel[v]` (samples since note-on), NOT the absolute frame
`uBlockStart + x`. Absolute seeding made the clap/snare pick a different noise slice every
trigger → audibly different each hit. `test/onset-check.html` verifies a drum renders
byte-identical at two different trigger times.

**Noise-hash π bug (fixed in `common.glsl`):** the noise hash multiplier was `1/π`
(0.3183099), which made `noise1` periodic every 355 samples (135 Hz buzz) because
355/113 ≈ π. Fixed to Dave Hoskins' 0.1031.

### TypeScript strict conversion — COMPLETE (2026-06-05) — `project`
`tsconfig.json` has `strict: true`; `npm run build` is gated on `tsc --noEmit` (also
`npm run typecheck`). 0 type errors. Verified runtime-neutral via headless harnesses
(glsl-check + render-check both ALL_OK).

- **Shared types** in `src/types.ts`: `InstrumentType`, `DX7Op`, `InstrumentParams`/
  `InstrumentInstance`/`InstrumentSpec`, `ParamCurve`/`ParamScope`/`ParamTarget`,
  `FxParams`/`FxParamsByType`, `VoiceData`, `SongData`, `SongDef`. Import with
  `import type {...} from '.../types.js'`. `GLProgram` (the `.u()` uniform-cache program)
  is exported from `src/gl/program.ts`.
- **Typed DOM helpers** in `src/ui/dom.ts`: `el`/`byId`/`qs`/`qsa`. `main.ts` uses a local
  generic `$<T>(id)=>getElementById(id) as T`.
- **UI↔engine seams fully typed:** `tracker-view` takes `engine: Engine`; `arranger`/
  `export`/`controls` take the real `App` (type-only import, no runtime cycle) and
  `Engine`. `engine.song` (SongData|null) and `app.renderer`/`pipeline.ctx`/`.analyser`
  are asserted `!` only where `ensureAudio()`/song-load guarantees them.
- The AudioWorklet ships as plain `src/audio/worklet.js` (NOT .ts) — Vite emits
  `new URL`-referenced assets verbatim, so a .ts worklet shipped raw TS with a video/mp2t
  MIME and failed `addModule()` in prod (worked in dev only).
- Only `src/env.d.ts` keeps `@ts-nocheck` (vite-client/`?raw` shim). `noUnusedLocals`/
  `noUnusedParameters` are ON — intentionally-unused params are `_`-prefixed. Remaining
  `any`/`as any` are narrow + justified: dynamic data-driven param-bank/op-key access
  keyed by runtime strings from a ParamDef table.

### Song save/load — versioned JSON (`src/tracker/song-io.ts`) — `project`
**💾 Save / 📂 Load** toolbar buttons serialize the whole song to `*.shaderwave.json`.
`serializeSong`/`deserializeSong` carry `format: 'shaderwave-song'` + `version` (currently
1). `deserializeSong` validates the header, THROWS on a newer format than it understands,
and routes older files through a `migrate()` stub (add `if (d.version < N) {…; d.version=N}`
as the schema evolves). Captures patterns (notes/inst/vol/fxCmd/fxVal + autoTracks), the
instrument table (p0..p3 + dx7 ops), per-engine fxParams, order, bpm, rowsPerBeat, pan,
master. On load: instruments rebuilt via `instrumentsFromParams` (back-fills colour + p2/p3
from descriptors), fxParams re-completed via the App's `cloneFx` (fills engine types a file
omits — e.g. engines added later), patterns via `patternFromSerialized` (length-clamped so a
hand-edited file can't throw). `_applySerializedSong` mirrors the demo-switch load path.
**Why versioned:** automation `paramId`s are the frozen target ids, and the data model keeps
shifting (banks, new engines), so the header lets old files keep opening.

### Effects: registry + PER-CHANNEL chains (`src/gl/effects.ts`, `synth-renderer.ts`) — `project`
Effects were decoupled into a data-driven registry like instruments: `FX_EFFECTS` is a list
of `FxEffectDef` (params + shader(s) + `init(gl)`→`process` closure); `EffectsChain` is a
generic runner; `defaultFxParams()` and chain order DERIVE from the registry. Add an effect =
one descriptor (+ `.glsl`). Then chains were moved from per-engine-type to **per channel**
(`SynthRenderer.chanFx[VOICES]`): each voice routes through its own insert (own reverb/delay
state) — two instances of one engine no longer share a chain. The per-voice dry signal is
isolated by reusing `mix.glsl` with the gain array MASKED to a single voice, reading that
voice's row of its engine's audio tex. Params are still stored per type (`fxParams['type']`);
each channel sources its params per block from the type it's playing (`renderer.setFxParams`),
so **no save-format change** and byte-identical for one-voice-per-type songs. Cost: 8 chains
run every block (~8× fx passes/state) — fine on real GPU. **Follow-up not yet done:** per-channel
param EDITING (distinct fx per channel), its UI, and the save-format migration that implies.
