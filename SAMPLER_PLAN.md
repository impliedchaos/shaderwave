# Implementation Plan — Sampler Engine (`sampler`)

> Hand-off plan for implementing a PCM **sampler** instrument in ShaderWave.
> Read `AGENTS.md` (a.k.a. `CLAUDE.md`), `README.md`, `MEMORY.md`, and `COMPOSING.md`
> first. This plan assumes that context. All file:line refs were accurate at
> commit `fd645a7` (1.18.2); re-grep if they've drifted.

---

## 0. TL;DR of the core problem (read this first)

Every other engine is a pure function: `f(params, note, time) → sample`. A sampler
is not — it plays back **arbitrary PCM data** that (a) is loaded from a user file at
runtime, (b) differs **per instrument instance** (two sampler instances = two
different samples), and (c) must be **persisted inside the saved song**.

The architectural friction: **the synth pass renders per engine-TYPE, not per
instance.** `synth-renderer.ts` runs ONE draw for all voices of a type into a
`BLOCK × VOICES` texture (`this.inst[typeId]`), and voices distinguish themselves
in-shader via `voiceLive(v)` (`uInst[v] == uInstId`). So a single sampler draw must
have access to **every** sampler instance's PCM at once and pick the right one per
voice.

**Solution: a shared "sampler PCM atlas" texture** (exactly like the wavetable
atlas on texture unit 3, but mutable and slotted per instance). Each sampler
instance owns a slot; the shader reads `voice → slot → PCM`. This is the spine of
the whole design.

**Scope for v1 (do NOT gold-plate):**
- ✅ One mono sample per instance, **pitched** by the played note (melodic playback).
- ✅ Start offset, one-shot vs forward-loop, loop points, amp ADSR, tune.
- ✅ Load from an audio file (`decodeAudioData`), persist in the song.
- ❌ Stereo samples, multi-sample/drum-kit zones, reverse, crossfade loops,
  time-stretch. **All explicitly deferred** — leave TODO comments, don't build them.

Project guidance check (`MEMORY.md`): the "resist new engines until undo + tests
exist" pushback is now **satisfied** (undo shipped in 1.15.0; harnesses exist), so a
sampler is fair game. Add a test harness as part of this work (Phase 6) — that's the
expected bar.

---

## 1. Data model & layout

### 1a. The PCM atlas (renderer-owned, texture unit 4)

WebGL2 caps texture width at `MAX_TEXTURE_SIZE` (often 16384, and SwiftShader is
similar) — a multi-second sample (48000 × N samples) will NOT fit in one row. So the
atlas is a **2D tiled buffer** addressed by a **linear sample index**:

```
const SMP_ATLAS_W = 4096;          // texels per row (power of two)
const SMP_ATLAS_H = 4096;          // rows  → 16.7M samples total ≈ 349 s @48k across all slots
const SMP_MAX_SLOTS = 16;          // max sampler instances with loaded audio (matches sidechain bus cap feel)
// Format: R32F (mono). Reserve RG32F for a future stereo upgrade — note it, don't build it.
```

Linear index → texel:  `row = idx / SMP_ATLAS_W`, `col = idx % SMP_ATLAS_W`.

