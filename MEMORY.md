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
   guard). STILL TODO to fold in: bitcrush continuity, new-instrument fx defaults. The HTML harnesses
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

### GPU sample / granular engine — PLANNED — `project`
A sampler is NOT contradictory to "synthesized on the GPU" (I was wrong; user corrected me): WVT
already binds a `sampler2D` and reads a texture by playhead → a sample is the same path with a
different texture source, still all GPU computation. The real new problem is **asset management**.
- **FIRST FORK — decide before any code: how samples persist with a song.** Options: embed raw PCM
  (huge) / **store the user's ORIGINAL encoded file bytes + `decodeAudioData` on load** (cheap, no
  encoder needed — see format notes; my lean) / external library + references (fragile). Shapes all.
- **Texture layout:** long samples exceed 1D → tile across a `≤16384 × N` R32F texture, index→(x,y).
- **Pitch:** rate = noteFreq / rootFreq; resample with interp (bilinear already done); pitch-up
  aliasing → reuse the WVT per-octave band-limited mip machinery (or embrace grit).
- **MVP:** load file → pitched one-shot / looped playback (loop start/end) + ADSR.
- **The wow (why GPU makes this special, not me-too):** GRANULAR (many windowed grains per output
  sample — GPU is built for it, brutal on CPU); read-head as an LFO/automation TARGET (rhythmic
  scrubbing — mod matrix already there); freeze / time-stretch (playhead decoupled from pitch);
  sample→Wavewright bank (slice into single-cycle frames, shares WVT machinery). Frame it as a
  distinctive GPU-granular instrument.

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
  - `instDryTex` (size `BLOCK × 16`) added to `SynthRenderer` to save the dry mixed stereo audio of all 16 instrument instances.
  - In `_renderToMix`, we clear `instDryFbo`, mix each instance `k`'s voices into row `k` of `instDryTex`, and then `blitFramebuffer` row `k` into `chanDryFbo` for the FX chain.
  - Compressor `compSource` parameter (-1 = self/normal, 0..15 = sidechain key instrument instance index).
  - Compressor binds `ctx.instDryTex` to Unit 2, passing `uKeyRow`. If `uKeyRow >= 0`, peak detector reads from `uKeyTex` row `uKeyRow`; otherwise detects from the insert signal `uIn`.
- **UI:**
  - Visual EQ UI: The EQ category in the FX panel renders as a unified visual card featuring 3 side-by-side vertical sliders for Low, Mid, High gains, and 2 knobs for frequency cutoffs. The sliders support direct track clicking, have an expanded hit zone for touch responsiveness, and display subtle horizontal tick marks with a highlighted zero-level (0 dB) line.
  - Compressor has a new "Source" knob which dynamically formats values to display names of the targeted instrument instances (e.g. `0:Kick` or `Self`).
- **Automation / Tests:**
  - EQ targets (`EQO`, `EQL`, `EQM`, `EQH`, `EQC`, `EQD`) appended at the end of `TARGETS` (id-stable).
  - Headless harnesses `test/eq-check.html` (new) and `test/dynamics-check.html` verify mathematical correctness, bypass transparency, and sidechain envelope mapping. `golden-render` checksum remains unchanged (0x5fc60c89).

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
`eng.lfos`), so LFO 3 & 4 panels + source options cascade for free. LFOs 1–3 are generic; **LFO 4
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
  `data()`) and `song-io.migrate` (saved files) — seeding LFO 4 = pump. So LFO 3/4 appear even for songs
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
Onda updated: LFO1 → pad PS1 AND bass PS1 (one source, two targets); LFO2 → lead PS2.

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
