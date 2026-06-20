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

### AI-generated songs MUST include their prompt in the description — `feedback`
When generating new demo songs, the `note` field of the `SongDef` MUST contain both a short description of the track AND the exact, verbatim text of the prompt the user provided to request it.
- **Why:** The user wants a permanent record of the prompt that inspired the creation of the song, embedded within the song's metadata.
- **How to apply:** Append " Prompt: <user's verbatim prompt>" to the `note` field.

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

## Historic Failures & Warnings

### Arpeggio NaN on a mid-block note trigger — ✅ FIXED (2026-06-18) — `project`
Symptom (demo "Slide Into My Pitches", P0 piano): the arp note at row 0 played fine, the
arp note at row 16 was a permanent click, repeating every loop. Root cause in
`engine._modulateVoices`: a sample-accurate note-on lands `fxStart > blockStart` for any
row NOT aligned to a 512-frame boundary (row 0 at frame 0 is the lone exception → why the
first note alone was clean). Seconds-since-effect-start `t = (blockStart - fxStart)/SR`
then went NEGATIVE, and the arpeggio evaluated `steps[Math.floor(t/FX_ARP_SEC) % 3]` with
`floor(neg) % 3 == -1` → `steps[-1] === undefined` → `Math.pow(2, NaN)` → NaN freq. The NaN
flowed into `vc.freqPrev` and then the `phaseOff` accumulator (`_accumPhaseOff`), so EVERY
subsequent block of that note rendered NaN = a stuck click. **Fix:** clamp at zero —
`t = Math.max(0, (blockStart - vc.fxStart)/SR)` (no modulation applies before the effect
starts; bit-identical for the normal `fxStart <= blockStart` case). This was a GENERAL bug
for arpeggio (and the milder wrong-first-block phase for vibrato) on ANY mid-block-triggered
note, not specific to pipi or that song. Regression test: `test/logic/arp-trigger.test.ts`
(drives real `engine.advance`, asserts freq/phaseOff stay finite for arp+vibrato notes that
trigger mid-block; verified it fails on the pre-fix form — the probe showed 798 NaN blocks).
**Debugging method that nailed it fast:** drive the Engine headlessly under node (esbuild
bundle) and dump per-block `vd.freq`/`vd.phaseOff`/`vd.onRel` for the voice — no GPU needed,
the NaN originates in the tracker layer. 62/62 logic tests green.

### Vocoder Implementation Disaster (2026-06-09) — SUPERSEDED by the working build (1.22.0)
**A working vocoder shipped 2026-06-15** (see "Vocoder — DONE" under Current work). This entry is kept
only as a record of the four failure modes a GPU vocoder hits, each of which the working build designs
out: (1) state leak → recursive work on a private FBO + detach state attachments after; (2) missing
SVF coeffs → per-band coeffs computed CPU-side, nothing implicit; (3) unnormalized bandpass → use the
`k·v1` unity-gain BP tap + clamp guard; (4) `uKeyTex` unbound / wrong unit → modulator on unit 5,
sampler uniforms set in init. Original post-mortem below.

Dave did something extremely stupid and asked Antigravity [Gemini 3.1 Pro (High)] to do this work, because he was out of Claude Code credits:
An attempt to implement a WebGL 16-band Vocoder effect was completely abandoned and reverted after ~2 hours and 5 consecutive failed correction loops. The implementation suffered from fundamental flaws across multiple rendering levels:
1. **WebGL State Leaks:** A feedback loop caused total engine collapse because the bypass path left textures dangling on unit 0.
2. **Missing Math:** The SVF block-rate filter coefficients were initially entirely omitted, turning the filters into unstable Nyquist static oscillators.
3. **Unnormalized DSP:** Even after restoring the SVF math, the bandpass filters weren't normalized by `1/Q`, causing the output to violently clip and explode to 113x maximum volume.
4. **Uniform Assignment Errors:** When cross-vocoding was attempted, the `uKeyTex` uniform was never mapped to unit 1, leading to an out-of-bounds fetch on unit 0 and pure silence.

**CRITICAL REMINDER:** If the user ever asks a Gemini model to do deep, non-UI architectural or DSP-level work on the ShaderWave engine again, strongly advise them to rethink the decision. The architecture is unforgiving, and trial-and-error state leakage or DSP math errors will immediately cripple the entire application.

## Current work

### Spectra resynthesis — time-varying analysis (2.12.0, 2026-06-20) — ✅ DONE — `project`
Phase 2 "deepen analysis" pass. The FIRST cut of resynthesis (analyze → atlas → Morph)
had already shipped inside the big Spectra commit (`f5f4bc5`) — the ROADMAP just wasn't
updated, so it still listed Phase 2 as the next task. This pass upgrades the *analysis*
from a single averaged harmonic profile to a **time-varying** one.
- **`additive-analysis.ts` rewritten.** `analyzeHarmonicSpectrum` now frames the WHOLE
  sample (hop = fftSize/2, ≤48 frames) and returns `{ atk, sus, decay, f0 }`:
  **atk** = harmonic amps at the onset/attack frame (argmax broadband energy), **sus** =
  mean amps over the latter-half (steady) frames, **decay** = per-harmonic decay RATE in
  1/s from a log-amplitude linear regression (attack frame → end, frames above 5% of that
  harmonic's peak; clamped 0..40). atk & sus are JOINTLY peak-normalized so attack-vs-body
  loudness survives. f0 via HPS + **parabolic sub-bin refine**. Fallback to a static 1/n
  profile when no pitch is found. Verified under node: synthetic 220 Hz tone with per-
  harmonic decay τ=1.5/h recovers decay rates EXACTLY (h/1.5) and atk is brighter than sus.
- **Atlas is now 3 rows per slot** (`ADD_SPECTRA_ROWS=3`, shared const in BOTH
  `synth-renderer.ts` and `synth-additive.glsl` — keep in sync, like ADD_TILE/ADD_MAXN).
  Texture height = `ADD_SPECTRA_SLOTS*ADD_SPECTRA_ROWS` (48). A slot's base row = slot*3
  (row 0 atk, 1 sus, 2 decay). `syncAdditiveSpectra` packs `[atk|sus|decay]` into one
  `Float32Array(K*3)` (cached by PCM ref) and uploads it as a K×3 sub-image at y=slot*3.
  `_addSlotByInstIdx[i]` still stores the SLOT (not the row); the shader multiplies.
- **Shader (`synth-additive.glsl`):** in the resynth branch each partial reads aAtk/aSus/
  aRate, computes `aAmp = mix(aAtk, aSus, clamp(t/ADD_ATK_BLEND,0,1)) * exp(-t*aRate)`
  (`ADD_ATK_BLEND=0.08s`), then the EXISTING `amp = mix(amp, aAmp, morph)`. So the analyzed
  contribution carries its own attack→sustain morph + per-partial decay; the global aenv
  (Attack/Release knobs) and formula per-partial Decay still apply on top.
- **Bit-identical invariant preserved THE EASY WAY:** the resynth branch is gated on
  `morph>0` (`resynth = uAddSlot>-0.5 && morph>0`), so morph=0 / no-sample skips it entirely
  → identical to the formula engine. No reordering of the formula path's float math.
- **Re-tuned Kalimba (resynth) preset:** zeroed its formula Decay (was 1.8 — would now
  STACK on the extracted decay) and pushed Morph 0.85→1.0 so the sample's own per-partial
  decay rings out cleanly. Vox Pad (sustained) left as-is. NOTE: the two resynth presets
  now sound different/better — accepted (the point of the pass), like the pipi/guitar
  overhauls. Non-resynth songs/patches are byte-for-byte unaffected.
- Verified: build clean, `glsl-check`/`additive-check` ALL_OK (resynth renders finite +
  audibly changes tone, NaN=0). **User-auditioned in-browser 2026-06-20 — sounds good,
  accepted.** **Still open for a
  later Phase 2 pass if wanted:** spectral *Freeze* (the other named-but-unshipped ROADMAP
  item), and the GPU-showcase partial push past 2048.

### Mod-matrix self-targeting + global→per-inst source modulation (2.11.0, 2026-06-20) — ✅ DONE — `project`
Per-instrument mod SOURCES (LFO 1/2 + Env) are now modulation TARGETS, reachable from
BOTH the per-instrument matrix (sources targeting each other) AND the global LFO matrix.
Targetable knobs: **LFO Rate, WtPos, Amount** and **Env A/D/S/R, Amount**. New
`ModSource.amount` (0..2, default 1) = a master multiplier on every route from a source
(serialized via `cloneInstMod`; `defaultModSource`/`normalizeInstMod` default it to 1).
- **New target kind `scope:'modsrc'`** (`automation.ts`, appended after the pitch loop →
  id-stable). 11 targets, `type:'*'`, carrying `modSlot` (0 LFO1·1 LFO2·2 Env) + `modField`.
  Like `pitch`, they're SPECIAL — applied bespoke in the engine, NOT via denorm. Excluded
  from `targetsForType` (so they never show in the automation picker / can't be a pattern
  lane); INCLUDED in `instModTargetsForType`; new `modSrcTargets()` lists them for both UIs.
- **Engine (`_applyInstMod` rewritten two-phase):** Phase A resolves each source's EFFECTIVE
  params (base + per-inst modsrc routes + global modsrc routings via the new
  `_globalRoutingOffset` helper), then Phase B applies destination routes scaled by the
  resolved Amount. `_applyLfos` now SKIPS modsrc routings (handled earlier in the block, so
  global→source→destination resolves with no latency — both read the same `_songBeats`
  before it advances). `_modSourceOffset` takes a resolved `SlotResolved` now.
- **Source→source is acyclic via one-block latency:** a source used AS a modulator reads its
  output from the PREVIOUS block (`_instModLastVal`), so mutual LFO1↔LFO2 just costs ~11 ms.
- **LFO Rate mod = octave shift** on the period (`RATE_OCT=4`, sync-agnostic). A rate-modulated
  LFO switches to PHASE ACCUMULATION (`_instModPhase`, seeded continuously from the closed-form
  value) so the rate change can't make phase jump. An UNMODULATED-rate slot keeps the
  closed-form phase → **bit-identical to the pre-modsrc engine** (regression-tested:
  `mod-matrix.test.ts` asserts `vd.freq === Math.fround(closed-form)`). Both runtime maps
  cleared in `_restoreLfoFx` (play/stop/loadSong).
- **UI:** `controls.ts` adds an Amt slider to every source panel + modsrc entries in the route
  dropdown, hiding a row's OWN slot (re-filtered on source change). `lfo-panel.ts` adds
  `i:SHORT · LFO 1 Rate`-style entries per instance to the global matrix.
- Verified: build clean, 66/66 logic tests (4 new: env→amount fade-in, LFO→LFO rate, global→
  per-inst rate, bit-identical guard). No GLSL touched. **User-auditioned in-browser
  2026-06-20 — sounds good, accepted.**

### Box-selection interpolation / LERP (2.10.0, 2026-06-19) — ✅ DONE — `project`
Box-select in the tracker → ramp values linearly first→last. Trigger: **Ctrl/Cmd+L** AND a
pattern-toolbar **#interpolate-btn** (disabled unless `canInterpolate` — refreshed each frame
in `main._loop`). Pure logic in `src/tracker/interpolate.ts` (`canInterpolate`/`interpolate`,
no UI deps → tested by `test/interp-check.html`, ALL_OK); thin wrapper `interpolateSelection(app)`
in `input.ts` (markDirty('interpolate') + view.draw()).
- Per selected column, find the **first & last "defined" rows** in the selection, linear-fill
  between (endpoints stay exact). Field is chosen by `view.cursor.col`:
  - **automation track** (ch ≥ p.channels): defined = `data[r] >= 0`; fill all span rows; byte 0–255.
  - **note · fx** (col 3): defined = `fxCmd[idx] != -1`; fill all span rows; ramps `fxVal` **and**
    writes the **first endpoint's command** to every filled row (mismatched endpoint cmds → first wins).
  - **note · vol** (col 2): defined = row has a note; fill **only note rows**; float 0–1, r4-rounded.
  - note/inst columns aren't interpolatable; a column with <2 defined rows is skipped.
- Selection model reused: `view.selection={r0,c0,r1,c1}` + `view.cursor.col` (0 note/1 inst/2 vol/3 fx),
  mirroring `copyBlock`/`pasteBlock` in `input.ts`.

### Gist publishing — durable share for big songs (2.9.0, 2026-06-19) — ✅ DONE — `project`
ROADMAP Phase 3 extra, on top of 2.8.0's permalink. `src/tracker/gist.ts` publishes a song
to a **secret GitHub Gist** (`public:false` — unlisted but link-readable, NOT access-
controlled). Fully serverless:
- **Writes** use the publisher's OWN classic PAT scoped to **`gist` only** (a leak touches
  only their gists). Stored in `localStorage` (`shaderwave-gist-token`) — IndexedDB would NOT
  reduce XSS (both are same-origin JS-readable); blast radius is controlled by the scope, not
  the store. First publish opens `github.com/settings/tokens/new?scopes=gist&...` then prompts
  for the paste. Share menu has a "Forget Gist token" item; a 401 clears the token + re-prompts.