Each **slot** gets a contiguous run of the linear space: `baseTexel[slot]` +
`length[slot]` (in samples). Pack slots sequentially; **re-pack whenever the
instrument table changes** (don't do fragile incremental bookkeeping — see 1c).

Create/upload it next to the wavetable texture in `SynthRenderer` constructor
(`synth-renderer.ts:133–145` is the wavetable precedent — copy its `texImage2D` /
`texParameteri` block):

```ts
this.samplerTex = gl.createTexture()!;
gl.activeTexture(gl.TEXTURE4);
gl.bindTexture(gl.TEXTURE_2D, this.samplerTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, SMP_ATLAS_W, SMP_ATLAS_H, 0, gl.RED, gl.FLOAT, null); // allocate, no data
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // NEAREST — interp manually in-shader
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.activeTexture(gl.TEXTURE0);
```

Bind the sampler uniform to unit 4 in the per-program uniform setup
(`synth-renderer.ts:150–160`, where `uWavetable` → 3 is set):
```ts
gl.uniform1i(it.prog.u('uSamplePcm'), 4);   // null/no-op for non-sampler programs
```
**Unit 4 is free** (0–2 = state/phase/phase2, 3 = wavetable). Confirm nothing else
grabbed it.

### 1b. Per-instance metadata (lives on the instrument instance)

Extend `InstrumentParams` (`types.ts:38–44`) with an optional sample block — this is
the **`ops` precedent** (DX7's per-instance operator data), applied to PCM:

```ts
export interface SampleData {
  name: string;          // original filename, for UI
  pcm: Float32Array;     // mono, at ENGINE sample rate (resample on load — see 4)
  rootNote: number;      // MIDI note the sample plays back at unity rate (default 60)
  loopStart: number;     // sample frames; 0 if none
  loopEnd: number;       // sample frames; pcm.length if none
  loopMode: number;      // 0 = one-shot, 1 = forward loop
}
export interface InstrumentParams {
  p0: number[]; p1: number[]; p2?: number[]; p3?: number[];
  ops?: DX7Op[];
  sample?: SampleData;   // NEW — sampler-only, analogous to ops
}
```

### 1c. Slot mapping (derive, don't track)

Do NOT maintain incremental slot indices through add/remove/reorder (that path is a
bug farm — see how much remapping `removeInstrument` already does at
`engine.ts:398–423`). Instead, **re-derive from the instrument table** every time it
changes, mirroring how fx params are re-pushed via `renderer.setInstrumentFx(...)`:

Add `SynthRenderer.syncSamplerSlots(instruments: InstrumentInstance[])`:
1. Walk `instruments`; for each `type === 'sampler'` with a loaded `sample`, assign
   the next slot ordinal and pack its `baseTexel`.
2. `texSubImage2D` each sample's PCM into its packed region (only when changed —
   cache a dirty flag / last-uploaded identity to avoid re-uploading every call;
   uploading 16×多秒 buffers on every knob turn would stall).
3. Store CPU-side arrays the engine can read: `slotByInstIdx: Int32Array`,
   `slotBaseTexel`, `slotLen`, `slotRoot`, `slotLoopStart/End/Mode`.

Call it wherever `setInstrumentFx` is called (the app's `_syncRendererFx` /
`setInstrumentFx(instruments.map(i => i.fx))` site in `main.ts`) and after song load.

> **texSubImage2D of a tiled region:** a sample's linear range can straddle rows.
> Easiest correct approach: pad each slot's row-start to a row boundary
> (`baseTexel = baseRow * SMP_ATLAS_W`), then upload as a full-width block of
> `ceil(len / W)` rows (zero-pad the last row). Wastes < one row per slot — fine.
> Then `baseRow[slot]` is all the shader needs.

### 1d. Getting slot + metadata into the shader (the `dx7Ops` pattern)

`uploadVoiceUniforms(gl, prog, vd)` only receives `vd`. DX7 solves the per-instance
problem by having **the engine pack per-voice data onto `vd`** (`vd.dx7Ops`,
`engine.ts:520–537`) and the descriptor uploads it. Do the same:

- Add to `VoiceData` (`types.ts:184–202`) a sampler block, filled by the engine each
  block in the same place dx7Ops is filled:
  ```ts
  sampler?: {
    slot: Float32Array;   // per voice: atlas slot (-1 = no sample) [VOICES]
    baseRow: Float32Array; loopStart: Float32Array; loopEnd: Float32Array;
    len: Float32Array; rootFreq: Float32Array; loopMode: Float32Array;
  };
  ```
  The engine fills these per voice from `instruments[vd.instId[v]].sample` +
  the renderer's slot map. (rootFreq = `noteToFreq(sample.rootNote)`.)
- Sampler descriptor's `uploadVoiceUniforms` uploads them as `uniform1fv` arrays
  (`uSmpSlot[0]`, `uSmpBaseRow[0]`, …). Cheap — VOICES = 8.

---

## 2. The shader — `src/gl/shaders/synth-sampler.glsl`

Closed-form (`recursive: false`): playback position is computed directly from time
since note-on × playback rate, so **no MRT state carry needed**. Model it on
`synth-808.glsl` / `synth-tanpura.glsl` (coordinate extraction, `voiceLive`, always
zero the MRT outputs).

Conventions (from `common.glsl`): `int x = int(gl_FragCoord.x)` (sample in block),
`int v = int(gl_FragCoord.y)` (voice), `voiceLive(v)`, time
`t = (float(x) - uOnRel[v]) / uSampleRate`, output `outAudio = vec4(s,0,0,1)`.

```glsl
#version 300 es
// (common.glsl is prepended by the build; uniforms/helpers from there are in scope)
uniform highp sampler2D uSamplePcm;     // R32F tiled atlas, width = SMP_ATLAS_W
uniform float uSmpSlot[VOICES];         // -1 = no sample loaded
uniform float uSmpBaseRow[VOICES];      // first atlas ROW of this slot
uniform float uSmpLen[VOICES];          // sample length in frames
uniform float uSmpRootFreq[VOICES];     // freq at unity playback rate
uniform float uSmpLoopStart[VOICES], uSmpLoopEnd[VOICES], uSmpLoopMode[VOICES];

const int SMP_W = 4096;                 // MUST match SMP_ATLAS_W in synth-renderer.ts

float pcmAt(float baseRow, int i){      // linear frame i within the slot → texel
  int g = int(baseRow) * SMP_W + i;
  return texelFetch(uSamplePcm, ivec2(g % SMP_W, g / SMP_W), 0).r;
}

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0); outPhase = vec4(0.0); outPhase2 = vec4(0.0);   // closed-form: always zero
  if (!voiceLive(v) || uSmpSlot[v] < 0.0) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate;   // <0 while held

  // params: pick a layout and KEEP IT STABLE (ids persist). Suggested:
  float tune   = uP0[v].x;     // semitones
  float start  = uP0[v].y;     // 0..1 start offset (× len)
  float gain   = uP0[v].z;     // linear out gain
  float atk    = uP1[v].x, dec = uP1[v].y, sus = uP1[v].z, rel = uP1[v].w;

  float rate = (uFreq[v] / max(uSmpRootFreq[v], 1.0)) * pow(2.0, tune / 12.0);
  float pos  = start * uSmpLen[v] + t * uSampleRate * rate;   // read position in frames

  float ls = uSmpLoopStart[v], le = uSmpLoopEnd[v];
  if (uSmpLoopMode[v] > 0.5 && le > ls + 1.0) {
    if (pos >= le) pos = ls + mod(pos - ls, le - ls);          // forward loop
  } else if (pos >= uSmpLen[v] - 1.0) {                        // one-shot: done
    outAudio = vec4(0.0); return;
  }

  // linear interpolation between frame i and i+1 (NEAREST texture → interp by hand)
  int i = int(floor(pos)); float fr = pos - float(i);
  float a = pcmAt(uSmpBaseRow[v], i);
  float b = pcmAt(uSmpBaseRow[v], i + 1);
  float s = mix(a, b, fr);

  float amp = adsr(t, tRel, atk, dec, sus, rel);   // common.glsl ADSR
  outAudio = vec4(s * amp * gain * uVel[v], 0.0, 0.0, 1.0);
}
```

**Gotchas:**
- `SMP_W` constant must match `SMP_ATLAS_W` in TS — leave a comment on both tying
  them together (or `#define` via string-replace if you prefer; the codebase tends to
  duplicate small consts across the TS/GLSL boundary — grep `WT_SAMPLES`).
- `texelFetch` ignores filtering, so NEAREST atlas is correct; all interp is manual.
- Aliasing on big upward pitch shifts is unaddressed in v1 (no mip chain like the
  wavetable). Acceptable; note it as future work. Don't build sample mips now.

---

## 3. The descriptor — `src/instruments/isampler.ts` + registry

Model on `i808.ts` / `itanpura.ts`. `recursive: false`, no `drum`.

```ts
import shader from '../gl/shaders/synth-sampler.glsl?raw';
export const isampler: InstrumentDef = {
  type: 'sampler', name: 'Sampler', short: 'SMP',
  label: 'Sampler — PCM Playback', blurb: 'Plays a loaded audio file, pitched by note. Start, loop, amp envelope.',
  shader,
  defaults: { p0: [0, 0, 1, 0], p1: [0.001, 0.2, 1, 0.05] },   // tune, start, gain ; A D S R
  paramDefs: [
    { label: 'Tune',   bank: 'p0', i: 0, min: -24, max: 24, step: 1 },
    { label: 'Start',  bank: 'p0', i: 1, min: 0, max: 1, step: 0.001 },
    { label: 'Gain',   bank: 'p0', i: 2, min: 0, max: 2, step: 0.01 },
    { label: 'Attack', bank: 'p1', i: 0, min: 0.001, max: 1, step: 0.001 },
    { label: 'Decay',  bank: 'p1', i: 1, min: 0.001, max: 2, step: 0.001 },
    { label: 'Sustain',bank: 'p1', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'Release',bank: 'p1', i: 3, min: 0.001, max: 2, step: 0.001 },
  ],
  autoTargets: [ /* mirror paramDefs with 3-char codes: TUN/STR/GAN/ATK/DEC/SUS/REL */ ],
  uploadVoiceUniforms: (gl, prog, vd) => {
    if (!vd.sampler) return;
    gl.uniform1fv(prog.u('uSmpSlot[0]'),      vd.sampler.slot);
    gl.uniform1fv(prog.u('uSmpBaseRow[0]'),   vd.sampler.baseRow);
    gl.uniform1fv(prog.u('uSmpLen[0]'),       vd.sampler.len);
    gl.uniform1fv(prog.u('uSmpRootFreq[0]'),  vd.sampler.rootFreq);
    gl.uniform1fv(prog.u('uSmpLoopStart[0]'), vd.sampler.loopStart);
    gl.uniform1fv(prog.u('uSmpLoopEnd[0]'),   vd.sampler.loopEnd);
    gl.uniform1fv(prog.u('uSmpLoopMode[0]'),  vd.sampler.loopMode);
  },
};
```

Append `isampler` to `REGISTRY` (`src/instruments/index.ts:28`) **at the very end**
(engine-type ids are positional and persisted). The `+ Add` menu and `INSTRUMENTS`
list derive from REGISTRY automatically — no extra wiring.

---

## 4. File load → PCM (UI + decode)

Precedent for binary-into-instrument is the DX7 SysEx loader
(`controls.ts:125–142`, `399–437`) and the song `FileReader` path
(`main.ts:1273–1291`).

- Add a sampler-specific control block in the instrument panel (when the selected
  instrument's `type === 'sampler'`). Mirror the dx7 `customControls` UI hook OR just
  conditionally append a section in the existing instrument-panel builder — match
  whatever pattern dx7 uses. It needs: a **"Load Sample…"** `<input type="file"
  accept="audio/*">`, a readout (filename + length in s), a **root-note** field
  (default 60), **loop mode** toggle, and **loop start/end** number inputs (frames or
  ms). Keep it minimal.
- Decode:
  ```ts
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: ENGINE_SR });
  const audio = await ctx.decodeAudioData(buf);
  let pcm = audio.getChannelData(0);                 // mono: channel 0
  if (audio.sampleRate !== ENGINE_SR) pcm = resampleLinear(pcm, audio.sampleRate, ENGINE_SR);
  ```
  - `ENGINE_SR` is the renderer/pipeline sample rate (grep how `SynthRenderer` /
    `pipeline` get theirs — usually 48000; pass the AudioContext that rate so decode
    resamples for you, but still guard with a manual linear resample for browsers
    that ignore the option).
  - Cap length: clamp to e.g. `SMP_ATLAS_W * (SMP_ATLAS_H / SMP_MAX_SLOTS)` frames and
    warn if truncated (don't silently drop — `MEMORY.md` "no silent caps" ethos).
- Write `instance.sample = { name, pcm, rootNote, loopStart:0, loopEnd:pcm.length, loopMode:0 }`,
  then call the renderer sync (`syncSamplerSlots`) and `markDirty('instrument')`.

---

## 5. Persistence (song-io + storage)

Storage already handles binary fine: `song-store.ts` gzips the song JSON to an
`ArrayBuffer` in IndexedDB — no 5 MB localStorage ceiling. So the only work is
**serializing `sample` in the song JSON** (`song-io.ts`), exactly like `ops`.

- Extend `SerializedInstrument` (`song-io.ts:36–47`) with:
  ```ts
  sample?: { name: string; rootNote: number; loopStart: number; loopEnd: number;
             loopMode: number; sr: number; pcm: string /* base64 Int16 */ };
  ```
- Serialize (`song-io.ts:113–124`, the `.map`): if `i.sample`, encode `pcm` as
  **Int16** (`f32 → clamp[-1,1] → ×32767`) then base64. Int16 ≈ half the size of
  Float32 and gzips well; the audible loss is negligible for v1. Store `sr` = engine
  SR at save time.
- Deserialize (the reverse, in `deserializeSong` / `instrumentsFromParams`): base64 →
  Int16 → Float32; if `sr !== ENGINE_SR`, resample. Rebuild `instance.sample`.
- Bump `SONG_FORMAT_VERSION` (`song-io.ts:23`) and handle older files in `migrate()`
  (absent `sample` → instrument simply has no audio; harmless).

> **Size flag (call out to Dave):** a few seconds of audio per instance can make
> songs multi-MB even gzipped. That's fine for IndexedDB but heavy for the
> JSON-file export path. Acceptable for v1; the future optimization is a separate
> IndexedDB `samples` store keyed by content-hash with songs referencing the hash
> (dedupes shared samples). **Do not build that now** — just leave a note.

- **Cloning/lifecycle:** in `engine.addInstrument` (`engine.ts:381–394`), nothing to
  do for a fresh sampler (no sample yet). Ensure any instance **deep-copy** path
  (duplicate-instrument, demo-fork) copies `sample` (share the `Float32Array` by
  reference is OK if instances are never mutated in place; safest is to copy the ref,
  not the buffer — document the choice). `removeInstrument`'s index remap
  (`engine.ts:398–423`) needs no change — `sample` rides along on the instance, and
  slots are re-derived by `syncSamplerSlots`.

---

## 6. Tests & verification (REQUIRED — this is the bar)

1. **`npm run build`** — TS/import check. Won't catch GLSL.
2. **`test/glsl-check.html`** — confirm it enumerates REGISTRY shaders so the new one
   is compiled/linked. If it has a hardcoded list, add `synth-sampler.glsl`
   (the EQ commit touched this file — see `git show f5bbd5b -- test/glsl-check.html`).
3. **New harness `test/sampler-check.html`** (model on `test/render-check.html` /
   `instance-check.html`, which drive `SynthRenderer` + `Engine` directly under
   headless Chrome + SwiftShader; title → `ALL_OK`/`FAILED`). Assert:
   - **Unity playback:** load a known ramp/sine PCM into a slot, trigger a note at
     `rootNote` → output reproduces the PCM (maxDiff small, accounting for linear
     interp + ADSR attack — use sustain region).
   - **Octave up:** note 12 semitones above root reads at ~2× rate (compare against
     PCM resampled ×2).
   - **Loop wrap:** forward loop with `loopStart/End` → output is periodic past
     `loopEnd` with the loop period.
   - **One-shot end:** past `len`, output is exactly 0.
   - **No sample / silence:** sampler instance with no `sample` → silent, finite, no
     NaN.
   - **Tiling correctness:** use a sample longer than `SMP_ATLAS_W` so the row-wrap
     (`pcmAt` row math + the `i+1` interp crossing a row boundary) is exercised.
   Run it the standard way (see `AGENTS.md` "Headless harnesses").
4. **Golden render:** adding an appended engine shouldn't change existing output.
   Confirm the `golden-render` checksum (`MEMORY.md` notes `0x5fc60c89`) is unchanged.
5. **Manual smoke (optional):** `npm run dev`, add a Sampler, load a wav, play notes,
   save+reload the song, confirm the sample survives the round-trip.

---

## 7. Suggested phase order (each phase independently verifiable)

1. **Atlas + renderer plumbing** — `samplerTex`, `syncSamplerSlots`, unit-4 binding,
   `VoiceData.sampler` + engine fill. (No audio yet — uniforms upload zeros.)
2. **Shader + descriptor + REGISTRY** — `glsl-check` green; sampler renders silence
   (no slots) without breaking other engines (`render-check` still `ALL_OK`).
3. **Programmatic PCM path + `sampler-check.html`** — inject PCM directly in the test
   (skip UI/decode); get all playback assertions green. **This is the correctness
   milestone.**
4. **Persistence** — serialize/deserialize `sample`; round-trip test.
5. **UI** — file load, decode/resample, root/loop controls.
6. **Docs + version bump** — `COMPOSING.md` (new engine's params/automation codes),
   `MEMORY.md` (the atlas design + the per-type-render/slot insight + deferred-work
   list), `README.md` engine list, bump `package.json` minor (new feature → 1.19.0).

Don't start a phase before the previous one's check is green. Keep the diff per phase
small enough to bisect.

---

## 8. Non-negotiables / gotchas checklist

- [ ] `isampler` appended at the **END** of REGISTRY (positional, persisted ids).
- [ ] `SMP_W` in GLSL == `SMP_ATLAS_W` in TS (tie with a comment on both).
- [ ] NEAREST atlas + manual linear interp (matches wavetable; `texelFetch` ignores
      filtering anyway).
- [ ] Don't re-upload PCM every block/knob-turn — only on sample change
      (`syncSamplerSlots` dirty check).
- [ ] Closed-form: always zero `outState/outPhase/outPhase2` and write silence on
      every early return (uninitialized MRT outputs = glitches — see 808/tanpura).
- [ ] No silent truncation on over-long samples — clamp + warn.
- [ ] `render-check`/`golden-render` unchanged for existing engines after the add.
- [ ] Stereo / multi-sample / mips are **deferred** — TODO comments only.
- [ ] Commit message `Co-Authored-By:` line per `AGENTS.md`; bump version before push.
