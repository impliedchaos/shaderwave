# ROADMAP — ShaderWave

A **flexible, not set-in-stone** plan for where the project goes next. Ordered by
*dependency and risk*, not by wish-list order: each phase ships something usable, and
earlier phases de-risk or host later ones. Branch points are called out at the end —
treat the sequence as a default, not a contract.

The throughline: **deepen, don't widen.** No 15th engine. Every phase either makes the
GPU premise pay off, opens the closed preset system, hardens what exists, or gets it in
front of people.

---

## Phase 0 — Ground truth *(✅ DONE, 2026-06-18)*

Shipped as **`test/perf-check.html`** — times the full render path on real hardware
(wall-clock around the sync `renderBlock`, whose blocking `readPixels` forces GPU
completion; conservative vs the shipped async path). Run it in a *real* browser at
`localhost:5173/test/perf-check.html` — never headless (SwiftShader perf is meaningless).

**Measured (Intel ARL / Mesa): the GPU premise does NOT currently pay off.**
- **Spectra's partial curve is flat** — 64→2048 partials at 8 voices is 1.7→2.2 ms median
  (32× the work, +0.5 ms). The parallel partial-sum is invisible against fixed per-block
  overhead; the chip is idle even at the cap.
- **Cost is overhead + recursion, not compute.** ~1.5 ms fixed floor (readback stall +
  uniform uploads) hits even the cheapest engine; the recursive ladders (303 = 3.3 ms,
  moog = 2.5 ms; 8 strip-passes/block) cost *more* than additive@2048 (2.2 ms).
- **Realtime confirmed, measured not asserted:** worst-case p95 6.8 ms vs 10.67 ms budget
  (1.57×), 0/548 real-song blocks over budget.
- **Decisions locked:** WebGPU shelved (optimizes a non-bottleneck); Phase 2 is justified by
  sound not speed; the GPU-showcase angle requires pushing Spectra *far* past 2048 partials.