- **Reads are anonymous**: one `GET /gists/<id>` (counts against the 60/hr unauth limit) →
  follow `raw_url` (CDN, doesn't). So opening a `#gist=` link needs no token.
- **Gist body** = one text file: a `#`-commented header (version, Song, By, `Open ▶ <host>/#gist=<id>`)
  + the SAME base64url payload the `#s=` permalink uses (`songToPayload`/`payloadToSong`,
  factored out in song-codec). base64url has no `#`, so the loader strips header by dropping
  leading `#`/blank lines. The deep-load link needs the id, which only exists after create →
  **two calls: POST create, then PATCH** to backfill the `Open ▶` line (PATCH failure is non-fatal).
- **UI**: the header Share button is now a menu (Copy link / Publish to Gist… / Forget token).
  Startup `_tryLoadSharedSong` handles `#s=` (decodeShareHash) OR `#gist=` (decodeGistHash),
  both via the transient `'shared'` CurrentSong kind.
- **Size**: ~900KB payload guard (gist content ~1MB-practical); huge sampler songs → "save a
  file" message. Device Flow stays a DEAD END (no CORS at github.com).
- Verified: `test/gist-check.html` (ALL_OK) — pure header+payload round-trip for all 34 demos +
  header shape. The live GitHub POST/GET is manual-only (needs a real PAT).
- **Gotcha — DON'T use native `prompt()` for the token (fixed 2.10.5).** The first-publish flow
  does `window.open(GIST_TOKEN_PAGE)` then asks for the paste. A native `prompt()`/`alert()`/
  `confirm()` right after `window.open` is **silently suppressed** by Chrome/Firefox: the new tab
  steals focus, our tab is now backgrounded, and browsers refuse dialogs from backgrounded tabs
  (returns `null` instantly → publish aborts with no dialog ever shown). Symptom: token page opens
  but the paste box never appears. Fix = an in-app HTML modal overlay (`#gist-token-overlay` +
  `App._promptGistToken()` in `main.ts`), which isn't subject to that suppression and survives the
  focus switch so the user can paste on return. Same caveat applies to any future "open a tab then
  ask" flow.

### Compact binary song format + permalink sharing (2.8.0, 2026-06-19) — ✅ DONE — `project`
ROADMAP Phase 3 core. New `src/tracker/song-codec.ts` sits BENEATH the object model —
`song-io.ts` still maps runtime ⇄ `SerializedSong` (+ `migrate`), and undo/history still
pass that object around untouched. The codec only turns the object into bytes:
- **Container `SWB1`** = a JSON *skeleton* (the SerializedSong minus its heavy arrays) +
  those arrays as raw typed-array *blobs*, pulled/reattached in ONE fixed traversal
  (patterns → notes/inst[i16], vol[f32], fxCmd/fxVal[i16], each autoTrack data[i16]; then
  instruments → sample pcm as raw int16, no base64). Skeleton key ORDER differs from the JSON
  path — that's fine (content-equal); the harness compares with sorted keys.
- **`decodeSongBytes` content-sniffs**: gzip magic `1f 8b` → gunzip; then `SWB1` → binary,
  else UTF-8 JSON (legacy). So old `.shaderwave.json` files AND already-stored gzipped-JSON
  IndexedDB bodies keep loading. Storage (`song-store`) + file save (`saveSong`, now async,
  writes `.shaderwave`) + file load (`loadSongFile`, reads ArrayBuffer) all route through it.
  `preset-store` stays on JSON (presets are tiny).
- **Permalink**: `binary → gzip → base64url` in `#s=…` (`buildShareUrl`/`decodeShareHash`).
  Pure front-end (fragment never hits the server — works on GitHub Pages). Startup hook in
  main.ts (`_tryLoadSharedSong`) loads it as a NEW `CurrentSong` kind `'shared'` (transient —
  autosave only persists `'user'`, so it won't clobber the library; Save persists it). Share
  button in the header; `URL_MAX = 64000` chars guards multi-MB sampler songs (rich pattern
  songs fit ~29KB).
- **vol** is the only lossy-looking field: JSON r4-rounds it, binary stores raw Float32 (≥ as
  precise) — harness compares vol within 4 decimals, all else exact.
- Verified: `test/songcodec-check.html` (ALL_OK) round-trips all 34 demos + gzip + legacy-JSON +
  sample PCM + the full `#s=` permalink. Needs a LARGE `--virtual-time-budget` (~70000) — gzip
  streams crawl under virtual time (same as the preset/store harnesses).

### Preset explorer — A/B + morph + randomize/nudge (2.7.0, 2026-06-19) — ✅ DONE — `project`
Phase 1's tail (the "nice-to-haves" deferred from 2.6.0). All in `src/ui/controls.ts` + the
`#preset-morph` block in the Instrument tab — **no types/store/main changes**. Two A/B scratch
slots (`_abSlots`, in-memory, each tagged with its engine `type`), a morph slider that blends
A→B **live and non-destructively**, and Randomize (full-range) / Nudge (±15%) buttons.
- Operates ONLY on the universal synth banks p0–p4 via `_synthDefs()` =
  `paramDefs.filter(d => d.bank && d.type !== 'op')`. FX + mod matrix untouched (by design).
- Reuses the existing knob plumbing: `_setSynthParam` quantizes to the param's `step`/range,
  writes the bank, calls `engine.updateInstrumentParam` (audible on held voices), and
  `paramKnobs[].el._extSet(v)` to move the dial — **no `_buildParams()` per frame**.
- Recall/morph are enabled only when the slot's `type` matches the selected instrument
  (`_updateMorphControls`, called from `select()`); morph slider needs both slots.
- All actions `markDirty` → single undo step.
- **DX7 limitation (intentional):** operator params are `type:'op'` so they're excluded —
  Randomize/Morph/A-B only touch algo+feedback there. DX7 patch variety lives in presets.

### Instrument editor tab + user presets (2.6.0, 2026-06-19) — ✅ DONE — `project`
Phase 1 of `ROADMAP.md` ("open the preset system"). Two parts:
- **Instrument editor TAB (2.5.6):** the per-instrument params/fx/presets/mod-matrix moved
  out of `#sidebar` into a 3rd tab (`#instrument-editor-content`) inside `#tracker`, beside
  Pattern/Song. Sidebar keeps only Monitor + the instrument list (the selector). Tab switching
  is now `App.activateTab('pattern'|'song'|'instrument')` (single switch point; the instrument
  list's sliders icon calls it). **Gotcha that bit us:** the pattern-grid CSS was `#tracker
  canvas {width/height:100%}` — once the tab moved INTO `#tracker` it stretched the mod-matrix
  envelope canvas + wavetable scopes. Fixed by scoping that rule to `#grid`. Section-header
  styling was `#sidebar h2` → generalized to also match `#instrument-editor-content h2`.
- **User presets (2.6.0):** save/load/rename/delete + single-preset `.json` import/export.
  - `Preset` (`types.ts`) gained `ops?` (DX7 operators), `type?` (engine bucket), `fxOrder?`.
    Built-ins omit `type`; user/exported presets set it.
  - `PresetStore` (`src/tracker/preset-store.ts`) is a near-verbatim copy of `SongStore` but in
    its OWN IndexedDB (`shaderwave-presets`) — zero migration risk to the song DB. Meta cache →
    synchronous `list(type)`; gzip body == the export `.json` body. `app.presetStore`, init in main.ts.
  - **Dropdown value scheme (the refactor surface):** user presets are prefixed **`u:<id>`**;
    built-ins keep their BARE numeric index (so `_findMatchingPreset`/`_refreshPresetSelection`/
    sampler callsites are untouched). `onchange` dispatches on the `u:` prefix.
  - `loadPreset`'s non-dx7 body was extracted to **`_applyPreset(preset)`** (shared by built-in +
    user load); `_capturePreset(name)` is its inverse (uses `serializeSample`, now exported from
    `song-io.ts` and shared with song save). DX7 built-in ROM patches still load inline (`d:` is
    the ROM list); DX7 USER presets round-trip via `_applyPreset` + `preset.ops`.
  - Sample-based presets (sampler/Spectra) store/export resolved PCM as base64 Int16 — self-
    contained, no URL dependency. Headless harness: `test/preset-check.html` (needs a LARGE
    `--virtual-time-budget`, ~120000 — IDB+gzip-stream awaits crawl under virtual time).

### Per-instrument modulation matrix (2.5.0, 2026-06-18) — ✅ DONE — `project`
Each instrument INSTANCE now owns its own mod matrix (`InstrumentInstance.mod`): a FIXED
bank of **2 LFOs + 1 mod-envelope** + a list of routes. Distinct from the song-wide global
LFOs (`engine.lfos`/`modRoutings`, Song Editor) — this travels WITH the instrument into
presets and saves. Data shapes in `src/types.ts` (`ModSource`/`ModRoute`/`InstrumentMod`/
`ModEnv`); factories + CPU ADSR + normalize in `src/tracker/instmod.ts`. Non-obvious bits:
- **The "ADSR source" is a DEDICATED mod-envelope, NOT an engine's amp env.** Amp envelopes
  live in the shaders (GPU-only, per-engine, not standardized) — the CPU literally can't read
  them. So `modEnvValue()` is a fresh CPU ADSR evaluated from each voice's `onFrame`/`offFrame`
  (release eases from the level reached at key-up via `t - tRel`, so a short note doesn't jump).
- **Pitch is a SPECIAL target** (`ParamTarget.pitch`, appended per pitched engine — drum/
  pitchless excluded — at the very END of `TARGETS`, id-stable). It modulates `vd.freq`
  (vibrato), not a param bank. `instModTargetsForType()` is the destination list (inst + fx +
  pitch); plain `targetsForType()` EXCLUDES pitch (`!t.pitch`) so it never shows in the
  automation picker or global-LFO dropdown (pitch automation would fight note triggers).
- **`_applyInstMod` runs BEFORE `_accumPhaseOff`** (engine block order: refresh → modulate →
  applyInstMod → accumPhaseOff → applyLfos). That's the whole trick for click-free vibrato on
  CLOSED-FORM engines: pitch routes multiply `vd.freq`, then `_accumPhaseOff` corrects the
  phase generically (same path the fx-column `4xy` vibrato uses). Pitch routes stack
  multiplicatively with the fx column + each other. With NO routes the pass early-returns →
  `vd.freq` untouched → `phaseOff` stays 0 → render is **bit-identical** (verified via fround).
- **Source value scope:** a free-running LFO yields ONE value for all voices; envelopes +
  retriggered LFOs are per-voice (phase from the voice's `onFrame`). For SHARED fx targets a
  per-voice source uses the NEWEST active voice as representative (none active → leave fx alone).
- **fx base-tracking is SEPARATE** (`_instModFxBase`/`_instModFxLast`, keyed `${ii}:${key}`)
  from the global-LFO maps so the two don't corrupt each other's re-baselining; both restored
  on play/stop in `_restoreLfoFx`. Routing BOTH a global LFO and an instance route at the same
  instance+fx field is unsupported (they fight; last writer per block wins).
- **Persistence:** `instrumentsFromParams` attaches a default (inert, no-routes) matrix to every
  instance; `song-io` serializes `mod` per instrument ONLY when it has wired routes
  (`instModHasContent`); `loadPreset` adopts `preset.mod` if present, else leaves the existing
  matrix (built-in presets predate mod, so loading one must not silently wipe a user's routings).
- **UI:** `Controls._buildModMatrix` renders the "Modulation" panel in the instrument sidebar
  (source slots + routes table); global-LFO target dropdown reordered so per-instrument targets
  come LAST (`lfo-panel.ts`) now that instruments have their own matrix. CSS `.mod-*` in index.html.
- Verified: build clean, `phaseoff-check`/`glsl-check` ALL_OK, custom CPU harness (vibrato ±depth
  finite, env ramp+release, unrouted instance bit-identical). `render-check`'s dx7/sampler FAILs
  are pre-existing (no ROM/sample → silent), confirmed identical on the clean tree. NOT yet
  user-verified by ear in-browser. COMPOSING.md §8 updated with `InstrumentSpec.mod` authoring.

### Roadmap (`ROADMAP.md`) + Phase 0 real-GPU perf measured (2026-06-18) — `project`
The repo now has a `ROADMAP.md` (flexible, dependency-ordered): Phase 0 real-GPU perf
harness → Phase 1 instrument editor → Phase 2 Spectra resynthesis → Phase 3 reach
(compact binary save format + gist/permalink sharing; mobile dropped — mobile GPUs can't
run this). "Solid-artifact" hardening runs as a track through all phases. Sharing decision
recorded there: **secret GitHub Gists, written with a user-supplied fine-grained PAT**
(reads anonymous via `raw_url`; `api.github.com` is CORS-OK so it works from static Pages),
permalink as default. **Dead end noted:** OAuth Device Flow is CORS-blocked at GitHub's
`github.com` token endpoints → needs a proxy = a backend; don't re-investigate.

**Phase 0 DONE — `test/perf-check.html`** (NEW). Times the full render path on REAL hardware
(the SwiftShader harnesses validate correctness, NOT speed). Method: wall-clock around the
SYNC `renderBlock` (its blocking `readPixels` forces GPU completion) — conservative vs the
shipped PBO-pipelined `renderBlockAsync`. **MUST run in the user's real browser** (open
`localhost:5173/test/perf-check.html`); do NOT run headless (SwiftShader = meaningless perf
+ pegs the laptop). Per-engine + Spectra partial-sweep + FX-overhead + real-song sections,
med/p95/max vs the 10.67 ms budget. GPU-only timer-query column came up empty on the user's
ANGLE/Mesa Intel (returns `GPU_DISJOINT`) — wall-clock stands; that's expected, not a bug.

**FINDINGS (Intel ARL / Mesa, 2026-06-18) — the GPU premise does NOT currently pay off:**
- **Spectra's partial curve is FLAT:** 64→2048 partials at 8 voices costs 1.7→2.2 ms median.
  32× the partial work ≈ +0.5 ms. The parallel partial-sum — the whole justification for GPU
  audio — is invisible against fixed per-block overhead. The chip is idle even at the cap.
- **Cost drivers are overhead + the recursive engines, NOT parallel compute.** A ~1.5 ms
  fixed floor (readback stall + per-block uniform uploads) is hit by even the cheapest engine.
  The **recursive ladders are the most expensive — more than 2048 partials**: 303 = 3.3 ms,
  moog = 2.5 ms (8 strip-passes + state ping-pong/block) vs additive@2048 = 2.2 ms. The acid
  bass costs more than the "massive additive synth."
- **Idle-engine skip — ✅ SHIPPED, bit-identical (2026-06-18).** `_renderToMix` used to render
  all 13 engine shaders every block regardless of active voices; now it skips an engine type
  with zero active voices this block. Closed-form engines are stateless → skip whenever idle
  (the mix masks their texture to 0 gain, so a stale/zero texture can't leak). Recursive engines
  (303/moog) carry filter state → skip only while UNTOUCHED since `resetState` (state == reset
  zero); a per-engine `touched` flag flips on first active block and then they always render so
  the cross-block decay stays exact. Toggle `renderer.skipIdleEngines` (default true). **Verified
  bit-identical: `maxDiff(on vs off) = 0` over 220 blocks of "Antiseptik USA" (perf-check §5).**
  Win SCALES with how many engines a song leaves unused: huge in isolation (per-engine §1 medians
  ~halved — 303 3.3→1.8 ms — since 12 engines skip), ~nil on engine-dense songs like Antiseptik.
- **subBlock tuned 64 → 256 (2026-06-18).** Strip width for the recursive ladder. A low-jitter
  perf-check §6 sweep (16–512) had BOTH 303 and Moog bottom out at **sub=256** (p95 ≈2.3/2.5 ms),
  clearly below 128 (3.2/3.6) and 512 (3.4/3.9) — both engines agreeing = real signal. Shape:
  fewer strips win (draw-call/state-switch overhead dominates) until sub=512 = 1 strip, where the
  O(BLOCK²) per-fragment recompute dominates and it regresses; 256 = 2 strips is the sweet spot.
  Bit-identical at every width (`303 sub=64 vs 512 maxDiff=0`) — pure perf knob. (Tuned for this
  Intel ARL / Mesa class; the huge 3.68× headroom means it's not worth per-GPU autotuning.)
  Clean-run idle-skip win on Antiseptik was a real **1.28×** (2.50 vs 3.20 ms), bit-identical.
- **METHOD GOTCHA — wall-clock p95/max is main-thread JITTER, not GPU cost.** A noisy 2nd run showed
  medians DOWN (idle-skip working) but p95/max EXPLODED uniformly across all scenarios (303 p95
  5.6→11.5, "OVER budget" verdicts) while §6 ran clean in the same page — i.e. GC/scheduler/thermal
  spikes, not the code. The shipped path (`renderBlockAsync` PBO pipeline + `PREBUFFER_BLOCKS` queued
  ahead) absorbs these, so **median is the real GPU-cost signal**; perf-check's verdict now keys off
  median (p95/max shown but labelled jitter). GPU-only timer-query stays empty on this ANGLE/Mesa
  (DISJOINT). Median worst across everything ≈ 3.9 ms (Antiseptik) → ~2.7× headroom; realtime safe.
- **Realtime CONFIRMED, measured not asserted:** worst-case p95 6.8 ms vs 10.67 ms (1.57×),
  0/548 real-song blocks over budget (Antiseptik USA, Tantric Spectral Edging). Async path has
  more headroom still. Worst single block 8.6 ms (busy transient) — absorbed by prebuffer.
- **Roadmap consequences:** (1) **WebGPU shelved** — it'd optimize a non-bottleneck. (2) Phase 2
  resynthesis is justified by SOUND, not speed — set expectations. (3) To make the GPU premise
  actually pay off as a showcase, push Spectra FAR past 2048 partials / more voices to find the
  genuine GPU-bound crossover (there's 4–5× headroom). The current cap is too low to make the case.

### Spectra — massive GPU-parallel additive engine (1.38.0, 2026-06-17) — ✅ DONE — `project`
**Why it exists:** the user asked, honestly, whether GPU audio buys anything over CPU. For an
8-voice synth it doesn't — the modal engines sum ~64 partials in a SERIAL inner loop, so the chip
sits idle (SwiftShader keeping up in the harnesses is the tell the work was never compute-bound).
Spectra is the answer: it **parallelises over partials** so the GPU finally has real work.
**Design (registry type `additive`, `additive: true`):**
- Up to **2048 partials/voice**, summed in PARALLEL. Pass 1 (`synth-additive.glsl`) renders a
  `BLOCK × (ADD_TILES·VOICES)` texture, **one TILE of 32 partials per fragment**, row-packed
  **tile-major / voice-minor** (`row = tile*VOICES + voice`). Pass 2 (`additive-reduce.glsl`) is a
  **log-reduce**: halve the tile axis by summing adjacent row-pairs of the same voice, ping-ponging
  `addA`/`addB`, the final pass (`uFinal` → tanh) landing in `it.audio` (BLOCK×VOICES). 64 tiles → 6
  passes. At full poly ≈ 8M fragments/block.
- It's the **first multi-pass engine**, so it breaks the "one descriptor + glsl + registry line" rule:
  needs a renderer branch `SynthRenderer._renderAdditive` (gated on `def.additive`) + a reduce program
  + 3 textures built in the ctor. The shared partial-tile/reduce constants `ADD_TILE=32`/`ADD_MAXN=2048`
  live in BOTH `synth-renderer.ts` and `synth-additive.glsl` — keep them in sync.
- Spectrum is **formula-driven, resynthesis-ready** (Phase 1): stretched harmonic series shaped by
  Partials/Tilt/Stretch/Odd-Even/Comb + per-partial Decay/DecayTilt + Detune spread. **Decorrelated
  per-partial phase** (`hash11`) keeps the summed RMS bounded (~1.3 for 1/n amps) and avoids an onset
  spike from 2048 coherent partials. Params: p0=[Partials,Tilt,Stretch,OddEven] p1=[Decay,DecayTilt,
  Detune,Comb] p2=[Attack,Release]. Tilt/Stretch are the marquee LFO/automation targets.
- Effect-column pitch works (uses the same `te = t + uPhaseOff/f0` correction).
- **Verified** by `test/additive-check.html`: finite/bounded across 64→2048 partials; ms/block scales
  with P (12→20 ms under SwiftShader, sub-linear because fixed per-block overhead dominates at low P).
  Under SwiftShader it's SOFTWARE so absolute times are slow + only scaling is meaningful — on real GPU
  the 2048 case is well under the 10.7 ms realtime budget. **Phase 2 (not done):** uploaded spectral
  table → true additive *resynthesis* (analyse a sample → morph/freeze its partials).

### Spectra expressivity pass — coherence + shimmer + formant + velocity (2.1.0, 2026-06-17) — `project`
User felt Spectra was "not versatile or good sounding." Diagnosis: every partial got fixed RANDOM phase
(no attack transient → washy), partials were static (no movement → frozen pads), and the only shaper was a
monotonic `1/n^tilt` rolloff (no formants; velocity only scaled volume). Fixes, all in `synth-additive.glsl`
+ `iadditive.ts` (NO renderer/multi-pass change, voices stay mono):
- **Coherence** at the previously-unused `p2.w`: `phi = mix(rnd, 0.0, coher)` — 1 = coherent strike (defined,
  click-free attack; reducer tanh + per-partial detune bound the onset spike, the proven piano-strike approach),
  0 = the legacy random-phase wash.
- **Shimmer** (`p3.x`): per-partial decorrelated amplitude LFO (rate 0.5–6 Hz) on absolute note time → alive pads.
- **Formant** (`p3.y` pos 150–5000 Hz, `p3.z` amt [0=off], `p3.w` BW octaves): a movable log-frequency Gaussian
  boost → vowels/body. Two new presets (Vowel Choir, Talking Pad) + a woody formant on Clarinet.
- **Velocity→brightness**: folds into the tilt exponent, ANCHORED at full velocity (`vel==1` neutral) so only
  softer notes darken. Always-on (no knob), matching the Pipi/Gigi playbook.
- **Backward-compat**: shimmer/formant branches are gated on `>0` (skipped = bit-identical AND free at default/old
  patches). Default `p3` shimmer/formant = 0 so songs that omit p3 (back-filled from descriptor defaults) stay
  identical; the shipped demo "Tantric Spectral Edging" sets `p2[3]=0` explicitly so its phase is unchanged too.
  Only deviation from bit-identical there is the always-on velocity→brightness on its sub-unity-velocity notes
  (accepted, like Pipi/Gigi). Fresh `+Add` instances get default coherence 0.5 (livelier attack); the rich
  shimmer/formant character lives in the presets. Verified: build green, glsl-check ALL_OK, additive-check
  ALL_OK (NaN=0, peak tanh-bounded ~1.0 across 64→2048; one extra `mix` per partial, negligible on real GPU).
- **Coherence/Shimmer/Formant ARE automatable (done, same 2.1.0 branch).** Inst-scope automation used to support
  only p0/p1 — `ParamTarget.bank` was typed `'p0'|'p1'` and the apply path hardcoded `bank==='p1'?p1:p0`, so a p2/p3
  target would have silently written to p0 and corrupted Partials/Tilt. Widened to p0..p3 in FIVE places: the type
  (`types.ts`), and in `engine.ts` the live-apply (`_applyAutomation` ~708), `applyAutomationLive` (~727), the
  LFO apply + autoLive-base read (`_applyLfos` ~880/882), and the note-on autoLive merge in `_writeParams` (now
  loops all 4 banks). The UI/recording/`updateInstrumentParam` paths were ALREADY bank-string-generic — no change.
  Spectra's COH/SHM/FMP/FMA/FMW autoTargets are restored. Regression tests in `automation.test.ts` drive a real
  Engine + additive instance and assert SHM→vd.p3 / COH→vd.p2 (and that p0 is left untouched), plus the note-on
  merge. 888State could opt its p2/p3 in too now (not done). 59/59 logic tests green.
- **Demo "Tantric Spectral Edging" reworked (same branch)** to exercise it all: the choir pad got a baked formant +
  shimmer with LFOs sweeping **Formant pos (FMP)** and **Shimmer (SHM)** — both p3, the new-automatable bank — for a
  vowel morph; the cathedral bell is now a coherent strike; the kalimba lead a coherent pluck. Its `note` keeps both
  prompts verbatim. Verified by `npm run build` + the demo-load/target-audit logic tests (no headless render, per the
  user's steer that the SwiftShader path hammers their laptop — they audition demos themselves).

### Stereo instruments — stereo bus + Spectra stereo spread (2.3.0, 2026-06-18) — ✅ DONE — `project`
The whole audio path was already stereo from the MIX pass onward (`mix.glsl` reads per-voice MONO `.r`,
applies gain + equal-power pan → `vec4(l,r,..)`; FX chain + readback all stereo). The ONLY mono link was
the instrument synth output itself: every engine writes `outAudio = vec4(sample,0,0,1)` (mono in `.r`),
and pan merely PLACED that mono signal. "Make Spectra stereo" = let an engine emit a genuinely different
L/R *before* the pan stage.
- **Stereo bus convention (general, opt-in per engine):** new `InstrumentDef.stereo?: boolean`. Stereo
  engines write independent L/R in `outAudio.rg`; mono engines leave `.g`=0. `mix.glsl` gained a `uStereo`
  uniform (set per-instance in `SynthRenderer.mixInstance` from `src.def.stereo`): `uStereo==0` reads `.r`
  for BOTH channels (the original mono path, literally bit-identical), `==1` reads `.rg`. **Pan is preserved**
  — for mono it's the same equal-power pan; for stereo it acts as a BALANCE on the engine's own image (centre
  = full image at −3 dB; hard pan favours one channel, its far content fades). Bit-identical for all existing
  mono content (same code path) — verified `max|L-R|==0` for a mono source at centre.
- **5th universal param bank `uP4`** (p0–p3 were ALL used by Spectra). Mirrors p2/p3 plumbing EXACTLY across
  ~15 sites: `common.glsl` uniform, `types.ts` (InstrumentParams/ParamTarget.bank/VoiceData/ParamDef/Preset),
  `engine.ts` (vd alloc, `_writeParams` copy+autoLive-merge loop, addInstrument clone, `_applyAutomation`,
  `applyAutomationLive`, `updateInstrumentParam`, `_applyLfos`), `demo-songs.ts` (defaultParams/makeParams),
  `song.ts` addExtraBanks, `song-io.ts` (SerializedInstrument + serialize), `controls.ts` loadPreset, and the
  two `uniform4fv(uP4)` upload sites in `synth-renderer.ts`. **GOTCHA:** the 5 headless harnesses that hand-build
  a `VoiceData` literal (`additive-check`, `render-check`, `phaseoff-check`, `sampler-check`, `vinyl-analyze`)
  each needed a `p4` field added or `uniform4fv` throws "cannot be converted to a sequence" (undefined).
- **Spectra stereo (`synth-additive.glsl`):** `spread = uP4.x` (0..1). Per partial, a voice-INDEPENDENT signed
  position `d = (hash11(n*3.13)-0.5)*2*spread ∈ [-spread,spread]` fans partials L↔R via a BALANCE law that
  preserves centre gain: `accL += s*(1-max(d,0)); accR += s*(1-max(-d,0))`. At spread=0 both gains are 1 →
  `accL==accR` → bit-identical mono. `additive-reduce.glsl` now sums `.rg` (was `.r`) and tanh's both.
  Voice-independent placement = a chord shares ONE coherent image. New "Stereo" knob (p4.0) + `SPR` autoTarget;
  pad/swarm presets (Choir/Soft/Bowed/Vowel/Talking/Saw Swarm/Vox) got tasteful spread, plucks/bells stay mono.
- **GOTCHA when testing stereo headless:** Spectra's `fxDefaults` enable REVERB, which decorrelates L/R for
  even a mono input — so a post-FX render shows L≠R regardless. Bypass with `setInstrumentFx([neutralFxParams()])`
  to measure the SYNTH's own stereo. Verified: build green, glsl/additive/render/phaseoff harnesses ALL_OK,
  59/59 logic tests, and a throwaway harness confirmed spread=0 `max|L-R|==0`, spread=0.8 `max|L-R|≈0.13`.
- **To make ANOTHER engine stereo:** set `stereo:true` on its descriptor + write `outAudio.rg`. Most engines
  are inherently mono and need no change. Nothing else in the bus/pan path requires touching.

### defaultFxParams() now defaults every effect OFF (2.3.3, 2026-06-18) — ✅ DONE — `project`
`defaultFxParams()` used to merge the FX_EFFECTS registry defaults, SIX of which were `…On: true`:
**dist (1.4), delay (0.32 mix), reverb (0.26 mix), width (1.15)** were audible; **chorus & tremolo** were on
but `mix: 0` so silent. Anything doing `Object.assign(defaultFxParams(), {…})` silently inherited those.
Flipped it to force all 13 `…On` flags false (param baselines kept, so opting in needs only `reverbOn: true`
etc.). To keep behavior identical, every consumer's reliance was made EXPLICIT first via a brace-matching
codemod that injects the missing-of-six `…On: true`:
- `demo-songs.ts`: 132 fx objects (both `Object.assign(defaultFxParams(),…)` AND `makeFx({…})` partials —
  `makeFx` also builds on defaultFxParams). Latent bug found: "Shamanic Colonic"'s dx7 wasn't listed in its
  `makeFx`, so it rode the bare 6-on default → added an explicit `dx7` entry.
- 4 instrument descriptors (i303/i808/imoog/itanpura): 23 preset `fx:` snapshots — presets load via the same
  `Object.assign(defaultFxParams(), preset.fx)` path (`main.ts` onPresetChange), so they'd have gone dry too.
- `neutralFxParams()` (used by `+ Add`) was already all-off; unchanged.
**Verification = provable, not vibes:** captured every demo song's + every preset's RESOLVED fx before/after
and required a ZERO diff (34 songs + 23 presets byte-identical). Since the engine consumes exactly those
resolved objects, identical objects ⇒ identical audio — no headless render needed. **Gotcha that bit me:**
esbuild bundles a snapshot, so re-run the capture against a FRESHLY re-bundled script after editing or you
diff against stale code. **To add a new fx-on effect to a song/preset now: set its `…On: true` explicitly.**

### Theming / light theme (2026-06-17) — ✅ DONE — `reference`
The palette is **CSS custom properties** in `index.html` `:root`; a light theme is the override
block `:root[data-theme="light"] { … }`. Switching = `document.documentElement.dataset.theme`
('light'|'dark'), persisted to `localStorage['shaderwave-theme']`. An **inline `<head>` script
applies the saved theme before first paint** (no flash). Toggle: header `#theme` button → `_bindTheme`
in main.ts → `toggleTheme()` in `src/ui/theme.ts`. GOTCHA: the **tracker grid is canvas-drawn** and
reads colours via `themeVar('--x')` (cached) — so (a) any new grid colour must be a CSS var added to
BOTH `:root` blocks, not a hardcoded literal, and (b) after a theme switch you must `invalidateTheme()`
(setTheme does) AND repaint (`view.draw()`; the visualizer repaints per-frame anyway). New grid vars
added for this: `--grid-line`, `--grid-line-strong`, `--sel`, `--vol`, `--cell-muted`. The CHROME
(panels/dropdowns/modals/LCD/FX-picker/LFO-panel/inputs) had ~60 hardcoded dark literals that ignored
the theme — those were collapsed into **5 semantic tokens** read as `rgb()/rgba()` so existing alphas
survive: `--c-surface` (raised panels), `--c-inset` (recessed/near-black), `--c-border`, `--c-text-bright`,
`--c-text-dim`. Dark sets them to the originals (look unchanged); light flips them (white surfaces, dark
text). So adding a new surface/border/text colour anywhere = use a `--c-*` token, never a literal. Vivid
accents (cyan/amber/red/pink/purple, white overlays, black shadows) are intentionally left literal — they
read on both themes. `--accent`/
`--accent-glow`/`--cursor-border` are inline-set per selected instrument in main.ts (override both
themes) → they stay the instrument's colour regardless of theme. The pan-slider + mute-badge colours
in tracker-view.ts are still hardcoded (read acceptably on both); convert to vars if they ever clash.

### Piano (Pipi) realism overhaul + per-engine `fxDefaults` — ✅ DONE (1.34.0, 2026-06-16) — `project`
`synth-pipi.glsl` model upgraded (user asked "improve the piano", chose "just make it better" =
global sound change; existing songs using pipi now sound different/better — accepted): (1) partial cap
32→64 with **register-scaled** count (`regBoost = clamp(330/f0,1,4)`) so bass is rich, treble breaks at
Nyquist as before; (2) **phase**: partials start at phase 0 (**coherent strike**) — zero-start (no onset
click) and a defined percussive tone. DO NOT randomize partial phase: random `hash11`
phase makes it sound like a generic "synth strings/guitar" wash AND clicks (nonzero
partial starts) — tried that to fix chords in 1.34.5, was worse, reverted in 1.34.6. The
real chord fix is a few-cents **per-voice detune** (`vdet`) so stacked notes chorus
instead of phase-locking into harshness; (3) **1–3 string choir** (`strands` by f0: <110→1, <220→2, else 3)
with asymmetric detune + small constant per-string phase; (4) **soundboard body** formant bumps (~130/280
Hz Gaussians) + **key tracking** (`reg = log2(440/f0)/4`; bass longer/brighter, treble shorter/softer,
~centered at middle C). Verified: `glsl-check` ALL_OK + `render-check` pipi peak 0.77 NaN=0. **New reusable
hook:** `InstrumentDef.fxDefaults?: Partial<FxParams>` — flattering FX a freshly-`addInstrument`'d instance
starts with (merged over `neutralFxParams()`); only affects `+ Add`, NOT demos (they set `fxParams` per
type) or saved songs. Pipi ships reverb+EQ+comp+width defaults. Any engine can now declare `fxDefaults`.

### Guitar (Gigi) realism overhaul, same playbook as Pipi — ✅ DONE + shipped (1.35.0, 2026-06-16) — `project`
`synth-guitar.glsl` got the SAME treatment as the piano (user asked "improve the guitar synth",
chose all four): (1) **coherent pluck** — partials start at phase 0 (was random `hash11` phase, the
synth-strings-wash-+-click bug); (2) few-cents **per-voice detune** (`vdet`) so strummed chords chorus
instead of phase-locking; (3) **velocity→brightness** (`bright` folds tone+vel+reg into the rolloff);
(4) **register key-tracking** (`reg = log2(220/f0)/3`, anchored A3 for guitar range; bass longer + up to
2.5× partials, `GTR_MAXN` 32→48) + a 3-bump **soundboard body** (air ~100 / plate ~185 / wood ~400 Hz),
morphed in by `Body`. Added `fxDefaults` (EQ/comp/small room/width) + Jazz Box & Twangy Tele presets.
**Lead-instrument lesson (demo "Te amo …"):** an exposed synth melody reads "synthetic" no matter the
engine (user rejected dx7 FM → moog → wvt formant in turn). What actually fixed it: keep moog (saw-brass)
but add EXPRESSION — effect-column **vibrato `4xy`** on held notes (was smooth only on phase-accumulating
303/moog; now click-free on every pitched engine via `uPhaseOff` — see the effect-column section)
+ a softer/darker patch. Static + perfectly-tuned = synthetic; vibrato = "played". No real
brass sample exists in `public/samples/` (percussion + vocal chops only).

### Record button — live note + automation recording — ✅ DONE + shipped (1.33.0, 2026-06-16, user-verified in-browser) — `project`
Implemented in `src/ui/record.ts` (shared helpers) + wiring in `main.ts` (button→play, RAF
`tickRecord`), `input.ts` (keyboard), `midi.ts` (refactored onto the shared helpers), `controls.ts` +
`fx-panel.ts` (knob arm/record/disarm), `engine.ts` (`_armedTrack` field + `_applyAutomation` skip +
play/stop reset). All recording lands in `app.view.pattern` at `engine.displayRow` — which also FIXED a
latent bug where the old MIDI path used `currentPatternIdx` (wrong pattern during song-mode playback).
Arm model: `engine._armedTrack` set by `armForRecord(t, inst, held)` — a KNOB arm is `held`
(`_armUntil = Infinity`, cleared only on pointer-up via `disarmRecord`), a MIDI CC arm lingers
`ARM_LINGER_MS` (300ms) past the last message. `_applyAutomation` skips the armed track so the stored
data can't fight the live input; `_syncKnobs` also leaves the inst knobs alone while armed (else stale
`autoLive` yanks the knob away from the user's hand — that was the "feels unresponsive/jitter" bug).
Write model is **LATCH, not on-change**: `tickRecord` fills every row the playhead crosses with the
held byte (`_armLastByte`), so a continuous gesture leaves NO empty steps and cleanly overwrites old
data. (The earlier on-change + deferred sweep-erase approach DROPPED most values — by the time the
playhead left a row the "written row" marker had already advanced, so the row got erased. And the
300ms linger wrongly expired the *knob* arm mid-hold, letting the old track fight back. Both fixed by
latch + held-arm.) Latch is dense (a value per swept row); if a sparse/clean look is wanted later,
RLE-compress equal consecutive values to -1 holds on disarm (playback-identical). Possible future
polish: opt-in automation glide/ramp (interpolate between points on playback) and the sparse-RLE look.
Original spec below.

Spec agreed with the user 2026-06-16 (gameplan only; no code yet). The recording machinery
ALREADY EXISTS for MIDI (`ui/midi.ts`): note-on while `app._recordEnabled` writes at the playhead
(`engine.displayRow` when playing, else `cursor.row`) into `engine.currentPatternIdx`; CC writes to
the target's auto-track, creating it via `getOrCreateAutoTrack`. The record button (`main.ts:304-311`)
currently ONLY toggles `_recordEnabled` + a `.playing` class — nothing else hangs off it. The work is
to extend the same behavior to the record button, the computer keyboard, and the UI knobs:
- **Button starts playback** (`main.ts:306`): on enable, `if (!engine.playing) engine.play('song')`.
  If something is ALREADY playing (incl. pattern-loop), leave the mode as-is. Stop still disarms record.
- **Write target = follow the playhead** (`engine.currentPatternIdx` @ `engine.displayRow`); the editor
  view should auto-follow the playing pattern (check whether it already does).
- **Keyboard notes** (`ui/input.ts:75-86`): when `_recordEnabled && engine.playing`, write at the
  playhead and do NOT advance the edit cursor. Factor a shared `recordNoteAtPlayhead()` out of `midi.ts`.
- **Param knobs** (`ui/controls.ts:725` inst params, `ui/fx-panel.ts` fx): map `{bank,i}`/fx-key →
  `ParamTarget` (same `targetsForType` lookup MIDI uses) and record the normalized byte to that target's
  auto-track. Shared `recordParamValue()` helper with the CC path.
- **Arm + overwrite (no fighting)**: add `engine._armedTrack = {scope,targetInstIdx,paramId}|null`, set
  on knob `pointerdown`, cleared on `pointerup` (MIDI: armed while CC streams). `_applyAutomation`
  (`engine.ts:655`) SKIPS the armed track during the gesture so old data doesn't yank the param back.
  Writes happen ON CHANGE (sparse, like CC today), BUT while armed the RAF loop (`main.ts:660`, already
  watches `displayRow`) erases each newly-crossed row to `-1` so stale old values are deleted across the
  swept region — leaving a clean track of just the new gesture (holds carry each value forward). NB:
  grabbing-without-moving still erases the swept region while held.
- **Button styling** (`index.html:1456` + CSS `#record` at `index.html:373`): make the record button the
  SAME color as `#stop` by default (drop `class="primary"`; icon uses `currentColor` instead of the
  hardcoded `fill="#ff3b30"`), and turn the icon RED only when enabled (the `.playing` class on `#record`).
- Build order: (1) extract shared note/param record helpers from midi.ts (pure refactor) → (2) button→play
  → (3) keyboard notes → (4) param knobs → (5) arm/skip/erase. `npm run build` after each; audition
  in-browser (recording needs a real audio device — headless harnesses don't cover it).

### Pulse-width (PWM) on all four wave shapes — 303 + 888State — ✅ DONE — `project`
The user's "Varying Cycle Functions" Desmos idea: one duty-cycle knob warping EVERY
shape, not just the square. Implemented as a shared phase warp in `common.glsl`:
`dutyWarp(phase,duty)` stretches the first `duty` of the cycle onto the first half,
the rest onto the second half; `oscSawPW`/`oscTriPW`/`oscSinePW` feed the warped phase
through the existing shape funcs (square already took a duty arg). **Key property:
`dutyWarp(phase,0.5) == phase` exactly, so each `*PW` osc is bit-identical to its plain
version at 0.5** — existing patches + the golden render are untouched (verified: golden
fingerprint identical with/without the change).
- **303** (`i303` + `synth-303.glsl`): added `PulseW` at the previously-unused `p1.w`
  (paramDef + `PWM` autoTarget, so it's LFO/automation-targetable). Default 0.5. Shader
  reads `p1.w < 0.04 ? 0.5 : clamp(p1.w,0.04,0.96)` — the **legacy-0 → 0.5 sentinel** so
  old saved songs (p1.w==0) stay neutral. All i303 presets + defaults bumped 0→0.5.
- **888State** (`ie8e` + `synth-e8e.glsl`): already had a `PulseW` knob (p3.w) that only
  fed the square — now routed through `e8eOsc`'s sine/saw/tri too. Still NOT automatable
  (only p0/p1 are inst-scope automatable for this engine; out of scope).
- Saw warp BLEPs the true wrap (still phase 0, jump 2); the bend at φ=duty is a slope
  corner only, left un-BLEPed (mild, like the plain triangle). Acceptable for a synth.
- **Golden fingerprint is now `0x549f6e7e`** (logged, NOT asserted — the harness only
  checks render-vs-render determinism + no-NaN). The many `0x5fc60c89` mentions below are
  STALE fingerprints from older entries; the value drifted as the audio path grew. Don't
  treat a fingerprint change as a failure — only a determinism/NaN break is.

### Note-delay effect column command (1.25.0; re-scoped 1.25.1) — ✅ DONE — `project`
Built 2026-06-15. New effect-column command `FX_NOTE_DELAY = 0x5` (key '5'): pushes a note's attack
later WITHIN ITS OWN STEP by `val/255` of ONE row — for **swing and humanized "drunken" timing** (0x00
on the beat, 0x80 half a step, 0xFF ≈ a full step). **NOTE the re-scope:** the first cut (1.25.0)
delayed by the interval to the *next note*, which the user found wildly too long (a 0x80 delayed ~8
notes). Corrected to one step (1.25.1) — that's what swing/humanize need. The `_rowsToNextNote`
lookahead + `_trigRow` field were deleted; the interval is now just `this.samplesPerRow`.
**Unlike the slide/vibrato effects it is a SCHEDULER effect, not a `_modulateVoices` one** — it lives in
the trigger path. Design: `engine._pending` queue `{frame, ch, note, inst, vol}`; `_applyCell`
(FX_NOTE_DELAY branch) pushes `{frame: rowFrame + delay}`, `delay = min(round(frac*row),
round(row)-1)` (cap keeps 0xFF under one step). `advance` fires pending via `_firePendingUpTo(limit)`
(sorted, frame-ordered) — interleaved before each row in the while-loop and once more up to blockEnd —
so a deferred trigger fires sample-accurately even in a LATER block (a half-step ≈ 3000 samples ≈ 6
blocks). The voice keeps playing its previous note until the deferred trigger (the delayed note slots
into the gap). `_pending` cleared on play/stop/pause (absolute frames go stale on resume re-anchor). 5
logic tests in `test/logic/note-delay.test.ts` drive real `engine.advance`. golden checksum UNCHANGED
(no demo uses it → `_pending` empty → added calls are no-ops). Docs: README effect table + COMPOSING
Pattern API + in-app help (PATTERN_FX auto-derives from FX_CMDS; "0–5 · A" hints).


### Vocoder — ✅ DONE (1.22.0 v1; intelligibility 1.23.0; formant shift 1.24.0) — `project`
Built 2026-06-15 (Opus 4.8). The SECOND attempt — Gemini's 2026-06-09 attempt was a disaster (see
below); this one designed out all four failure modes from the start and shipped clean. **Verified:**
`test/vocoder-check.html` (NEW) matches a CPU SVF-bandpass-bank + envelope reference to **9.7e-7**
across a 16-block stream (proves the strip loop + BOTH filter-state textures + the envelope carry
bit-continuously), confirms envelope tracking (silent modulator → output decays to <2% within
release), stability at 16 bands / Q=16 (finite, clamp holds), and transparent bypass (both `vocoderOn:
false` AND `vocSource:-1`). glsl-check compiles both shaders; **golden-render checksum UNCHANGED
(0x5fc60c89)** (off-by-default = bit-transparent); render-check + 45/45 logic green. Scope was
lean-classic (formant shift + unvoiced passthrough deferred — additive later).

Implemented exactly as the design below. Files: `src/gl/shaders/fx-vocoder.glsl` (analysis/synthesis)
+ `fx-vocoder-sum.glsl` (band sum + dry/wet); `fxVocoder` in `effects.ts` (own bandFbo + 2 state
ping-pongs + dedicated band-aware strip loop); FxParams `vocoderOn/vocSource/vocBands/vocQ/vocAttack/
vocRelease/vocMix`; automation `VCO/VCB/VCQ/VCA/VCR/VCM` appended at end of TARGETS; FX panel Vocoder
card (Source knob reuses the compressor's instance-name formatFn, -1 shows "Off"); `_on()` opt-in +
neutralFxParams off. **Modulator unit = 5** (units 3/4 are the permanently-bound wavetable/sampler
atlases — clobbering them breaks wvt/sampler on the next block; this was the unit-binding trap to
avoid). Fixed makeup `uLevel=2.0` + clamp(±4) explosion guard in the sum shader. No song-io change
(`{...i.fx}` persists new keys; opt-in `_on` + `??` fallbacks make older songs safe).

**Intelligibility pass (1.23.0, 2026-06-15):** user said the v1 was "a bit unintelligible" — the
classic channel-vocoder result. Three fixes: (1) defaults retuned — `vocBands` 8→**16** over a
speech-focused **180 Hz–7.5 kHz** range (at 8 bands the constant-Q bandwidth left GAPS between band
centers that swallow formants; 16 bands cover gap-free at Q≈4), faster default envelope (attack 2 ms,
release 18 ms). (2) **Unvoiced/sibilance passthrough** — consonants (s/t/f/sh) are broadband noise a
tonal carrier physically can't voice, so they smear. Added as ONE extra texture row (index = `uBands`,
texture height now `MAX_VOC_BANDS+1`) reusing the same strip+MRT state machinery: that row splits the
modulator with two 1st-order TPT low-passes (700/3500 Hz), follows HF vs LF energy, and emits the
modulator's gated high-passed signal; the sum pass mixes it in × `vocUnvoiced` (new param, default 0.5,
target `VCU`). Verified: noise modulator → ×6.4 output energy (gate opens), pure 200 Hz tone → ×1.000
(gate stays shut) — clean voiced/unvoiced discrimination. (3) Docs: COMPOSING.md notes the carrier MUST
be bright (saw/pulse/e8e/bright-wvt; a sine has no highs → silent upper formants). golden checksum
still 0x5fc60c89 (off by default); vocoder-check still matches the CPU band ref to 1.2e-6 (with
`vocUnvoiced:0`, since the ref models voiced bands only).

**Formant shift (1.24.0, 2026-06-15):** shifts the formant peaks up/down WITHOUT changing pitch (pitch
= the carrier's note). Mechanism: the band bank already separates the modulator's envelope per band, so
formant shift = drive synthesis band b with the envelope of band `b − offset`. The bank is LOG-spaced,
so a constant frequency ratio is a constant band-index offset: `bandsPerOctave = (bands-1)/log2(fHi/
fLo)`; `vocFormant` (semitones, ±12, target `VCF`) → offset = (st/12)·bandsPerOctave. Implemented by
DECOUPLING analysis from synthesis: the analysis shader now emits `(carrierBandL, carrierBandR, env)`
per band row (instead of pre-multiplying), and the SUM shader does `carrierBand[b] · env[b−offset]`
with linear interp between the two nearest source bands, clamped at the edges. Resolution is bounded by
band count (16 bands ≈ 0.36 oct/band) so big shifts smear; ±7 st is the musical range. Verified:
neutral peak at F0, +12 st moves the output spectral peak to ~2·F0 (probe energy ratio 1.66 → 0.35);
match test still 1.2e-6 at `vocFormant:0` (decoupled product is bit-equivalent within f32). golden
checksum unchanged. **Lean-classic vocoder is now feature-complete** (formant shift was the last
deferred item).

Original agreed design (kept for reference): scope locked **lean-classic v1**.

**What it is:** a channel vocoder. Carrier = the effect's insert signal (`uIn`, the instance's own
dry). Modulator = the **sidechain dry bus** (`instDryTex`/`uKeyTex` at `uKeyRow`) — the EXACT
mechanism the sidechain compressor uses, so a `vocSource` param picks the modulator instance just like
`compSource`. Zero new renderer plumbing for the modulator (the 1.18.2 two-pass fill already populates
the whole bus before any FX, so it keys off any instance < INST_DRY_ROWS regardless of chain order).

**THE ARCHITECTURAL CRUX — state budget.** 16 bands × ~7 floats state each (carrier SVF stereo 4 +
mod SVF mono 2 + env 1) ≈ 112 floats. The shared `_recursive` carries only ONE RGBA texel (4 floats)
in a BLOCK×1 state texture → CANNOT reuse it; MRT attachments (≥4 guaranteed) don't fit either. **Use
the reverb-FDN pattern: run bands as texture ROWS.** Render a `BLOCK × N_BANDS` intermediate where row
b = band b; each row runs its own bandpass + envelope with its own state texel. Per band 2 state
texels: `stateA=(ic1L,ic2L,ic1R,ic2R)` carrier SVF, `stateB=(ic1mod,ic2mod,env,–)`. MRT = outColor +
2 state attachments = 3 total (within the WebGL2 min).

**Two passes:** (1) `fx-vocoder.glsl` — per-sample recursive in FX_SUB strips, viewport BLOCK×bands;
fragment (x,b) advances band b's carrier SVF + mod SVF+env from the strip checkpoint, outputs
`carrierBand(x)*env(x)` stereo into `bandTex.rg`. Reuses the TESTED TPT-SVF BP-tap from fx-filter.glsl
+ the one-pole envelope from fx-dynamics.glsl. (2) `fx-vocoder-sum.glsl` — non-recursive BLOCK×1,
`sum_b bandTex(x,b)` → wet, `mix(dry, wet*level, vocMix)`. Vocoder owns its PRIVATE bandFbo (only
multi-attach FBO) + state ping-pongs in init; shared scratch FBO never left multi-attached. Needs its
OWN band-aware strip loop (not `_recursive`, which is 1-row/1-state-attachment).

**Four-failure-mode defenses (map to the disaster entry below):** (1) state leak — render to private
bandFbo, then DETACH attachments 1&2 + `drawBuffers([0])`; bypass = clean O(BLOCK) dry passthrough at
unit 0 only; reset() clears all state → deterministic export. (2) missing coeffs — per-band coeffs
computed CPU-side per block (log-spaced ~120 Hz–8 kHz), uploaded as `uG[16]`/`uK[16]`; nothing
implicit. (3) unnormalized → 113× clip — use the normalized SVF BP tap (k=1/Q), moderate default Q for
~−3 dB band overlap, output level trim + recommend the chain limiter + safety tanh on the sum. (4)
uKeyTex unbound — explicit units every block (0=carrier,1=stateA,2=stateB,3=modulator bus), sampler
uniforms set in init.

**Plumbing:** new `fxVocoder` in FX_EFFECTS (append; order/defaults derive); add `vocoderOn` to the
`_on()` opt-in truthy group (defaults OFF → existing songs bit-identical). FxParams: `vocoderOn,
vocSource(-1), vocBands(8, max 16), vocQ, vocAttack, vocRelease, vocMix`. Automation targets appended
at the VERY END of TARGETS (id-stability): VCO(toggle)/VCS/VCB/VCQ/VCA/VCR/VCM; VCS reuses the
compressor instance-name formatFn. UI vocoder card (Source knob max INST_DRY_ROWS-1). neutralFxParams
sets vocoderOn=false. COMPOSING.md author entry.

**Verify:** new `test/vocoder-check.html` (CPU bandpass-bank+env reference to ~1e-5; finite output;
envelope tracking; bit-continuity across strip/block boundaries; transparent bypass), glsl-check
compiles both shaders, golden-render checksum UNCHANGED (0x5fc60c89, off-by-default), npm run build.
**Perf note:** SwiftShader validates correctness not speed; 16 bands as parallel rows is fine on real
GPU, default bands=8.

**Gotcha — audible modulator:** the modulator instance still plays in the mix (vocoder can't mute
another instance's chain). User sets that instance's master/pan low. Note in docs; "mute source"
deferred.

### Undo/redo + IndexedDB song persistence — ALL PHASES DONE — `project`
**STATUS (2026-06-08):** COMPLETE. Phase 0+1 (undo/redo) in 1.15.0; Phase 3+4 (lifecycle + custom
song-list panel) in 1.16.0; storage backend migrated localStorage→IndexedDB+gzip in 1.17.0. Build
green, 44/44 logic tests, headless smoke-load clean (picker builds all demo rows, no console errors).
- **Phase 3+4 shipped (1.16.0):** `currentSong: {kind:'demo',demoIdx} | {kind:'user',id}`
  replaced `currentSongIdx`/`customSongName`-as-identity/magic `-1` `<option>`. `songDisplayName()`
  is the one name resolver (used by snapshot, song-info field, export). **Autosave:** debounced
  1.5 s off the markDirty chokepoint, USER songs only; flushed on `beforeunload` +
  `visibilitychange:hidden`; one-time console warn + `#audio-status` title on quota failure.
  **Demo→fork:** first CONTENT-tagged edit on a demo mints `"<name> (edit)"` (honours a typed
  rename instead of appending), switches identity to a user record, persists, refreshes picker;
  tweaks on a demo are undoable but DON'T fork/persist (they ride along once a content edit forks).
  **New** mints a fresh user record (`_uniqueUntitled()` → "Untitled"/"Untitled N"), never replaces.
  **File load** (`_loadSongFile`) now mints a user record too (imports join the library + autosave).
  `_applySerializedSong` is identity-agnostic (caller sets currentSong first).
- **Custom song-list panel** replaced the native `<select id="song-select">` (Safari/macOS can't
  colour options or host inline buttons). `#song-picker` = trigger button (`#song-picker-current`
  label) + a `position:FIXED` menu (`#song-picker-menu`) — fixed, NOT absolute, because the
  `.lcd-display` ancestor is `overflow:hidden` and would clip an absolute dropdown; JS positions it
  from the trigger's bounding box on open. Rows: MY SONGS group (vivid first-instrument colour dot +
  inline 🗑 delete-with-confirm, active-song fallback→default demo) then DEMOS group (uniform muted
  `#5a6b86` dot). All picker/lifecycle methods live on `App` (`_initSongPicker`/`_buildSongPicker`/
  `_toggleSongMenu`/`_closeSongMenu`/`_loadDemo`/`_loadUserSong`/`_deleteUserSong`/`_forkDemo`/
  `_scheduleAutosave`/`_autosaveNow`/`_uniqueUntitled`). GOTCHA fixed: deleting the OPEN song must
  switch currentSong OFF it BEFORE the fallback `_loadDemo` (whose opening `_autosaveNow` would else
  resurrect the just-deleted song).
- **Storage backend = IndexedDB + gzip (1.17.0).** `src/tracker/song-store.ts` rewritten from the
  Phase-2 localStorage version to IndexedDB. Rationale: disk-scale capacity (vs ~5 MB), async writes
  off the main thread, native binary storage (so bodies are gzipped + the future sampler can store
  audio Blobs here). Design: two object stores — `meta` (tiny {id,name,color,createdAt,updatedAt},
  ALL read into an in-memory `Map` at `init()`) and `bodies` ({id,gz,data}; data = a gzipped
  `ArrayBuffer` via CompressionStream, or raw string if unavailable). The key async/sync split:
  `list()/has()/createId()` stay SYNCHRONOUS (read the cache) so the picker/`_uniqueUntitled` didn't
  change; only `init()/load()/save()/delete()` are async. `save()` updates the cache synchronously
  (immediate UI) then writes IDB (rolls the cache back on failure). `load()` prunes a stale meta
  entry whose body vanished. `close()` added for test teardown. Degrades to a no-op store (init
  catches a failed open → `db=null`) in sandboxed/private contexts. NO localStorage migration (user
  was the only user, nothing to migrate — explicitly skipped).
  - **App wiring for async:** `store.init().then(() => _buildSongPicker())` in the ctor (picker first
    renders demos-only, then the MY SONGS group appears a tick later). `_loadUserSong` is now `async`
    (`await store.load`). `_autosaveNow` captures id+snapshot synchronously then fires `store.save(...)
    .then(...)` (so a background write is correct even if currentSong changes first). `_deleteUserSong`
    relies on `delete()` updating the cache synchronously.
  - **GOTCHA — `beforeunload` can't await an async IDB write.** The reliable flush is
    `visibilitychange:hidden` (fires on tab-switch/close and CAN complete); the `beforeunload` call is
    a best-effort backstop. Worst case ~1.5 s (the debounce) of edits lost on a hard kill — accepted.
  - **TS note:** store gzipped bodies as `ArrayBuffer` (clean `BlobPart` + structured-cloneable), NOT
    `Uint8Array` — the latter trips the newer lib's `Uint8Array<ArrayBufferLike>` ≠ `BlobPart` check.
  - **Tests:** `fake-indexeddb` (devDep) polyfills global indexedDB for the node suite; `import
    'fake-indexeddb/auto'` at the top of `song-store.test.ts`. Node 24 has CompressionStream so the
    gzip path runs for real. 8 store tests (round-trip-through-gzip, sync-cache, re-save, newest-first,
    persist-across-reopen, delete, stale-body prune, unavailable-degrade). 44/44 total.
  - The file Save button stays as the .json export path alongside the implicit IDB persistence.
- **Phase 2 shipped:** `src/tracker/song-store.ts` — `SongStore` class with an INJECTABLE
  backend (`KVStore`; defaults to `localStorage`, guarded for sandboxed contexts; tests pass an
  in-memory stand-in → runs under node). Layout: `shaderwave:songs:index` = `UserSongMeta[]`
  (id/name/color/createdAt/updatedAt, read once on boot) + `shaderwave:song:<id>` = minified
  `SerializedSong` body (read only when opened) — so listing N songs doesn't parse N×~300 KB.
  API: `available/createId/list (newest-first)/has/load (validates via deserializeSong, prunes a
  stale index entry whose body vanished)/save (upsert: preserves createdAt, bumps updatedAt,
  dedups, quota-safe with rollback so no orphan body)/delete`. 8 tests in
  `test/logic/song-store.test.ts`. NEXT: Phase 3 wires it (autosave off the markDirty chokepoint;
  demo→fork on first content edit; New mints a record) — that's where the deferred
  `currentSong={kind,id?,demoIdx?}` model gets introduced.
- **Shipped:** `src/tracker/history.ts` (`History`: past/future snapshot stacks, `reset`/
  `push`/`replacePresent`/`undo`/`redo`, cap 60). App gained `_snapshot()` (factored out of
  `_saveSong`, the single source of truth), `markDirty(tag, coalesce)`, `_seedHistory()`,
  `_undo/_redo`, `_restoreSnapshot()` (NON-pruning: rebuilds via `instrumentsFromParams` +
  `patternFromSerialized` + `loadSong`, preserves cursor/scroll/pattern/selected-inst clamped,
  leaves playback STOPPED like a file load). Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y; Undo/Redo
  buttons in the header (`#undo-btn`/`#redo-btn`, disabled-state synced). `_seedHistory()` on all
  4 full-load paths (initial ctor, song switch, New, file load). markDirty wired into EVERY
  mutation site (note/OFF/clear/vol-nudge/auto-cell/inst-vol-digit/fx-col/cut/paste, pattern
  add-dup-del-resize, order add + arranger up/down/remove/select, bpm/master/meta on COMMIT,
  fx knobs+toggles+reorder on commit, LFO source+routing on commit, preset, add/remove instrument,
  param knobs via bindKnob onCommit, pan + auto-track-remove via new `TrackerView.onEdit(tag)`,
  MIDI note/CC record). Streaming gestures pass `coalesce:true` (450 ms window, same tag) so a
  knob drag / two-digit entry / CC stream = ONE step; discrete edits push immediately. A
  `_restoring` guard makes markDirty a no-op while a restore applies. Pattern-delete confirm text
  changed from "can't be undone" → "(Ctrl+Z to undo)".
- **Continuous controls markDirty on COMMIT, not per-move** (knob `onCommit`, range-input
  `change`, text-input `change`) — never on `input`/pointermove — so we don't serialize the whole
  song 60×/s. Discrete keystroke edits serialize per keystroke (cheap enough at human speed).
- **DEFERRED to Phase 3 (intentional):** the `currentSong = {kind,id?,demoIdx?}` model. Undo
  needs none of it; it only matters for the fork/persistence/list, so it's introduced there to
  avoid building unused fields now. `currentSongIdx`/`customSongName`/magic `-1` option still stand.

Agreed 2026-06-08 with the user. The #1 roadmap gap (undo) plus a real persistence layer.
**Linchpin:** `serializeSong(SongIOInput)` already captures the WHOLE editable document and
`_applySerializedSong()` already restores it (today only to/from a downloaded file) — so both
undo and persistence reuse that one round-trip as snapshot/restore. No new serialization needed.
Today there is NO dirty flag, NO change events, and NO localStorage use anywhere (verified).

**Decisions locked:**
- **Whole-document undo** (snapshot-based, with COALESCING so a knob drag / held-key run is one
  step, not 200). Cap stack (~50). Store lightweight cursor/scroll/selected-inst alongside.
- **Custom dropdown panel** for the song list (NOT native `<select>` — Safari/macOS ignore option
  colours and it can't host inline delete). Colored rows: demo vs user tint + inline 🗑 on user rows.
- **Only CONTENT edits fork a demo** into a `"<demo> (edit)"` user song. *content* = touches patterns
  or the instrument set/order (note/fx-col/automation entry, clear, pattern add/dup/del/resize,
  copy-paste, add/remove instrument, order edit, metadata rename). *tweak* = param knobs, fx params,
  fx-order, bpm, master, pan, LFO/mod-routing. A tweak on a demo is undoable in memory but does NOT
  fork or persist on its own; once a content edit forks (or you're on a user song) tweaks ride along.

**Build sequence:**
0. Foundation (no behavior change): extract `snapshot()`/`restore()` from `_saveSong`/
   `_applySerializedSong` (main.ts:820/864); replace `currentSongIdx`/`customSongName`/magic `-1`
   option with `currentSong = {kind:'demo'|'user', id?, demoIdx?}`; add ONE `markDirty(kind)`
   chokepoint and wire EVERY mutation site (tag content vs tweak). Mutation sites enumerated:
   pattern.set/clear/setFx + autoTracks (main.ts ~1067/1150/1192/1237), pattern add/dup/del/resize
   (~1797/1810/1629/553), copy-paste (~1356), knob onChange (controls.ts:747 / main.ts fx knobs ~423),
   add/removeInstrument (engine.ts:381/398), bpm/master/pan/order/lfo/metadata (main.ts ~540/584/720).
1. Undo/redo on markDirty+snapshot. CRUX: restore via the NON-PRUNING serialized path (NOT
   `loadSongInstruments`, which prunes unused instruments → a just-added note-less instrument would
   vanish on undo), and through the existing transient reset (autoLive/panAuto/vd.master/LFO bases).
   Ctrl/Cmd+Z, Shift+Z. Retires the "can't be undone" pattern-delete confirm.
2. `src/tracker/song-store.ts` localStorage CRUD: cheap index key `shaderwave:songs:index`
   (`{id,name,color,updatedAt}` read on boot) + per-song body `shaderwave:song:<id>` (minified
   SerializedSong). Quota-safe (try/catch QuotaExceededError). Song ≈250–320 KB → ~15 fit in 5 MB;
   IndexedDB is the escape hatch.
3. Lifecycle: debounced autosave (~1.5 s, USER songs only) off the markDirty chokepoint + flush on
   beforeunload/visibilitychange; demo→`(edit)` fork on first CONTENT edit; "New" ALWAYS mints a fresh
   record (multiple News = multiple records — replaces today's single reused `-1` option).
4. Custom song-list panel: boot-load DEMO_SONGS + listUserSongs(); colored demo/user rows; inline
   delete + confirm with active-song fallback (blank/New). Keep the file Save button as "Export".

### ✅ LFO tempo-sync phase bug under BPM changes — FIXED + committed (1.10.4, e83f6e4) — `project`
FIXED: `engine._songBeats` accumulator (reset in `play()`, advanced per block at the end of
`_applyLfos` by `(BLOCK/sampleRate)*(bpm/60)`); synced sources now use `cyclePos = _songBeats /
rateBeats`, free-run keeps `songSec / lfoPeriodSec`. The continuity test is now COMMITTED in the
logic suite (`test/logic/lfo.test.ts` — drives `_applyLfos`, doubles BPM mid-render, asserts no
phase jump; verified it fails on the pre-fix form). Original analysis below.

Found 2026-06-08 (user spotted it). **Tempo-synced LFOs glitch when BPM changes mid-song.**
`engine._applyLfos` computes phase as `songSec / lfoPeriodSec(src, this.bpm)` where
`songSec = (blockStart - startFrame)/SR` (elapsed wall-clock) and synced period = `rateBeats*60/bpm`.
So `cyclePos = songSec·bpm/(rateBeats·60)` — a BPM change **retroactively rescales the whole elapsed
timeline** → the synced LFO's phase jumps (click/lurch). This is EXACTLY the trap the row clock was
fixed for (advance(): "never retroactively rescales the elapsed timeline"; steps `_nextRowFrame +=
samplesPerRow`). Free-run (Hz) LFOs are unaffected (period has no bpm; songSec stays continuous).
Constant-BPM songs (incl. La Mesa) unaffected — latent until BPM automation + a synced LFO coincide.
Deterministic but wrong at the seam (so "deterministic for export" was true-but-oversold).

**FIX:** accumulate phase in BEATS (integrate tempo per block), like the row clock:
- Add `this._songBeats` (number), reset to 0 in `play()` (next to the other resets).
- In `_applyLfos`, AFTER processing this block's routings, advance once per block:
  `this._songBeats += (BLOCK / this.sampleRate) * (this.bpm / 60);` (uses the post-automation bpm;
  block-granular tempo application is fine + deterministic).
- For SYNCED sources: `cyclePos = this._songBeats / Math.max(1e-3, src.rateBeats);`
  For FREE (Hz) sources: keep `cyclePos = songSec * src.rateHz` (or songSec / (1/rateHz)).
- So split the per-routing phase calc by `src.sync` instead of dividing songSec by lfoPeriodSec.
- **Test (headless esbuild+node):** play a song with a synced LFO on an inst param, render blocks,
  flip `engine.bpm` mid-render, assert the LFO offset has NO discontinuity at the seam (delta between
  adjacent blocks stays within the smooth per-block step). Build green; no shader/GPU change.

### Roadmap / next-steps (prioritized, agreed 2026-06-08) — `project`
Honest assessment of what the project most needs (beyond the parked plans below). Suggested order:
1. **Undo/redo** — the biggest UX gap. None today (only a "can't be undone" confirm dialog). A
   creative tool others will use needs it; even coarse per-pattern / whole-song snapshot stack is
   enough to start. Top priority for "a toy others use".
2. **Per-sample recursive processing in the FX chain** — ✅ DONE (1.13.0). The capability + the
   resonant multimode filter both shipped. See the dedicated entry below ("Per-sample recursive FX +
   resonant filter"). This unlocks the compressor/limiter (#4) — they reuse the same strip/MRT state
   carry for their envelope follower.
3. **Committed test suite** — ✅ SEEDED (1.11.0). `npm run test` bundles `test/logic/index.ts`
   (esbuild+node) and runs the harness in `test/logic/_harness.ts`: LFO invariants incl. the BPM
   continuity regression, mod matrix, automation id-stability + norm/denorm, song-io round-trip +
   version gate, demo-song load loop + target-range/type audit (21 tests). PLUS `test/golden-render.html`
   (headless GPU) — renders a fixed song twice for bit-identical determinism (checksum 0x5fc60c89)
   AND, when `renderBlockAsync` exists, asserts `async[n]==sync[n-1]` bit-for-bit (the async-readback
   guard). The two earlier TODOs are now folded in (1.29.x, `effects.test.ts` + `bitcrush.test.ts`,
   57 tests): **new-instrument fx defaults** — `neutralFxParams()` zeroes EVERY `FX_EFFECTS` enable
   flag (registry-derived, so a future effect that defaults-on is caught) + same key set as
   `defaultFxParams()`; **bitcrush continuity** — a CPU model of the two `fx-bitcrush*.glsl` integer
   windowing shaders asserts blocked decimation is bit-identical to single-pass (block-alignment
   independence — the property the cross-block carry exists for) and that the no-carry fallback
   diverges (so the test can fail). The real GPU shader stays covered by `golden-render.html`; the
   CPU model mirrors the .glsl line-for-line — keep them in sync. The HTML harnesses
   (glsl/render/onset/instance/drum) remain the GPU-correctness net.
4. ✅ DONE (1.14.0) — **compressor + transparent limiter** (shared per-sample envelope follower via
   `_recursive`) + **reorderable per-instrument chain** (▲▼ in the FX panel, `fxOrder` per instance).
   See the dedicated entry below.
5. **Async readback** (PBO + `fenceSync`) — ✅ DONE (1.11.0). `SynthRenderer._renderToMix()` does the
   synth+mix passes; `renderBlock()` keeps the SYNCHRONOUS readPixels (offline WAV export + all test
   harnesses use it as ground truth — offline wants exact full-length output, no main-thread-stall
   concern). NEW `renderBlockAsync()` is a pipelined "render N, read N-1": readPixels into a ping-pong
   PBO (offset 0 → async DMA) + `fenceSync`, then `getBufferSubData` the PBO filled LAST call (its DMA
   had a full block to finish → no stall). The realtime producer (`main.ts` ensureAudio) uses it; this
   is what removes the per-block GPU→CPU main-thread stall (the portability ceiling). COST: +1 block
   (~10.7ms @48k) of constant output latency; first call returns silence (priming); `resetState()`
   drops pending fences so the next async call re-primes. Could claw the block back via a -1 prebuffer
   trim (not done — left as an underrun-safety judgment call). Verified bit-identical via golden-render.
6. **EQ** + **sidechain/pumping compression** — ✅ DONE (1.18.0). Crossover Linkwitz-Riley 3-band EQ recursive shader (fx-eq.glsl) and multi-instance dry-buffer (instDryTex) sidechain routing to compressor (uKeyTex/uKeyRow) implemented and test verified.
Push-back to honor: resist adding more synth engines / demo songs until undo + tests exist — the
synth palette is already wide; forgiving (undo) + not-breaking (tests) matter more than a 12th engine.

### GPU sampler engine (v1) — ✅ DONE (1.19.0) — `project`
Built 2026-06-09. A GPU-based PCM sampler implemented using a shared `samplerTex` atlas (R32F, 4096×4096, unit 4).
- **Atlas layout:** Supports up to 16 slots. A `syncSamplerSlots` method densely packs active sampler instances into the atlas before playback, uploading up to 1,048,576 frames (4096×256) per slot.
- **Shader (`synth-sampler.glsl`):** Closed-form, non-recursive rendering. Calculates fractional playback position with rate = noteFreq / rootFreq, using bilinear interpolation across row bounds to read seamlessly from the 2D atlas.
- **Features:** One-shot or forward loop modes, ADSR envelope (`p0`/`p1` params). Tiling boundary checks ensure cross-row interpolation is artifact-free.
- **Persistence (`song-io.ts`):** Samples persist in the `SerializedInstrument` structure by encoding mono `Float32Array` PCM into an `Int16Array` and converting to Base64. Reconstructs and resamples automatically on load.
- **UI (`controls.ts`):** Custom sampler panel triggers a native `<input type="file" accept="audio/*">`, decodes via `AudioContext` and truncates/resamples to `ENGINE_SR` if necessary. Exposes `rootNote`, `loopMode`, `loopStart`, and `loopEnd`.
- **Future wow (Granular):** The foundational atlas and addressing math are now in place. Future iterations can add time-stretch, granular spray, and LFO mod-matrix integration for the playhead.
- **URL-referenced samples (1.20.0):** presets AND demo songs can ship a sample by **URL** instead of embedded PCM. `SampleData.url?` + an empty `pcm`; `App._hydrateSampleUrls()` (called after every song load) fetches/decodes via the shared `src/audio/sample-loader.ts:decodeSampleUrl` and re-syncs the atlas (sound pops in async, never marks the song dirty). **Gotcha fixed:** `instrumentsFromParams` previously dropped `sample` entirely — it now copies it (via `cloneSample`), so sampler-in-song actually works (saved songs too). Demo authoring helper: `smp(name, slug, rootNote?)` in `demo-songs.ts`. Built-in sample files live in `public/samples/*.ogg` (all OGG since 1.20.0; mono, peak-normalized). First demo to use it: **"Larynx Yard Sale"** (DVS CC0 vocal shouts + melodic kalimba sampler).

### Playback library extraction — future goal — `project`
Goal: a headless PLAYBACK LIB so a song composed/saved in ShaderWave plays in another project (npm
package). The audio CORE (engine, synth-renderer, effects, instruments, audio/pipeline, song-io +
shaders) is already largely separable from the EDITOR (main.ts, ui/, tracker-view, controls). Implies:
- **Formalize the core↔editor boundary** (core must never import `ui/`). Define a small public API:
  `createPlayer(gl|canvas, songData) → { play, stop, renderBlock, seek, … }`.
- **GL/audio-context ownership:** decide whether the lib creates its own offscreen WebGL2 +
  AudioWorklet or accepts them from the host (offscreen-owned is friendlier to embed).
- **Stable, portable song format** (see format notes) + the append-only automation-id concern
  matters again once the format is shared across projects/versions (consider stable string keys).
- **Packaging:** importable without the editor (tree-shakeable); shaders bundled via the same
  `?raw`→text path; verify headless.

### Save/load format evolution — notes — `project`
JSON was chosen for ease, NOT committed to (user is open to changing it). Guidance for when we
revisit (esp. with samples + the playback lib needing compact, portable files):
- **Binary layout** for structural data — patterns/automation are Int16Array; pack them directly
  (far smaller than JSON number arrays). Versioned header + sections.
- **Free, broadly-supported size win:** wrap the blob with `CompressionStream('gzip')` on save /
  `DecompressionStream` on load — no codec, big savings on repetitive pattern/automation data.
- **Samples:** browsers DECODE mp3/ogg/opus/flac (`decodeAudioData`) but have **no universal built-in
  ENCODER** → DON'T re-encode; **store the user's original compressed file bytes** + decode on load.
  Sidesteps the encoder problem and keeps files small.
- **NOT GPU texture compression for audio:** ASTC/ETC/S3TC are lossy in ways perceptually tuned for
  IMAGES, not waveform precision — they'd mangle audio. Wrong tool. (A WASM Opus/FLAC encoder is the
  only path if we ever must re-encode raw PCM, but storing original bytes avoids needing one.)

### Compressor + transparent Limiter (two effects, shared envelope core) — ✅ DONE (1.14.0) — `project`
(Implemented — see "Compressor + Limiter + reorderable chain (1.14.0)" above. Design notes kept below.)
Agreed 2026-06-08, build later. Decided to make them **two SEPARATE effects** (separate chain
slots/toggles/params) — different roles + different ideal placement (comp early-ish for glue,
limiter dead last as an output ceiling), which the reorderable-chain feature (below) unlocks.
**Transparent limiter** chosen (not a clipper), because this is meant as a toy others will use.

**The hard part (new to the FX chain):** a compressor/limiter needs a RECURSIVE envelope
follower (attack/release one-pole) — sample-to-sample feedback the FX chain has never done
(only the synth ladder does, via strip rendering + MRT state). Build a **shared envelope-core
helper**: stereo-LINKED detection (`max(|L|,|R|)` or summed RMS → ONE gain applied equally to
both channels, for stereo integrity), attack/release smoothing, gain-ramped WITHIN the block
(prev→current) to avoid zipper, 1-texel state carry (the bitcrush ping-pong pattern), cleared
on play/stop → deterministic for export.

- **Compressor:** params Threshold, Ratio, Attack, Release, Makeup (+ optional Knee). **Block-
  rate envelope is adequate** (comp time-constants are ≥10 ms anyway) → fits today cheaply.
- **Limiter (transparent):** shares the core, defaults to ∞ ratio + fast attack + Ceiling +
  Release. **CRUX/OPEN DECISION:** a transparent brick-wall needs FAST attack, but block rate
  is ~11 ms → peaks leak for up to a block. Two ways to fix, decide at build time:
  (a) **lookahead** — delay the audio a few ms via a small ring buffer (FX chain already does
  rings for delay/chorus) so a block-rate envelope ducks BEFORE the peak; or
  (b) **per-sample strip rendering** in the FX chain — NO LONGER a big lift: `EffectsChain._recursive`
  (shipped 1.13.0 for the filter) IS this mechanism. An envelope follower can use it directly (state
  texel carries the envelope across strips/blocks). **Revised lean: (b) is now the clean path** — reuse
  `_recursive`; fall back to lookahead (a) only if a sample-accurate detector still isn't tight enough.
- Both: automation/LFO targets + stomp-box toggles for free (registry); placement comp-early /
  limiter-last by default, fully movable once the chain is reorderable.
- **Gotcha reminder:** add the new enable flags (`compOn`,`limitOn`) to the `_on()` truthy group
  in effects.ts so they default OFF for partial-fx songs (see Overdrive entry).

### Reorderable per-instrument effect chain — ✅ DONE (1.14.0, "feature c") — `project`
(Implemented — see the 1.14.0 entry above. Design notes kept below.)
Agreed 2026-06-08, build later. Make the FX chain ORDER editable + per-instrument-instance
(currently `EffectsChain.order = DEFAULT_FX_ORDER.slice()`, fixed + identical for all).
- **Data model:** add `fxOrder?: string[]` to `InstrumentInstance` (effect keys, e.g.
  `['distortion','overdrive',...]`); default = DEFAULT_FX_ORDER. Persisted per instrument in
  song-io (additive v1 field; absent → default).
- **Runtime:** each instance already owns its own `EffectsChain` (`SynthRenderer.instFx[k]`);
  set that chain's `.order` from the instance's `fxOrder` (fed alongside `setInstrumentFx`).
- **UI:** drag-to-reorder the FX category blocks in the FX panel → writes the instance's
  `fxOrder` + updates the chain. (Bulk of the work is here.)
- **ROBUSTNESS GOTCHA:** when a NEW effect is later added to the registry, existing saved
  `fxOrder`s won't list it → on load, **append any registry keys missing from `fxOrder`** (and
  drop unknown keys) so new effects never silently vanish from a saved song's chain.
- Unlocks "comp early, limiter last" and per-instrument routing (e.g. crush-then-reverb on a
  pad vs reverb-then-crush on drums).

### Overdrive (TS9 Tube Screamer) effect — added (1.10.0) — `project`
New FX-chain effect `fxOverdrive` (`fx-overdrive.glsl`), slotted right AFTER distortion
(chain: dist → overdrive → chorus → …). TS9 voicing = pre-clip **bass cut** (the FIR
`x − 0.45·lp` tightens lows) → **soft asymmetric** tanh clip (`tanh(g+bias)−tanh(bias)`,
even harmonics) → post **tone** treble-roll; the mid-hump falls out of bass-cut + treble-roll.
Params `odOn/odDrive/odTone/odLevel` (FxParams fields + defaults via FX_EFFECTS, default OFF).
Automation targets OVD/OVT/OVL + toggle OVO; FX-panel knobs (OD Drive is log). Stateless
2-tap FIR like fx-distortion. **GOTCHA:** `_on()` defaults an ABSENT flag to ON (`!== false`)
for the original effects; new opt-in effects (bitcrush, overdrive) must be added to the
truthy group `(flag==='bitcrushOn'||flag==='odOn') ? !!p[flag] : …` so they default OFF for
songs with partial fx objects. Add future opt-in effects there too.

### Bitcrusher rework + per-effect on/off automation — IMPLEMENTED (1.9.0) — `project`
Built 2026-06-08. Verified: build + glsl-check + render-check + headless (toggles coerce to
real booleans off→false/on→true; all 20 songs load; format reset round-trips at v1; bitcrushMix
default 1.0; 7 toggle targets). New bitcrush params + all 7 on/off toggles are fx-scope targets,
so they show up in the automation picker AND the LFO routing dropdown automatically (no new UI).
Bit-exactness (mid-tread keeps 0) + the cross-block hold glitch-fix are GPU — confirm by ear.
Plan details below (kept for reference).

**A. Bitcrusher (`fx-bitcrush.glsl` + `effects.ts` fxBitcrush):**
1. **Bit depth → true mid-tread bit count.** Replace `round(v·2^bits)/2^bits` with
   `q = exp2(bits-1.0) - 1.0; s = clamp(floor(v*q+0.5)/q, -1, 1);` → exactly `2^N−1`
   evenly-spaced levels over [−1,1], keeps **0 as a level** (silence preserved), symmetric
   rails, one code unused. Range `bitcrushBits` **2..33 (linear)**; floor at 2 (1-bit
   degenerates to {0}); **max (33) = explicit bypass** (skip quantize — don't rely on float
   transparency). Clamp matters: float signal can exceed ±1 between stages.
2. **Sample rate → fix the cross-block hold + range.** Current ZOH decimator reads the held
   sample from the input texture but `heldI = holdIdx − blockStart` goes NEGATIVE when the
   window started in the previous block → falls back to the *undecimated* current sample →
   ~93 Hz block-rate glitch. **Fix:** carry the held value across blocks via a 1-texel stereo
   ping-pong state + a tiny update pass (mirror chorus/delay), with a `reset()` cleared on
   play/stop. Range `bitcrushRate` **100..SR (LOG)**, top tied to `ctx.sampleRate`; top = off
   (natural: `holdPeriod=1`). **KEY DECISION:** integer ZOH only yields rates `SR/N` → stepped
   (SR, SR/2, SR/3…), so smooth/subtle rate sweeps near the top need **fractional holdPeriod +
   interpolation** (more code, smoother & less-aliased). **DECIDED: Option 1 — keep integer ZOH,
   crunchy/gritty; NO interpolation.** Rate stays stepped (SR/N) near the top; accepted. (The
   BIT side IS smooth for subtle "creep-in" via LFO/automation.)
3. **Keep `bitcrushOn`** as master enable (now also an automation toggle — see B). Stage runs
   iff `bitcrushOn`; within it each half is off at its max.
4. **DECIDED: add real dry/wet `bitcrushMix`** (0..1, default **1.0** = current fully-wet so
   existing songs are unchanged). Shader `outColor = mix(dry, crushed, uBitcrushMix)`, dry = the
   current input sample. `defaultFxParams` gains `bitcrushMix: 1.0`.
5. Add `bitcrushBits`/`bitcrushRate`/`bitcrushMix` as fx-scope automation + LFO targets.
6. Fix song **"Two-Fingered Typing (FOB)"**: dead keys `bitcrushDepth:6`/`bitcrushMix:0.35`
   become real `bitcrushBits:6` + `bitcrushMix:0.35` (intent restored now that mix exists).

**FORMAT RESET (decided 2026-06-08): collapse song format back to v1.** No songs have ever been
saved (unreleased personal project), so drop the whole migrate ladder (v1→v2→v3→v4) and make the
CURRENT schema the one-and-only **v1** (`SONG_FORMAT_VERSION = 1`, `migrate()` removed/no-op,
deserialize requires v1). This MOOTS the id-stability caveat below — but still append new targets
at the end out of habit (demo songs resolve targets by code via `tgt()` anyway, so internal
reordering wouldn't break them either).

**B. Per-effect on/off automation ("stomp box"), ALL effects:**
- Add `toggle?: boolean` to `ParamTarget`. New TOGGLE target group, ONE per enableFlag
  (`distOn,chorusOn,tremoloOn,delayOn,reverbOn,widthOn,bitcrushOn`, maybe master `enabled`).
- **Semantics:** byte 0 = off, ≥1 = on. `denorm(toggle,byte)=byte>0?1:0`; `normByte`→0/255;
  `fmtValue`→"On"/"Off".
- **Apply (all three fx-write sites: `_applyAutomation`, `applyAutomationLive`, LFO `_applyLfos`
  fx branch):** `instr.fx[key] = t.toggle ? (value > 0) : value`. Writing a real BOOLEAN works
  with BOTH `_on` semantics (bitcrushOn truthy vs others `!==false`) — no `_on` change needed.
- **Bonus:** an LFO on a toggle = rhythmic effect gating (square LFO stutters the effect).

**CRITICAL id-stability rule:** automation `paramId`s are persisted, so new targets (bits/rate +
all toggles) MUST be appended at the VERY END of the `TARGETS` flat array (after GLOBAL), never
inserted into the FX block (that shifts CHAN/GLOBAL ids). ⚠️ Pre-existing caveat to verify:
adding an engine's inst-targets ALSO shifts FX/CHAN/GLOBAL ids (they're built last), so saved
songs predating an engine may mis-resolve fx/chan/global automation — check whether a migration
is warranted.

**Verify:** build + glsl-check + render-check + song-load loop + headless checks (no block-rate
glitch — render a held tone with decimation across block boundaries, assert sample continuity;
toggle automation flips an effect on/off; mid-tread quantizer keeps 0).

### EQ + Sidechain/Pumping Compression (1.18.0) — `project`
Added 2026-06-09. Built Linkwitz-Riley 3-band EQ and sidechain dynamics.
- **3-band EQ (`fx-eq.glsl` + `fxEq`):**
  - Uses two 1st-order Linkwitz-Riley crossover filters to split the signal into Low, Mid, and High bands.
  - TPT (topology-preserving transform) zero-delay feedback form: `y = (x*g + s) / (1+g)`, `s_next = 2*y - s`.
  - State (4 floats) fits in one RGBA texel: `(s_low_L, s_high_L, s_low_R, s_high_R)`.
  - Perfectly transparent when gains are at 0 dB (1.0).
  - Swept cutoff frequencies: Low crossover 50..1000 Hz, High crossover 1000..10000 Hz.
  - Stomp box bypass (`eqOn` flag defaults to off for partial-fx songs).
- **Sidechain Compression:**
  - `instDryTex` (size `BLOCK × INST_DRY_ROWS`, currently 16) is the **sidechain dry bus** on `SynthRenderer`: row `k` = instance `k`'s masked dry stereo mix.
  - **Two-pass fill (fixed 1.18.2).** `_renderToMix` runs PASS A (mix instances `0..min(nInst,INST_DRY_ROWS)` into their bus rows) and only THEN PASS B (per-instance FX). The bus is fully populated before any FX, so a compressor can key off ANY instance regardless of chain order. Gemini's original code interleaved mix+FX per instance, so keying off a *higher-index* (not-yet-rendered) instance read the start-of-block zero-clear and never ducked — caught now by `test/sidechain-order-check.html`.
  - **Cap semantics.** `INST_DRY_ROWS` (16) bounds only the sidechain *bus*: instances ≥16 still render (PASS B mixes them straight into `chanDryFbo`) but can't be used as a key SOURCE. UI `compSource` max is `INST_DRY_ROWS-1`. (Before the fix the 16-row texture silently muted any instance ≥16 — that regression is gone.)
  - PASS B reuses each bus row via `blitFramebuffer` (row `k` → `chanDryFbo`) for `k<16`; for `k≥16` it mixes directly into `chanDryFbo`.
  - Compressor `compSource` (-1 = self/normal, 0..INST_DRY_ROWS-1 = key instance index) binds `ctx.instDryTex` to unit 2 with `uKeyRow`. `uKeyRow >= 0` → peak detector reads `uKeyTex` row `uKeyRow`; else the insert signal `uIn`.
  - NOTE: "Linkwitz-Riley" in the EQ is a slight misnomer — these are 1st-order *complementary* crossovers (LR proper is even-order Butterworth-squared). Functionally flat-summing at unity, so harmless.
- **UI:**
  - Visual EQ UI: The EQ category in the FX panel renders as a unified visual card featuring 3 side-by-side vertical sliders for Low, Mid, High gains, and 2 knobs for frequency cutoffs. The sliders support direct track clicking, have an expanded hit zone for touch responsiveness, and display subtle horizontal tick marks with a highlighted zero-level (0 dB) line.
  - Compressor has a new "Source" knob which dynamically formats values to display names of the targeted instrument instances (e.g. `0:Kick` or `Self`).
- **Automation / Tests:**
  - EQ targets (`EQO`, `EQL`, `EQM`, `EQH`, `EQC`, `EQD`) appended at the end of `TARGETS` (id-stable).
  - Headless harnesses `test/eq-check.html` (new) and `test/dynamics-check.html` verify mathematical correctness, bypass transparency, and sidechain envelope mapping (shader-level). `test/sidechain-order-check.html` (new, 1.18.2) is a RENDERER-level test: a low-index victim keyed off a high-index loud source must still duck — fails on the pre-fix interleaved code, passes two-pass. `golden-render` checksum remains unchanged (0x5fc60c89).

### Compressor + Limiter + reorderable chain (1.14.0) — `project`
Added 2026-06-08. Built on the 1.13.0 `_recursive` infra.
- **Shared dynamics core (`fx-dynamics.glsl`):** one per-sample recursive envelope follower drives BOTH
  the Compressor and Limiter. STEREO-LINKED: peak detector on `max(|L|,|R|)` → one gain on both channels
  (stereo image preserved). One-pole attack/release (coefs computed per block on CPU). Gain law in closed
  form: `gain = (env/thresh)^(-slope)` when `env>thresh`, `slope = 1 - 1/ratio` → ratio 4 = 0.75 (comp),
  ratio ∞ → slope 1 → `gain = thresh/env` (brick-wall limiter). State = env in texel `.r`. Cheap O(BLOCK)
  bypass when off. A `makeDynamics({coeffs})` factory in effects.ts builds both defs from one shader.
- **Compressor** (`fxCompressor`, `compOn`): Thresh(dB)/Ratio/Attack(ms)/Release(ms)/Makeup(dB).
  **Limiter** (`fxLimiter`, `limitOn`): Ceiling(dB)/Release(ms), fixed 0.3ms attack, ∞ ratio.
  Default chain order (per user request): **Comp → Filter → OD → Dist → Chorus → Tremolo → Delay →
  Reverb → Bitcrush → Width → Limiter** (comp first, filter second, overdrive before distortion,
  limiter dead last). Order = `FX_EFFECTS` array → `DEFAULT_FX_ORDER`; reorderable per instance at runtime.
- **Targets** (appended at the very end of TARGETS, id-stable): `CMO`/`CMT`/`CMR`/`CMA`/`CML`/`CMK`,
  `LMO`/`LMC`/`LMR`. Added `compOn`/`limitOn` (and `filterOn`, which was missing!) to the `_on()` opt-in
  truthy group so they default OFF for partial-fx songs.
- **Reorderable per-instrument chain:** `InstrumentInstance.fxOrder?: string[]`; `normalizeFxOrder()` in
  effects.ts reconciles a saved/edited order with the registry (drop unknown, append missing in DEFAULT
  order, dedupe) — so a newly-added effect never silently vanishes. `SynthRenderer.setInstrumentFxOrder()`
  feeds normalized orders; the per-instance loop sets `chain.order` before process. Persisted per
  instrument in song-io (additive `fxOrder` field; absent → default). UI: the FX panel now renders
  category blocks in the instance's order (FX_DEFS grouped into `FX_GROUPS` by `fxKey`), with ▲▼ on each
  header to move it; reorder writes `instr.fxOrder` + re-syncs the renderer.
- **Verified:** `test/dynamics-check.html` (NEW) matches a CPU envelope-follower reference to ~1e-6 across
  strip/block boundaries, confirms gain reduction (loud peak 0.45 vs 0.90) + limiter brick-wall (peak
  0.509 vs ceiling 0.501) + transparent bypass. glsl-check covers fx-dynamics. `effects.test.ts` covers
  normalizeFxOrder. golden checksum UNCHANGED (0x5fc60c89 — new effects off + default order → existing
  songs byte-identical). 30/30 logic, filter/render/golden all green.

### Per-sample recursive FX + resonant filter (1.13.0) — `project`
Added 2026-06-08. The FX chain can now do PER-SAMPLE RECURSION (the linchpin for filter/compressor/
limiter), and the first consumer — a resonant multimode filter — shipped.
- **Infra (`effects.ts`):** `EffectsChain._recursive(prog, inTex, outFbo, read, write)` ports the synth
  ladder's strip+MRT mechanism to the BLOCK×1 FX signal. Renders in `FX_SUB=64`-wide strips; MRT
  attachment0 = the chain scratch buffer (viewport-restricted per strip), attachment1 = a per-effect
  ping-pong STATE texture (BLOCK×1 RGBA32F). Checkpoint read at `uSubOffset==0 ? BLOCK-1 : uSubOffset-1`
  (carries state across blocks via the persisted ping-pong, like the synth). Returns swapped [read,write]
  for the effect to persist; cleared on `reset()`. Exposed via `FxCtx.recursive`. After the loop it
  DETACHES attachment1 + resets drawBuffers([0]) so the shared scratch FBO is single-attachment again.
- **Filter (`fx-filter.glsl` + `fxFilter`):** TPT/Zavalishin state-variable filter (LP/HP/BP), stable
  to self-oscillation. State = (ic1,ic2) per channel in ONE RGBA texel (rg=L, ba=R). Coeffs (a1/a2/a3/k)
  computed per block on the CPU from cutoff+reso (block-rate = LFO/automation-swept). `uBypass=1` path
  when OFF: a cheap O(BLOCK) full-width passthrough (no strips, state frozen) so a song that never uses
  the filter pays ~nothing — re-enabling from frozen state settles in ms (accepted). Placed after
  Overdrive in the chain (Dist→OD→**Filter**→Chorus→…).
- **Params/targets:** FxParams gains `filterOn/filterCutoff/filterReso/filterMode/filterMix`. Automation/
  LFO targets `FLO`(toggle)/`FLC`(cutoff, LOG)/`FLR`/`FLM` — **appended AFTER the toggles** in
  `automation.ts` (id-stability: never insert into the FX block — it'd shift CHAN/GLOBAL/TOGGLE ids).
  `FLC` is the marquee LFO sweep target. FX panel: Filter section (Cutoff log / Reso / Mode LP·HP·BP /
  Mix). Mode is a stepped knob, NOT automated (enum target deferred).
- **Verified:** `test/filter-check.html` (NEW) renders a known signal through a filter-only chain and
  matches a CPU TPT-SVF reference to ~4e-7 across strip+block boundaries (proves the state carry is
  exact + continuous), confirms LP attenuates 8kHz to 0.3%, high-Q (reso 0.98) stays bounded, and
  bypass is transparent (~6e-8). glsl-check now also compiles fx-filter/fx-overdrive/fx-bitcrush-update
  (its list had drifted). golden-render checksum UNCHANGED (0x5fc60c89 — filter-off bypass is bit-
  transparent, so existing songs are untouched). 25/25 logic tests. build + render-check green.
- **NEXT (this unlocked it):** compressor + transparent limiter reuse `_recursive` for the envelope
  follower (see the Compressor/Limiter entry — the "per-sample strip rendering" option is now the easy
  path, not a big lift). A reorderable chain (feature c) pairs well now that there's a filter to place.

### 4 LFOs + Pump (ducking) shape (1.12.0) — `project`
Added 2026-06-08. `LFO_COUNT` 2→4 (`MAX_ROUTINGS` 8→12). The UI is fully data-driven
(`_buildLfoUI` iterates `eng.lfos`; shape dropdown from `LFO_SHAPES`; matrix source dropdown from
`eng.lfos`), so LFO 2 & 3 panels + source options cascade for free. LFOs 0–2 are generic; **LFO 3
defaults to the new Pump shape** (`defaultLfos()` sets the last slot to `defaultPumpLfo()` — shape 7,
synced, `rateBeats:1`). NO default routing (user wires the pump per-instrument: route PUMP → each
non-kick instrument's `LVL`, leave the kick unrouted = sidechain pump without a compressor).
- **Pump shape (`LFO_SHAPE_PUMP=7`):** one-sided DOWNWARD duck, raw `p²−1` ∈ [−1,0] — full duck (−1)
  at the beat (p=0), swelling back to 0 by cycle end (stays ducked through the first half = slow
  recover). Because the mod matrix is ADDITIVE (`center+offset`), a downward-only offset is what makes
  it duck instead of boost. `lfoOffset` SPECIAL-CASES the pump to ignore the `bipolar`/± toggle (always
  returns `raw*depth`, downward) so flipping ± can't turn it into a boost. Block-rate stepping (~93 Hz)
  means the attack is a ~1-block ramp — punchy, not a hard click.
- **Padding:** a song defining <4 LFOs is padded to 4 in BOTH load paths — `engine.loadSong` (demos via
  `data()`) and `song-io.migrate` (saved files) — seeding LFO 3 = pump. So LFO 2/3 appear even for songs
  predating them; no format-version bump needed (lfos is variable-length + normalized on load).
- Verified: 24/24 logic tests (incl. pump one-sidedness + ± independence + engine padding), golden-render
  determinism checksum UNCHANGED (0x5fc60c89 — adding unrouted LFOs doesn't alter existing audio) + async≡sync.

### LFO MOD MATRIX + WVT Env→Pos (1.8.0) — `project`
Updated 2026-06-07. **Inverted LFO routing into a mod matrix** so one LFO drives many
targets. `LfoConfig` is now just a SOURCE (shape/sync/rate/wt — no target/depth). New
`ModRouting {source, targetParamId, targetInstIdx, depth, bipolar}`; `SongData.lfos` (sources,
len LFO_COUNT=2) + `SongData.modRoutings` (variable, cap MAX_ROUTINGS=8). Engine `_applyLfos`
iterates routings (source waveform via `lfos[r.source]`); same per-scope apply + no-drift rule;
collisions = last-routing-wins. `lfoOffset(src, depth, bipolar, phase, cycle)`. **Song format
v4** (migrate splits each v3 LFO's embedded target into a source + one routing). `loadSongInstruments`
prune/remap now keys on `modRoutings` (not lfos). UI: Song Editor shows SOURCE panels +
a Routings matrix (+ Add / ✕, per-row source/target/depth/±). Verified: build + glsl/render-check
+ headless (one source→two targets both move; v3→v4 migration; all 20 songs load). La Mesa de
Onda updated: LFO0 → pad PS1 AND bass PS1 (one source, two targets); LFO1 → lead PS2.

**WVT Env→Pos:** ADSR can modulate morph Position. `EnvPos1`/`EnvPos2` knobs in WVT's free
`p3[2]`/`p3[3]` (bipolar −1..1); shader does `clamp(pos + envAmt*env, 0,1)` per-sample before
the table read (smooth, click-free; layers on the LFO/automation Position).

### Global LFOs — IMPLEMENTED (first cut, 1.6.0; superseded by the mod matrix above) — `project`
Built 2026-06-07 (autonomous). Two song-wide LFOs, all scopes incl. fx, sync/Hz toggle,
wavetable shapes. **Verified headlessly** (esbuild+node): inst-LFO oscillates the voice
param, **instrument base never mutated**, fx param moves + restores on stop, output finite,
and bit-**deterministic** across runs (export-safe). `npm run build` green.
- **Files:** `src/tracker/lfo.ts` (shapes/eval/defaults), `LfoConfig` + `SongData.lfos` in
  `types.ts`, `normUnit`/`denormUnit` in `automation.ts`, engine `lfos`+`_lfoFxBase`+
  `_applyLfos`+`_restoreLfoFx` (called in advance after `_modulateVoices`; reset in
  play/stop/loadSong), song-io **v3** + migrate, `_buildLfoUI()` in main.ts (Song Editor
  "Global LFOs" panels), markup+CSS in index.html.
- **Demo songs** set LFOs by returning `lfos` in `data()` (SongData). `loadSongInstruments`
  now counts inst/fx-scope LFO targets in `used` AND remaps their `targetInstIdx` through the
  prune map (like autoTracks) — so an LFO-targeted instance survives pruning. Demo "La Mesa de
  Onda" (1.7.1) showcases it: vowel-pad swept by a sine LFO + glass lead pulsed by a wavetable
  (PWM-shape) LFO.
- **Key semantic:** LFO reads a STABLE store, writes a DIFFERENT one → no drift. inst-scope
  STACKS with automation (center = autoLive ?? base); chan/global/fx modulate around base/
  snapshot and the LFO wins if both target the same param. BPM excluded as a target.
- **fx-scope is the ODD ONE OUT (and had a bug — FIXED 1.13.1):** inst/chan/global read a pristine
  base and write a SEPARATE live store (vd / panAuto / vd.master), so they always centre on the live
  value. fx-scope has no separate store — the LFO writes back into the same `instr.fx[key]` it must
  read as the centre, so it kept a `_lfoFxBase` snapshot. That snapshot was FROZEN at play-start, so
  editing the targeted fx knob (e.g. FX Level / filter Cutoff) WHILE PLAYING did nothing — the LFO
  clobbered the edit every block, staying centred on the old value (looked like "centre is always 0").
  FIX: `_lfoFxLast` records what the LFO last wrote; if `instr.fx[key]` no longer equals it, the
  user/preset/automation edited it → re-baseline `_lfoFxBase` to the new value. Re-baselining also
  means an fx-scope LFO now rides ON TOP of fx-scope automation (re-centres on the automated value
  each block) instead of fighting it. Static renders/exports are unaffected (no external edits →
  byte-identical; golden checksum unchanged). Regression test: mod-matrix.test.ts "re-centres on a
  live edit".
- **Left to do / polish:** UI is functional native controls (not styled knobs); pause/resume
  restarts LFO phase; no live LFO scope viz. Needs real-ears audition.

### (superseded) Global LFOs — original design plan — `project`
Agreed 2026-06-07 with the user: add **two song-wide LFOs** as a continuous modulation
source (the gap between row-rate automation tracks and the transient effect column).
**Decisions locked:** target **all scopes incl. fx** (modulating synth + effects at once
is a priority); **per-LFO sync toggle** (tempo-synced beats ↔ free-run Hz, both
deterministic); **LFO shapes can borrow Wavewright's wavetable banks** (see the Wavewright
entry below) — shape enum `0 sine·1 tri·2 square·3 saw·4 S&H·5 ramp·6 WAVETABLE`; in WT
mode the LFO reads bank `wtBank` at fixed `wtPos` from the **shared CPU wavetable arrays**
(app-static, so it works even in a song with no WVT instance; band-limiting irrelevant for
a control signal → just linear interp). User wants this written down to build soon, *not*
immediately.

**Why it fits cheaply:** evaluate per render block in the engine (CPU scalar math on `vd`
before upload — **no shader changes**), exactly like the effect-column path; route through
the existing `ParamTarget`/`denorm`/`targetsForType` machinery. It's **song-wide, a single
object — NOT per-pattern**, so it does NOT become another `autoTracks`-style parallel
structure threaded through clone/resize/paste (only song-io + loadSong + new-song touch it).

**The crux / gotcha:** the LFO is a TRANSIENT layer *above* the base+automation center —
**never write `instr.p0/p1`** (the base-corruption trap, see the automation-tracks entry
below). Recompute from the center each block (overwrite, no accumulation/drift), in the
**normalized byte domain** (so a log target like cutoff swings perceptually, not linear Hz).
- **inst**: center = `autoLive.get(key) ?? instr base`; write `vd.p0/p1[v*4+idx]` for every
  live voice of `targetInstIdx`.
- **chan (PAN)**: center = `channelPan[ch]`; write `panAuto[ch]` (already feeds `vd.pan`,
  already reset on play/stop).
- **global VOL**: center = `songMaster`; write `vd.master` (already reset on stop).
- **fx**: the only NEW bookkeeping. `instr.fx[key]` is read by reference and *persists*, so
  snapshot the base into a `_lfoFxBase` map on first apply, write `base+offset` each block,
  and **restore + clear in `stop()`** (next to the autoLive/panAuto/vd.master resets at
  engine.ts ~276-278).
- **Exclude BPM as a target** so `estimateSongFrames()` and export length stay exact.

**Integration points (verified 2026-06-07):**
- Data model `src/types.ts`: `LfoConfig { shape, rateBeats, rateHz, sync, depth, bipolar,
  targetParamId(-1=off), targetInstIdx, wtBank, wtPos }` (`wtBank`/`wtPos` used only when
  `shape===6` WAVETABLE); add `lfos?: LfoConfig[]` (len 2) to `SongData`. Keep the basic
  shapes 0–5 as closed-form math (one-liners; no dependency on the wavetable module loading);
  `wtPos` is a static knob in v1 (cross-LFO modulation of it deferred).
- Engine `src/tracker/engine.ts`: `lfos` field (ctor + `loadSong` from `song.lfos`, absent →
  both off). New `_applyLfos(blockStart)` called in `advance()` **right after
  `_modulateVoices` (line 460)** so the LFO writes last. Phase from song time:
  `periodSec = sync ? rateBeats*60/bpm : 1/rateHz; phase = fract((blockStart-startFrame)/SR /
  periodSec)` — deterministic since `startFrame` resets on play; S&H hashes `floor(...)`.
  Add fx-base restore to `stop()`.
- Persistence `src/tracker/song-io.ts`: bump `SONG_FORMAT_VERSION` → **3**; add `lfos` to
  `SerializedSong`/`SongIOInput` + serialize/deserialize; `migrate()`:
  `if (d.version<3){ d.lfos ??= [off,off]; d.version=3 }`. `main.ts` `data()` (~736) emits
  `lfos: eng.lfos`.
- UI: two LFO panels in the Song Editor output-section (`index.html` ~1335, wired in
  `main.ts` ~482 beside `song-volume-knob`): shape select, sync toggle + rate select/knob,
  depth knob (`bindKnob`), target button reusing the picker (`_openAutoTrackPicker` /
  `targetsForType`, main.ts:822/843) + an instance/channel selector for inst/chan scope.
  Reflect on song load near main.ts:1561.
- Verify: `npm run build` (gate) + esbuild+node check of the pure phase/shape math; ONE
  minimal `render-check` for finite output (engine change justifies it — keep it minimal per
  the laptop note above). Bump `package.json` **minor** (new feature).

### Wavewright (`WVT`) — new wavetable engine, design agreed, build SOON (not started) — `project`
Agreed 2026-06-07. A wavetable synth, planned as the **pair to the global LFOs above**
(position morph is the ideal LFO target; LFOs can reuse its banks as shapes). Name
**"Wavewright"**, short **`WVT`**, type `wvt`, descriptor `src/instruments/iwvt.ts` +
`src/gl/shaders/synth-wvt.glsl` + one line appended at the END of `REGISTRY` (automation
ids are frozen — never insert). User approved all recommendations below.

**Identity / why it's not a dupe of e8e:** e8e is additive with a *discrete* wave SELECT.
Wavewright's identity is the **continuous Position morph axis** through each bank — that's
the marquee, modulatable param. Sits between e8e (additive) and dx7 (pure 6-op FM).

**Architecture:**
- **Closed-form but PHASE-ACCUMULATING** — reuse the existing MRT phase-carry (from the
  phase-drift fix) so pitch slides, detune-LFO, and position morph are all click-free.
  (Position morph alone is clickless even with absolute `t` — it's a timbral crossfade —
  but detune/pitch mod would click; phase-accumulating fixes all of it. Infra exists.)
- **2 morphing oscillators + a simple sub.** Per osc: `bank, position, detune, level`. Sub:
  `level, octave`. Plus ADSR (4) and **one cross-FM amount** (osc2 phase-modulates osc1 —
  NOT an operator matrix; that's dx7's job). Budget: 2×4 + sub 2 + ADSR 4 = 14 of the 16
  universal floats, leaving ~2 for FM amount + one tone control. **3rd osc deferred** —
  addable later via a bespoke bank through `uploadVoiceUniforms` (like DX7's `uOpA–D`),
  non-breaking, so 2-vs-3 is not a now-or-never call.
- **Synthesis = mix + detune** (lush/supersaw default) **+ optional cross-FM** for the
  digital/metallic edge.
- **8 morph banks** (each a 1-D Position axis, morph from→to): `0 Classic` (Tri·Sine·Square·
  Saw — the required classic), `1 Harmonic` (sine→bright), `2 PWM` (narrow→square→narrow;
  lush PWM strings under an LFO), `3 Formant/Vocal` (A·E·I·O·U), `4 Resonant Sweep` (a
  resonant peak scanning the harmonics — filter-sweep *without a filter*, important since
  no engine/FX has a resonant filter), `5 Metallic/Inharmonic` (bell/clangorous), `6
  Wavefolder` (sine→folded, West-coast), `7 Digital/Grit` (clean→bitcrushed/aliased).

**Band-limiting (the real gotcha — design in from the start):** bake each bank to a GPU
texture in JS at load with **per-octave band-limited mip levels**; sample via `textureLod`
choosing the mip by playing frequency. **No synth shader currently binds a `sampler2D`**
(only the FX chain does) → small new plumbing in `synth-renderer` to upload ONE **shared,
app-static** wavetable texture (NOT per-instance; instances index into it). Rejected
alternative: additive-in-shader capped at Nyquist (heavier per-sample, less flexible).

**KEYSTONE — build this first:** a shared module of bank definitions + a JS baker that
produces **CPU `Float32Array`s = the single source of truth**, consumed by four things:
(1) the GPU wavetable texture (audio), (2) the per-oscillator UI scope, (3) the LFO
WAVETABLE-shape readout, (4) the LFO scope. Prototyping just this (baker + a canvas drawing
bank 0 morphing Tri→Sine→Square→Saw) de-risks the engine, both scopes, AND the LFO shapes
in one cheap step — do it before committing to the engine.

**UI:** per-oscillator waveform **scope** (plain 2D canvas — table data is already CPU-side,
just a `lineTo` loop; animate via rAF reading the LFO-modulated Position). Same widget draws
LFO shapes (unified visual language). Standard descriptor otherwise: `paramDefs` (sidebar),
`autoTargets` (Position/Detune/Level/FM/ADSR — these become LFO + automation targets),
`presets`, `help`. App-static banks mean the **LFO can borrow them even with no WVT track**.

**KEEP — keystone prototype exists: `test/wavetable-proto.html`** (not a throwaway; do NOT
`rm` it despite the usual test/-cleanup rule). Self-contained page: bakes all 8 banks to CPU
`Float32Array`s (64 frames × 1024 samples, per-frame normalised), draws the morphed cycle +
a pseudo-3D 64-frame waterfall, and plays a ScriptProcessor osc that reads the live morph
position so you can hear it sweep. BANK selector + Position slider/auto-sweep + pitch. The
`bakeBank`/`morphSample`/`sampleTable` + bank/keyframe defs are written in the shape the real
`src/instruments/wavetables.ts` will take. **Bank 0 "Classic" order locked by ear =
Sine→Triangle→Square→Saw with a PHASE-ALIGNED descending saw** (`1-2·frac`; the ascending
ramp's fundamental is anti-phase to sine and cancels in the crossfade — confirmed audibly).
Bank recipes (Harmonic/PWM/Formant/Resonant/Metallic/Wavefolder/Digital) are first-draft,
tune later. Note: single-cycle tables hold only integer harmonics, so Metallic uses
integer-ratio FM (stays periodic) and Formant approximates vowels at a reference f0.

**Status:** ENGINE IMPLEMENTED — first cut (1.6.0, uncommitted, 2026-06-07 autonomous).
- **Shared module `src/instruments/wavetables.ts`** built from the prototype (8 banks, baker,
  `sampleTable`, `wtShape`, `WT_TABLES` baked once). Consumed by the LFO (`wtShape`) and the
  renderer (texture). **Compiles green.**
- **Engine `iwvt.ts` + `synth-wvt.glsl`** appended to REGISTRY (id last). **CLOSED-FORM first
  cut** (NOT yet phase-accumulating): 2 morph oscs (Pos1/Pos2 in p1 → automatable + LFO
  targets) + detune + cross-FM (osc2→osc1 phase) + sine sub. Banks/levels in p2/p3.
- **Renderer:** one R32F wavetable atlas texture (width=samples, height=banks×frames) built
  once, bound permanently to **texture unit 3** (synth pass only rebinds 0–2), `uWavetable`=3
  per program. **First synth shader to bind a sampler2D.** Sampled via `texelFetch` + manual
  bilinear (avoids bank-row bleed; no linear-float ext needed).
- **VERIFIED:** `npm run build` + headless `glsl-check` + `render-check` — all ALL_OK.
- **Gaps 1–3 DONE (1.7.0, 2026-06-07 autonomous):**
  1. **Band-limiting** — `bakeWavetableAtlas()` in wavetables.ts builds WT_MIPS=8 harmonic-
     limited copies per frame (DFT each bank's KEYFRAMES, interp coeffs per frame — exact +
     cheap; LUT trig; ~1 s one-time bake on first audio). Atlas texture height = mips×banks×
     frames. Shader `wtSample(bank,pos,phase,freq)` picks/blends the mip whose top harmonic
     stays < Nyquist (`log2(2·MAXH·f/SR)`). Verified by data check: HF energy halves per mip
     (0.71→0.006), monotonic.
  2. **Phase-accumulation** — wvt is now the first CLOSED-FORM engine to use the MRT phase
     carry. Carry layout `outPhase=(ph1,ph2,phSub,-)` (fract'd); a continuing note (onRel<0)
     accumulates from the carried value, a note-on (onRel≥0) measures from note-on; branches
     agree at the seam. FM offset applied at read only (carrier phase stored clean). Click-free
     detune/pitch — *needs ears to confirm the sweep, algebra verified*.
  3. **Per-osc scope UI** — `Controls._buildWtScopes()` draws OSC1/OSC2 morphed cycles under
     the WVT knobs via a rAF reading the live instance bank/pos through `sampleTable` + the
     full-bandwidth `WT_TABLES`. CSS `.wt-scopes` in index.html.
- **Scope shows LIVE modulation (done):** `_buildWtScopes` reads `vd.p1[v*4+idx]` for an active
  voice of the selected instance (else the base knob) — so the scope animates with LFO +
  automation while a note plays. Idle → base.
- **16 BANKS (done):** added 9–16 = Organ, Sync, Saturate, Comb, Skew, Noise, Power, Glass
  (helpers `sat`/`combWave`/`skew`/`noiseWave` in wavetables.ts). `WT_BANK_COUNT` auto-derives;
  atlas = 8 mips × 16 banks × 64 frames = 8192 rows (×1024 = ~33 MB R32F texture). **Shader
  `WT_ROWS_PER_MIP` is hardcoded 1024 = 16·64 — must be kept in sync if bank count changes.**
  iwvt Bank1/Bank2 knob max = 15. Verified finite (tsx) + glsl/render-check.
- **Live param edits (done, ALL engines):** `engine.updateInstrumentParam(instrIdx,bank,i,v)`
  pushes a sidebar-knob edit into `vd` for active voices, so held notes change immediately (not
  only at note-on). Called from the controls knob handler (non-op params). Base `instr.pN` stays
  the source of truth; LFO/automation keep modulating around the new base.
- **Bank knobs show NAMES:** controls `formatFn` maps WVT Bank1/Bank2 → `WT_BANKS[n].name` (same
  path as e8e/moog stepped knobs).
- **Still open:** real-ears audition (click-free detune + aliasing across the range); banks 9–16
  are first-draft recipes (tune by ear); mip blend can leak slight alias in the crossfade region
  (accept / bias up if needed).

### Automation tracks (`feature/automation-tracks`, merged) — `project`
Per-cell `fxCmd`/`fxVal` automation was migrated to dedicated per-pattern `AutoTrack[]`.
Key design invariant (now the live behavior, also in AGENTS.md): inst-scope automation
writes the override to `autoLive` (cleared on play/stop, merged on note-on by
`_writeParams`) and live voices — **never** the pristine `instr.p0/p1` base arrays.
The durable demo-song / parallel-structure gotchas from that migration follow.

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
- **WHY block-rate works:** modulation updates `vd.freq` once per BLOCK (~93 Hz). Natively
  smooth on phase-accumulating engines (303 `synth-303.glsl:33`, moog `synth-moog.glsl:109` —
  both `fract(phase + freq/SR)` from `uPrevPhase`; wvt carries phase via its MRT texture too).
- **Pitch fx now click-free on ALL pitched engines (2026-06-17).** The closed-form engines
  (pipi/guitar/tanpura/tabla/e8e/sampler) compute phase as `f·t` from absolute note-on time, so a
  per-block freq change USED to jump the analytic phase at the seam (click). Fix = a universal
  per-voice **fundamental-phase correction** `uPhaseOff` (cycles): `engine._accumPhaseOff` (runs
  right after `_modulateVoices`) accumulates `off += (f_prev − f_now)·tStart` and uploads it
  (`vd.phaseOff` → `common.glsl uniform float uPhaseOff[VOICES]`); each closed-form shader adds it
  back as `te = t + uPhaseOff/f0` and oscillates on `te` (tabla adds `uPhaseOff` straight to its
  `basePhase`, since modes are `ratio_n·basePhase`). KEY PROPERTY: off stays EXACTLY 0 while a
  voice's freq is steady (no slide/porta/vibrato/arp) → `te == t + 0.0 == t` → render bit-identical
  to before; only modulated voices diverge. dx7 already carried phase via its MRT texture (each op
  is a single sine → `fract` is fine), so it needed no change. Drums (808/groove) ignore pitch.
  Verified by `test/phaseoff-check.html` (corrected seam ≈ interior step; uncorrected jump 7–25000×
  bigger on tonal engines). Precision: `off` is in fundamental cycles, fine for melodic gestures;
  a long held bend on a high partial loses some precision but those partials are near-silent.
- **UI:** `tracker-view.ts` 4th sub-column (`COL_X/COL_W/COL_TEXT_PAD` 4 entries, `CH_W`
  124, `maxCol` 3); cmd amber / val cyan. Instrument column shows the numeric instance index
  (not short name) while `cursor.col===1`. Input in `main.ts._handleFxEdit` (col 3): a
  command key (0-4,A) sets cmd + arms `_hexEntry{col:3}`, next two hex digits fill val +
  auto-advance; Delete at col 3 clears only the fx. Note entry is skipped at col 3.

### Instrument registry — the plug-in system (`src/instruments/`) — `project`
Instruments are now data-driven descriptors, not scattered `if (type === …)` branches.
**`src/instruments/REGISTRY`** (in `index.ts`) is the single source of truth; one
`InstrumentDef` per engine (`i303.ts`, `idx7.ts`, `i808.ts`, `imoog.ts`, `itanpura.ts`,
`ie8e.ts`, `igroove.ts`, `itabla.ts`, `ipipi.ts`, `iguitar.ts`) co-locates its
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

### Effects: registry + PER-INSTRUMENT chains (`src/gl/effects.ts`, `synth-renderer.ts`) — `project`
Effects are a data-driven registry like instruments: `FX_EFFECTS` is a list of `FxEffectDef`
(params + shader(s) + `init(gl)`→`process` closure); `EffectsChain` is a generic runner;
`defaultFxParams()` and chain order DERIVE from the registry. Add an effect = one descriptor
(+ `.glsl`). Chains are **PER INSTRUMENT INSTANCE** (each instance owns its `fx` =
`InstrumentInstance.fx`, and a chain `SynthRenderer.instFx[k]` keyed by instance index, built
lazily). Voices route to their instance's chain via `vd.instId[v]`; voices of one instance
(e.g. a chord spread over channels) sum into ONE chain — so no reverb multiplication — and two
instances of the same engine can sound completely different. App feeds params via
`renderer.setInstrumentFx(instruments.map(i=>i.fx))` (called after any table/fx change); the
renderer reads each `instance.fx` BY REFERENCE so live knob edits need no re-call. fx-scope
automation + presets write `instance.fx`. Demos author per-engine-TYPE `SongDef.fxParams` for
convenience; `loadSongInstruments` clones it onto each instance. Saved songs store fx per
instrument (song format **v2**; v1's per-type `fxParams` is migrated onto instances by type in
`song-io.migrate`). **History:** this started as a per-CHANNEL (per-voice) implementation
(v1.1.0) — WRONG: a channel plays whatever instrument a cell says, and one instrument can span
several channels, so per-channel tripled the reverb on a 3-voice pad chord (drowned the Moog
bass in "Nonconsensual"). Per-INSTRUMENT is the correct model and fixes that at the source.
**Still-true gotcha:** distinct INSTANCES of one type each get their own chain, so a song with
many instances of one engine (e.g. Gooner's 4 separate 303s) has N× the reverb tails of the
old per-type sum — that's correct per-instance behaviour (no shared bus), but such demos may
sound wetter; tune per-instance if needed.