- **Noted-but-not-done:** `_renderToMix` renders all 13 engine shaders every block regardless
  of active voices — skipping idle engines is the highest-leverage floor reduction *if perf
  ever matters* (it doesn't today). Verify the mix-mask-to-zero assumption before acting.

## Phase 1 — Instrument editor *(✅ DONE, 2.6.0–2.7.0)*

Turn the closed preset system into an open one — design patches without touching code.

**Shipped:** an instrument-editor tab; save / rename / delete / import / export **user
presets** (own IndexedDB, `src/tracker/preset-store.ts`); A/B compare, morph, randomize /
nudge; and a per-instrument **modulation matrix** (2 LFOs + mod-env, incl. vibrato). See
MEMORY.md for the full notes.

- The architecture is already the substrate: universal param banks `uP0`–`uP4`, the
  descriptor registry (`src/instruments/`), presets keyed by engine type
  (`src/ui/presets.ts`), and `src/tracker/song-store.ts` (IndexedDB + gzip) for
  persistence. The editor is mostly *exposing plumbing that already exists*.
- **Scope:** save the current instance's params + fx as a **named user preset**;
  manage / rename / delete user presets; optional A/B compare, randomize, morph.
- **Why before Phase 2:** lower risk, immediate playability payoff, and the patch-editing
  UI is the natural *host* for the resynthesis controls later. Build the room before the
  exotic furniture goes in.
- **Deliverable:** design and save your own patches in-app.

## Phase 2 — Spectra resynthesis *(the research bet)*

Make the GPU premise pay off the way only a GPU can: sample-driven additive resynthesis.

- **Not starting from zero** — `src/instruments/additive-analysis.ts` already exists, and
  MEMORY.md calls the Spectra spectrum "resynthesis-ready." (Read that file first to see
  how much of the analysis half is already done before scoping.)
- **Work:** analyze a sample (peak / partial tracking → per-partial freq / amp / decay) →
  pack into a texture → drive `synth-additive.glsl` from the *table* instead of the
  formula → expose morph / freeze.
- **Depends on:** Phase 0 (partial budget); benefits from Phase 1 (the editor hosts
  "load sample → resynthesize → morph").
- **Highest risk** (partial tracking is genuinely hard). **Justified by *sound*, not speed**
  — Phase 0 showed the engine isn't GPU-bound even at 2048 partials, so resynthesis earns its
  place as a *musical* capability (sample-driven additive), not a performance win. Don't sell
  it as "the thing a CPU can't do" — that's only true if the partial/voice counts are pushed
  far higher (see the branch point below).

## Phase 3 — Reach *(packaging, deliberately last)*

**Status:** the save/share trio has shipped (2.8.0–2.9.0) — compact binary format
(`src/tracker/song-codec.ts`, `SWB1`), permalink (`#s=…`), and gist publishing
(`src/tracker/gist.ts`, `#gist=…`). **Still open:** the embeddable read-only player and
a guided first-run. The original spec is kept below for reference.

- **Compact binary save format.** *(✅ DONE)* Replace the versioned JSON document with a packed binary
  encoding (`src/tracker/song-io.ts`). Today's format is human-readable JSON that's then
  gzipped; a purpose-built binary layout (typed arrays for pattern note/automation data,
  varint-packed where it helps, sample audio as raw blobs rather than base64) is smaller,
  faster to parse, and — crucially for the permalink below — keeps share URLs short. Must
  preserve the existing `format` + `version` headers and route old JSON files through the
  `migrate()` step so saved songs keep loading. **Do this before permalinks** — the binary
  size is what makes URL-hash sharing practical.
- **Permalink sharing (the default)** *(✅ DONE)* is nearly free once the format is compact: a share
  link is `binary → base64url` in the URL hash — no backend, no third party, true to the
  pure-front-end design. The compact format is what keeps these URLs short enough to use.
- **Gist publishing (the durable / big-song option).** *(✅ DONE)* For songs too big for a URL, or
  when a permanent link is wanted, publish to a **secret GitHub Gist**. This fits the
  GitHub Pages deployment and stays fully serverless:
  - **Reads need no auth.** A secret gist (`"public": false` — unlisted, link-only, but
    readable by anyone with the link) is fetched anonymously. Load flow: `#gist=<id>` →
    `GET https://api.github.com/gists/<id>` → follow `files[...].raw_url` and fetch the
    bytes from `gist.githubusercontent.com` (a CDN, so it dodges the 60-req/hr
    unauthenticated API limit; only the one discovery GET counts against it).
  - **Writes use a user-supplied fine-grained PAT** scoped to *Gists: read+write* (or a
    classic token with the `gist` scope), stored in `localStorage`. `api.github.com` is
    CORS-enabled for token-authed requests, so `POST /gists` works directly from the
    static page — no backend, no proxy. Gists are created under the publisher's own
    account (attribution + they can delete their own content). Deep-link the token page
    with the scope prefilled: `github.com/settings/tokens/new?scopes=gist&description=ShaderWave`.
  - **Sharing is asymmetric** — only *publishing* needs a token; the far more common
    "click a link and it loads" path is anonymous. That's what makes the PAT friction
    acceptable: most users never see it.
  - **DEAD END — do not re-investigate:** OAuth **Device Flow** looks perfect (secret-less,
    just a `client_id`) but GitHub's token endpoints at `github.com` send **no CORS
    headers**, so a browser can't poll them without a proxy = a backend. The classic OAuth
    web flow needs `client_secret` server-side = a backend too. The BYO-PAT path above is
    the only fully-static write path that works.
  - **Caveats:** gist inline content truncates ~1 MB (hence always read via `raw_url`);
    multi-MB **sampler** songs are marginal for gists — size-guard them with a clear "too
    big to share" message. If sampler sharing ever becomes important, **Cloudflare R2**
    (S3-compatible, generous free tier, no egress fees) is the escape hatch for those
    blobs specifically — accept that it's a minimal managed backend, separate from the
    static GitHub Pages deploy.
- **Embeddable read-only player** and a guided first-run (the help dialog already exists).
- **Why last:** packaging is worth most once the instrument is worth sharing (editor +
  resynth make it so), and the share format wants the song schema stable.

## Running through all of it — "solid artifact"

Not a phase, a **track**: the Phase 0 perf harness, plus a *harden + playability polish*
beat at the end of each phase. This is how the project deepens instead of widening.

---

## Branch points (where the plan flexes)

- **After Phase 0 (RESOLVED):** the measurement says you're *not* GPU-bound even at 2048
  partials — overhead and the recursive ladders dominate, not parallel compute. WebGPU is
  therefore **shelved** (it would optimize a non-bottleneck). To make the GPU premise pay off
  as a *showcase*, the move is to push Spectra far past 2048 partials / more voices and find
  the genuine GPU-bound crossover (there's ~4–5× headroom to spend).
- **Phase 1 ↔ 2 can swap** if the research bet excites you more — you just lose the
  "editor hosts the resynth UI" synergy.
- **Permalink sharing can jump the queue anytime** — but it really wants the compact
  binary format first, so the two move together within Phase 3.

## Suggested next task

**Phase 2 — Spectra resynthesis.** Phases 0, 1, and the Phase 3 save/share trio have
shipped; resynthesis is the remaining headline feature (and the natural home for a GPU
showcase — push partials/voices past 2048 to find the genuine GPU-bound crossover). The
small Phase 3 tail (embeddable read-only player, guided first-run) can slot in anytime.
