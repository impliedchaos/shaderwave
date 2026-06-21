# COMPOSING.md — authoring songs for ShaderWave

A practical guide for agents (and humans) to create songs **without reading the whole engine**.
Two ways to make a song:

1. **Demo song (recommended for authoring):** add a `SongDef` to the `DEMO_SONGS` array in
   `src/tracker/demo-songs.ts`. It shows up in the song dropdown. This guide is mostly about this.
2. **Loadable file:** a `*.shaderwave` file (compact binary; legacy `*.shaderwave.json` still
   opens) loaded with the editor's **LOAD** button, or a **Share** permalink (`#s=…`). Easiest
   produced by composing as a demo and clicking **SAVE** / **Share**, or generated programmatically.

Verify any song with `npm run build` (typecheck) — and do NOT hand-launch the headless GPU
harnesses for song-only changes (they're brutal on the machine; the author auditions in-browser).

---

## 1. Minimal working template

Copy this into the `DEMO_SONGS` array in `src/tracker/demo-songs.ts` and tweak. It's a complete,
valid song.

```ts
{
  name: "My Song",
  author: "AI Slop",
  note: "One-line description shown in the Song Editor. ALWAYS append the generation prompt here.",
  bpm: 120,
  master: DEFAULT_MASTER * 0.7,        // output gain; DEFAULT_MASTER*1.0 == 100%
  params: [                            // the INSTRUMENT TABLE — index = the `inst` used in cells
    { name: "Kit",  type: "808", p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
    { name: "Bass", type: "303", p0: [300, 0.8, 0.6, 0.4], p1: [0, 0.3, 0.4, 0] },
    { name: "Lead", type: "wvt", p0: [0.01, 0.4, 0.7, 0.4], p1: [0.0, 0.5, 0.07, 0.0], p2: [0, 0, 0, -1], p3: [0.8, 0.6, 0, 0] },
  ],
  fxParams: {                          // per-ENGINE-TYPE fx; start from defaults + override
    '808': Object.assign(defaultFxParams(), { distOn: true, dist: 4, master: 0.9 }),
    '303': Object.assign(defaultFxParams(), { delayOn: true, delayMix: 0.25, reverbOn: true, reverbMix: 0.2 }),
    'wvt': Object.assign(defaultFxParams(), { reverbOn: true, reverbMix: 0.3, width: 1.3, widthOn: true }),
  },
  data: () => {
    const N = 32;                      // rows per pattern
    const mk = () => new Pattern(N, 8);// ALWAYS 8 channels
    const pA = mk();
    const BD = 36, SD = 38, HH = 42;   // drum notes (see §4)
    const I_KIT = 0, I_BASS = 1, I_LEAD = 2;   // indices into params[]

    for (let r = 0; r < N; r++) {
      const s = r % 16;
      if (s === 0 || s === 8) pA.set(r, 0, BD, I_KIT, 0.95);       // kick (ch 0)
      if (s === 4 || s === 12) pA.set(r, 1, SD, I_KIT, 0.8);       // snare (ch 1)
      if (s % 2 === 1) pA.set(r, 2, HH, I_KIT, 0.4);               // hats (ch 2)
      if (s % 4 === 0) { pA.set(r, 3, 33, I_BASS, 0.8); pA.set(r + 1, 3, OFF, I_BASS); }  // bass (ch 3)
    }
    pA.set(0, 4, 60, I_LEAD, 0.8); pA.set(15, 4, OFF, I_LEAD);     // a held lead note (ch 4)

    return {
      patterns: [pA],
      order: [0, 0, 0, 0],             // play pattern 0 four times
      rowsPerBeat: 4,
    };
  },
},
```

`Pattern`, `OFF` are imported at the top of `demo-songs.ts`; so are `defaultFxParams`, `DEFAULT_MASTER`,
`tgt`, `normByte`, `defaultLfo`. Don't add imports unless you use something new.

---

## 2. `SongDef` anatomy

| field | meaning |
| --- | --- |
| `name` | song title (shown in the dropdown) |
| `author?`, `note?` | metadata shown in the Song Editor. `note` MUST contain the AI generation prompt! |
| `bpm` | tempo |
| `master?` | output gain, usually `DEFAULT_MASTER * x` (x≈0.5–0.8 to leave headroom) |
| `params` | the instrument table — an **array of instances** `{ name, type, p0, p1, p2?, p3?, ops? }` |
| `fxParams` | per-engine-**type** fx (one entry per type used; `Object.assign(defaultFxParams(), {…})`) |
| `data()` | returns `{ patterns, order, rowsPerBeat, lfos?, modRoutings?, pan? }` |

`data()` return:
- `patterns: Pattern[]`
- `order: number[]` — indices into `patterns`, in playback order (repeat freely)
- `rowsPerBeat: number` — usually 4
- `pan?: number[]` — per-channel base pan, length 8, `0`=L `0.5`=C `1`=R
- `lfos?`, `modRoutings?` — see §8

---

## 3. The `Pattern` API

```ts
const pat = new Pattern(rows, 8);              // channels is ALWAYS 8
pat.set(row, channel, note, instIdx, vol);     // place a note
pat.set(row, channel, OFF, instIdx);           // note-off (release) — vol omitted
pat.setFx(row, channel, cmd, val);             // effect-column command (per-cell articulation)
```
- `row` 0..rows-1, `channel` 0..7, `instIdx` = index into `params[]`, `vol` 0..1.
- **Effect column** (`setFx`, codes in `src/tracker/fx.ts`): `0` arpeggio · `1`/`2` pitch slide
  up/down · `3` tone portamento (meend, slides without re-attack) · `4` vibrato · `5` **note
  delay** for swing/humanize (`val/255` of ONE step later — `0x00` none, `0x80` half a step,
  `0xFF` ≈ a full step; the voice holds its previous note through the gap) · `0xA` volume
  slide. One command per cell. Pitch effects (`0`/`1`/`2`/`3`/`4`) now work click-free on **every
  pitched engine** — the phase-accumulating ones (303, Moog, Wavewright) and the closed-form ones
  (Pipi, Gigi, Tanpura, Tabla, 888State, DX7, Sampler), which follow the pitch change via a
  fundamental-phase correction (`uPhaseOff`). The drum engines (808, Groove) ignore pitch.
- A channel is monophonic: a new note on a channel replaces the previous. For a **chord**, use
  several channels with the same `instIdx`.
- **channel index == voice index == pan index** (8 channels, 8 voices).

---

## 4. Notes & the drum map

Notes are **MIDI numbers**: middle C = **60**, A4 (440 Hz) = 69, +12 = up an octave.

**Drum engines (808; e8e drum presets)** ignore pitch — the note selects a drum **slot**:

| note | drum |
| --- | --- |
| 36 | Kick (BD) |
| 38 | Snare (SD) |
| 42 | Closed hat (HH) |
| 46 | Open hat (OH) |
| 39, 41, 45, 48, 56 | extra slots (clap/toms/cymbal-ish) |

---

## 5. Instruments & their param banks

`type` is one of the engine ids below. `p0`/`p1` (and `p2`/`p3` where shown) are 4-float banks;
each slot's meaning is listed. **The fastest correct way to set an instrument: copy a preset's
banks (shown) and tweak.** Only `p0`/`p1` are automatable/LFO-targetable (see §7–8).

```
303  (TB-303)      p0=[Cutoff(Hz), Reso, EnvMod, Accent]  p1=[Wave(0saw/1sq/2tri/3sine/4noise), FiltDecay, AmpDecay, PulseW]
                   PulseW warps ALL four shapes (not just square); 0.5 neutral, legacy 0 → 0.5
                   preset: p0=[400,0.72,0.6,0.4] p1=[0,0.3,0.4,0.5]
808  (TR-808 DRUM) p0=[slot, Tone, Decay, Snappy]  (slot is set from the note; leave 0)
                   preset: p0=[0,0.6,0.5,0.6] p1=[0,0,0,0]
moog (Minimoog)    p0=[Cutoff, Reso, EnvAmt, KbdTrack]  p1=[Detune, AmpSus, FiltDecay, AmpDecay]
                   p2=[Osc1 Wave, Osc2 Wave, Osc3 Wave, Glide]  p3=[Osc1 Oct, Osc2 Oct, Osc3 Oct, Noise]
                   preset: p0=[800,0.45,0.5,0] p1=[8,0.8,0.6,0.9] p2=[1,1,1,0] p3=[2,2,2,0]
wvt  (Wavewright)  p0=[Attack, Decay, Sustain, Release]  p1=[Pos1, Pos2, Detune2, FM]
                   p2=[Bank1(0-15), Bank2(0-15), Sub, SubOct]  p3=[Level1, Level2, EnvPos1, EnvPos2]
                   banks: 0 Classic 1 Harmonic 2 PWM 3 Formant 4 Resonant 5 Metallic 6 Wavefolder
                          7 Digital 8 Organ 9 Sync 10 Saturate 11 Comb 12 Skew 13 Noise 14 Power 15 Glass
                   preset: p0=[0.01,0.4,0.8,0.4] p1=[0,0.5,0.08,0] p2=[0,0,0,-1] p3=[0.8,0.6,0,0]
e8e  (888State)    p0=[Attack, Decay, Sustain, Release]  p1=[Detune2, Detune3, Bits, Drive]
                   p2=[Wave1, Wave2, Wave3, Oscs]  p3=[Level1, Level2, Level3, PulseW]   waves: 0 sine 1 saw 2 square 3 tri 4 noise
                   PulseW now warps ALL shapes (sine/saw/tri too, not just square); 0.5 neutral
                   preset: p0=[0.005,0.25,0.6,0.25] p1=[0.12,-12,8,0] p2=[2,2,3,2] p3=[1,0.8,0.5,0.5]
dx7  (FM)          Operator/SysEx-ROM editor — set via presets/ops, not simple banks. Easiest: copy an
                   existing dx7 instance's `ops` from another demo song.
tanpura (Drone)    p0=[Decay, Jivari, Bright, Pluck]  p1=[Partials, Inharm, Bloom, Attack]  preset: p0=[3,0.6,0.06,0.13] p1=[48,0.00008,0.25,0.005]
groove (Vinyl)     p0=[Hiss, Crackle, Pop, Wear]  p1=[Cycle, Tone, Rumble, Drift]  p2=[RPM, Defects, Color, Fade]  (play as a drone; pitch ignored)
tabla              p0=[Decay, Damp, Strike, Bend]  p1=[Modes, Inharm, BendTime, Tone]
pipi  (Piano)      p0=[Decay, Inharm, Hardness, Hammer]  p1=[Partials, Detune, Damping, Release]  preset: p0=[4.5,0.0004,0.55,0.3] p1=[26,0.0015,0.8,0.15]
guitar (Gigi)      p0=[Decay, PluckPos, Tone, Body]  p1=[Partials, Drive, Pick, Release]  preset: p0=[2.5,0.18,0.65,0.92] p1=[28,0,0.45,0.12]
sampler (PCM)      p0=[Tune(st), Start, Gain, _]  p1=[Attack, Decay, Sustain, Release]  preset: p0=[0,0,1,0] p1=[0.001,1,1,0]
                   Author by URL: give the param a `sample` built with the `smp(name, slug, rootNote?)`
                   helper — `slug` is a file in `public/samples/` (no extension); PCM is fetched/decoded
                   on load (App._hydrateSampleUrls). One-shot vox: p1=[0.001,0.1,1,rel] (sustain=1, the
                   sample ends itself). Melodic samples: set rootNote to the recorded pitch (e.g. 69=A4).
                   See "Larynx Yard Sale" for a full example. (Or load a file in the UI + Save to embed PCM.)
additive (Spectra) p0=[Partials 1..2048, Tilt 0..1 (dark↔bright), Stretch 0..1 (inharmonicity), Morph 0..1 (formula↔analyzed sample)]
                   p1=[Decay s (0=sustain), DecayTilt 0..1 (highs die faster), Detune 0..1 (spread), Comb 0..1]
                   p2=[Attack s, Release s, Odd/Even 0..1, Coherence 0..1 (0=phase wash↔1=coherent strike)]
                   p3=[Shimmer 0..1 (per-partial anim), Formant pos 0..1 (150–5000 Hz), Formant amt (0=off), Formant BW oct]
                   p4=[STEREO spread 0..1 (0=mono, partials fanned L↔R), -, -, -]   GPU-parallel additive, up to 2048
                   partials/voice. The only STEREO engine — spread spatialises the partials (pad/swarm presets ship wide;
                   plucks/bells stay mono). Big sustained pads/organs/bells/metallic. Tilt/Stretch/Morph/Formant/Shimmer/
                   Stereo are all great LFO/automation targets (codes TLT/STR/MOR/FMP/SHM/SPR). Resynthesis: give an
                   instance a `sample` and Morph crossfades the synth spectrum into its analyzed harmonic profile.
                   preset: p0=[1536,0.45,0.04,0] p1=[0,0.5,0.5,0] p2=[0.4,1.0,0,0.2] p3=[0.5,0.35,0.8,0.8] p4=[0.7,0,0,0] (wide choir pad)
```
For the exact, current truth on any engine see its descriptor `paramDefs` + `presets` in
`src/instruments/i<type>.ts`. New engines added later will appear there.

---

## 6. fxParams (per engine type)

Each engine **type** used in the song gets one fx entry. Start from `defaultFxParams()` and override.
The chain is: Compressor → Filter → EQ → Pitch Shifter → Vocoder → Overdrive → Distortion → Chorus → Tremolo → Delay → Reverb → Bitcrusher → Width → Limiter → Output.
The order is **reorderable per instrument instance** (each instance can carry an `fxOrder: string[]` of
effect keys; absent → default; unknown keys dropped + missing ones appended on load).

Common fields (booleans + scalars):
`enabled` (master), `distOn`/`dist`/`tone`/`level`, `odOn`/`odDrive`/`odTone`/`odLevel`,
`filterOn`/`filterCutoff` (Hz)/`filterReso` (0..1 Q)/`filterMode` (0 LP·1 HP·2 BP)/`filterMix`,
`eqOn`/`eqLow`/`eqMid`/`eqHigh` (dB)/`eqLowFreq`/`eqHighFreq` (Hz crossovers),
`chorusOn`/`chorusMix`/`chorusRate`/`chorusDepth`, `tremoloOn`/`tremoloMix`/`tremoloRate`,
`delayOn`/`delayTime`/`delayFeedback`/`delayMix`, `reverbOn`/`reverbDecay`/`reverbDamp`/`reverbSend`/`reverbMix`,
`bitcrushOn`/`bitcrushBits`/`bitcrushRate`/`bitcrushMix`, `widthOn`/`width`, `master` (fx output level),
`compOn`/`compThresh` (dB)/`compRatio`/`compAttack` (ms)/`compRelease` (ms)/`compMakeup` (dB)/`compSource`,
`limitOn`/`limitCeil` (dB)/`limitRelease` (ms),
`vocoderOn`/`vocSource`/`vocBands` (1..16)/`vocQ`/`vocAttack` (ms)/`vocRelease` (ms)/`vocMix`/`vocUnvoiced`/`vocFormant` (semitones),
`pitchOn`/`pitchShift` (voice-1 interval)/`pitchMix` (dry/wet)/`pitchVoice2`/`pitchVoice3`/`pitchVoice4` (harmony intervals) + `pitchV2Level`/`pitchV3Level`/`pitchV4Level` (per-voice levels, 0 = off)/`pitchKey` (0..11, C..B)/`pitchScale` (0 = Off→raw semitones, else 1 Major·2 Minor·3 HarmMin·4 Dorian·5 Phrygian·6 Lydian·7 Mixolyd·8 Locrian → intervals become diatonic scale **steps** snapped to the played note, e.g. `pitchVoice2:2` = a third in key)/`pitchSpread` (0 = mono, fans the harmony voices L↔R). Automation codes: PSH/PSM/PH2/PHL/PH3/PL3/PH4/PL4/PSP.
The resonant **Filter** is per-sample recursive (LP/HP/BP); its `filterCutoff` (target code `FLC`, log)
is the marquee LFO sweep target — pair it with a synced LFO for filter-sweep risers/wobbles. The
**Compressor** + **Limiter** are also per-sample (stereo-linked envelope follower); all their params are
fx-scope automation/LFO targets too (codes `CMT`/`CMR`/`CMA`/`CML`/`CMK` + `CMO`; `LMC`/`LMR` + `LMO`).
The **Vocoder** imposes a modulator instance's spectral envelope onto its carrier (the instance it
sits on). `vocSource` is the modulator's **instrument-instance index** (the SAME sidechain dry bus the
compressor's `compSource` keys off; -1 = off; max 15). So put the vocoder on a harmonically-rich
carrier (saw pad, e8e, wvt) and point `vocSource` at a voice/sampler instance — that instance still
plays audibly, so turn its `master`/level down if you only want it as the modulator. Bands/Q/Attack/
Release/Mix/Unvoiced are fx-scope automation/LFO targets (`VCB`/`VCQ`/`VCA`/`VCR`/`VCM`/`VCU` + toggle
`VCO`); `VCQ` or `VCM` under an LFO gives talk-box-style movement. **Intelligibility tips:** (1) the
carrier must be BRIGHT — a saw/pulse/e8e/bright-wvt carries formants; a sine/triangle has no highs so
upper formants go silent. (2) `vocBands` 16 (the default) covers the speech range gap-free; fewer bands
leave holes between formants. (3) `vocUnvoiced` (default 0.5) passes the modulator's own sibilance
(s/t/f/sh — broadband noise a tonal carrier can't voice) through ungated; raise it for crisper
consonants, drop to 0 for a purely tonal/robotic vocode. (4) `vocFormant` (±12 st, target `VCF`)
shifts the formant peaks up/down **without changing pitch** (pitch is the carrier's note) — up =
smaller/brighter/"chipmunk", down = bigger/darker; great as an automation/LFO target for talking
sweeps. Resolution is limited by `vocBands`, so big shifts smear; ±7 st is the natural musical range.

```ts
'303': Object.assign(defaultFxParams(), { distOn: true, dist: 10, delayOn: true, delayMix: 0.3, master: 0.85 }),
```
NOTE: `defaultFxParams()` now defaults **every effect OFF** (the param baselines are kept, so opting
in needs only the flag, e.g. `reverbOn: true` → reverb at its default mix). So enable each effect you
want with its `…On: true` and set the `…Mix`/scalars. (`+ Add` in the editor uses the same all-off
`neutralFxParams()` baseline; demo songs build on `defaultFxParams()`.)

**Crucial advice for the 808:** Delay on the 808 sounds terrible in most mixes. Always explicitly disable it (`delayOn: false`) unless you're designing a sparse, dubby effect!

---

## 7. Automation tracks (per-pattern parameter lanes)

Sequence one parameter over a pattern's rows. Each row holds a normalized **byte 0–255** (or `-1`
= hold). Use the `tgt(type, code)` helper to resolve a target, and `normByte(target, realValue)` to
convert a real value to its byte.

```ts
const CUT = tgt('303', 'CUT');                          // a target (see codes below)
const track = pat.getOrCreateAutoTrack(I_BASS, CUT.id); // returns the row data (Int16Array)
for (let r = 0; r < N; r++) track[r] = normByte(CUT, 400 + r * 30);   // sweep cutoff up
```
- First arg to `getOrCreateAutoTrack` is the **instrument index** for `inst`/`fx` scope, the
  **channel index** for `chan` scope, and ignored for `global`. Scope is derived from the param id.
- **Codes by scope:**
  - `inst` (per engine, pass the matching instrument index): e.g. `303`: CUT RES ENV ACC WAV FDC ADC PWM ·
    `moog`: CUT RES FEN DTC SUS FDC ADC · `wvt`: ATK DEC SUS REL PS1 PS2 DT2 FM · `808`: TON DEC SNP ·
    `e8e`: ATK DEC SUS DT2 DT3 BIT DRV · `sampler`: TUN STR GAN ATK DEC SUS REL · (others in their descriptors).
  - `fx` (engine-agnostic): LVL DRV OVD OVT OVL DLM DLF RVM RVD CHM WID BCB BCR BCM, plus on/off
    **toggles** DSO OVO CHO TRO DLO RVO WDO BCO (byte 0 = off, anything else = on).
  - `chan`: PAN (pass the channel index). `global`: BPM, VOL.

---

## 8. Global LFOs & the mod matrix

**Four** song-wide LFO **sources** + a list of **routings** (a source → a target, with depth). One
source can drive many targets. Return them from `data()`. If you return fewer than 4 LFOs they're
padded to 4 (LFO 3 = the pump); you only need to specify the ones you use.

```ts
const PS1 = tgt('wvt', 'PS1'), RVM = tgt('wvt', 'RVM');
const LVL_BASS = tgt('303', 'LVL'), LVL_PAD = tgt('wvt', 'LVL');
return {
  patterns: [...], order: [...], rowsPerBeat: 4,
  lfos: [
    { ...defaultLfo(), shape: 0, sync: true, rateBeats: 16 },                         // LFO 0: slow sine, 4 bars
    { ...defaultLfo(), shape: 6, sync: true, rateBeats: 2, wtBank: 2, wtPos: 0.5 },   // LFO 1: wavetable (PWM), 1/2 bar
    { ...defaultLfo(), shape: 3, sync: true, rateBeats: 1 },                          // LFO 2: 1-beat saw (general source)
    { ...defaultPumpLfo() },                                                          // LFO 3: the ducking pump (1 beat)
  ],
  modRoutings: [
    { source: 0, targetParamId: PS1.id, targetInstIdx: I_LEAD, depth: 0.45, bipolar: true },  // LFO0 → lead Pos1
    { source: 0, targetParamId: RVM.id, targetInstIdx: I_LEAD, depth: 0.30, bipolar: false }, // LFO0 → lead reverb mix (fx)
    { source: 3, targetParamId: LVL_BASS.id, targetInstIdx: I_BASS, depth: 0.7, bipolar: true }, // PUMP → bass Level
    { source: 3, targetParamId: LVL_PAD.id,  targetInstIdx: I_PAD,  depth: 0.6, bipolar: true }, // PUMP → pad Level
  ],
};
```
- LFO source fields: `shape` (0 sine, 1 tri, 2 square, 3 saw, 4 S&H, 5 ramp, 6 wavetable, **7 pump**),
  `sync` (true = `rateBeats`, false = `rateHz`), `rateBeats`, `rateHz`, `wtBank`, `wtPos` (shape 6).
- **Pump (shape 7 / `defaultPumpLfo()`):** a one-sided DOWNWARD ducking envelope — full duck on the
  beat, swelling back to no-duck by the cycle's end. Route it to instruments' **`LVL`** (or any
  Level/amp) to sidechain them to the beat; leave the kick/drum unrouted so it punches through. It
  always ducks down regardless of the routing's `bipolar` flag. `rateBeats: 1` = one duck per beat.
- Routing fields: `source` (index into `lfos`, 0–3), `targetParamId` (a `tgt(...).id`), `targetInstIdx`
  (instrument index for inst/fx, channel for chan/PAN, `null` for global), `depth` 0..1, `bipolar`,
  `invert` (optional — negates the offset; route ONE source to two targets, invert one, and they move
  in opposite directions: e.g. cutoff up while reverb mix down).
- BPM is excluded as an LFO target (keeps export length exact).

### 8.1 Per-instrument mod matrix (LFOs + envelope, incl. vibrato)

Separate from the song-wide LFOs above: **each instrument INSTANCE** can carry its OWN matrix —
a fixed bank of **2 LFOs + 1 mod-envelope** + routes to that instance's own params. It travels with
the instrument (into presets/saves), so reach for it when the movement is part of the *patch* (a
wavetable that breathes, vibrato on a lead) rather than an arrangement-wide sweep. Author it on an
`InstrumentSpec` (the `params: InstrumentSpec[]` form — NOT the keyed-record form) via `mod`:

```ts
// targets come from instModTargetsForType(type): this engine's inst params + all fx + Pitch.
params: [
  { type: 'wvt', /* p0/p1/... */ mod: {
    sources: [
      { kind: 'lfo', retrigger: false, amount: 1, lfo: { ...defaultLfo(), sync: true, rateBeats: 8 }, env: { a:0.01,d:0.3,s:0.6,r:0.4 } }, // LFO 1
      { kind: 'lfo', retrigger: true,  amount: 0, lfo: { ...defaultLfo(), sync: false, rateHz: 5.5 }, env: { a:0.01,d:0.3,s:0.6,r:0.4 } },  // LFO 2 (per-note, starts silent)
      { kind: 'env', retrigger: false, amount: 1, lfo: { ...defaultLfo() }, env: { a:0.4, d:0.8, s:0.0, r:0.5 } },                          // mod-env
    ],
    routes: [
      { source: 0, targetParamId: tgt('wvt','PS1').id, depth: 0.5, bipolar: true },   // LFO1 → wavetable Pos
      { source: 1, targetParamId: PITCH_WVT, depth: 0.03, bipolar: true },            // LFO2 → vibrato (see below)
      { source: 2, targetParamId: tgt('wvt','RVM').id, depth: 0.6, bipolar: false },  // mod-env → reverb mix
      { source: 2, targetParamId: L2M, depth: 0.5, bipolar: false },                  // mod-env → LFO2 Amount (vibrato fade-in)
    ],
  } },
],
```
- **Slot layout is FIXED:** `sources[0]` & `[1]` are the LFOs, `sources[2]` is the envelope. Always
  provide all three (`normalizeInstMod` forces the kinds by position). Easiest: import `defaultInstMod()`
  from `tracker/instmod.ts` and mutate the slots you want.
- **`kind:'env'`** is a dedicated mod-envelope (its own A/D/S/R, 0..1), note-gated — it always
  retriggers and releases per voice (the `retrigger` flag is ignored for env). It is NOT the engine's
  amp envelope.
- **`retrigger`** (LFOs only): `true` = phase restarts at each note-on (per-patch feel); `false` =
  free-runs on song time like the global LFOs.
- **Vibrato:** route to the engine's **Pitch** target. There's one per pitched engine (drums excluded);
  get its id with `instModTargetsForType(type).find(t => t.pitch)!.id`. `depth` is a fraction of
  ±12 semitones (so `depth 0.03` ≈ ±0.36 st — a gentle vibrato). Pitch is intentionally NOT a
  `tgt(...)` automation target (it'd fight note triggers), so it's only reachable from this matrix.
- Route fields: `source` (0–2), `targetParamId`, `depth` 0..1, `bipolar`, `invert` (optional — negates
  the offset; route one source to two targets and invert one for opposite motion).
- **`amount`** (per source, 0..2, default 1): a master multiplier on EVERY route from that source —
  and itself a modulation target (see below). Start a source at `amount: 0` to have it produce nothing
  until another source opens it up.
- **Sources can modulate EACH OTHER (modsrc targets).** Besides inst/fx/pitch, a route's target can be
  another source's knob: **LFO Rate / WtPos / Amount** and **Env A/D/S/R / Amount**. These aren't
  `tgt(...)` targets — resolve them with `modSrcTargets()` (from `tracker/automation.ts`), e.g.
  `const L2M = modSrcTargets().find(t => t.code === 'L2M')!.id;` (codes: `L1R L1W L1M` for LFO 1
  rate/wtpos/amount, `L2R L2W L2M` for LFO 2, `EnA EnD EnS EnR EnM` for the env). A source may not
  target its OWN slot (no LFO1→LFO1), but
  LFO1→LFO2, env→LFO Amount (vibrato/movement fade-in), LFO→env shape, etc. all work. Source→source
  links carry one render-block (~11 ms) of latency, which is inaudible. Modulating an LFO's **Rate**
  switches it to phase-accumulation so the rate change stays click-free.
- The **global** song-wide LFOs (§8) can ALSO target these per-instrument source knobs — pick the
  `i:SHORT · LFO 1 Rate`-style entries in the routing dropdown — so an arrangement LFO can sweep an
  instrument's own LFO/env.
- Routes with no target / `depth 0` are inert; an instance with no `modsrc`/amount movement renders
  bit-identically to before (the closed-form LFO path is preserved when a rate isn't being modulated).

---

## 9. Order & duration

A 64-row pattern lasts `64 * 60 / (bpm * rowsPerBeat)` seconds. At 120 BPM / `rowsPerBeat 4`,
that's 8 s. Build a few patterns and repeat them in `order` to reach the length you want, e.g.
`order: [0, 1, 1, 2, 1, 1, 3]`.

---

## 10. Gotchas (these bite)

- **`inst` is an index into `params[]`, NOT a channel.** Automation/LFO `targetInstIdx` for
  `inst`/`fx` scope is also the **instrument index** — passing a channel number is the classic bug.
- **8 channels, always.** `new Pattern(rows, 8)`.
- **Every instrument in `params` should be played by ≥1 note**, else it's pruned on load and indices
  shift (which would mis-target automation/LFOs that point at it).
- **Drum notes pick a slot, not a pitch** (808). Use 36/38/42/46.
- **`OFF`** ends a note; without it, notes ring until the next note on that channel.
- **Hanging notes across pattern boundaries.** A note still sounding at a pattern's end keeps
  ringing into the next pattern until *that channel* plays again — so a sustained voice (pad, clav,
  horn stab) bleeds into sections that don't replay it. Two traps make this easy to miss: a note on
  (or near) the **last row** whose `OFF` lands past the last row is a silent no-op, and a channel that
  simply isn't replayed in the next pattern has nothing to cut it. **Fix (the standard idiom): drop an
  `OFF` on row 0 of each pattern for every channel that isn't already retriggering there.** Channels
  that *do* start on row 0 retrigger anyway, so leave those (and usually the drums) alone:
  ```ts
  const killHang = (pat) => {
    for (let ch = 3; ch < 8; ch++) if (pat.note(0, ch) === EMPTY) pat.set(0, ch, OFF, 0);  // melodic chans
  };
  [pA, pB, pC].forEach(killHang);   // after all notes are placed, before returning
  ```
  (`EMPTY` is exported from `./pattern.js`.) See "All That and a Bag of Dicks" for a worked example.
- **Headroom:** keep `master` ≤ ~`DEFAULT_MASTER * 0.8` and watch summed levels; the signal is 32-bit
  float internally (can exceed ±1) but the master/limiter stage and your ears decide.

---

## 11. Verify

```bash
npm run build      # typecheck — catches most authoring mistakes
```
For a deeper check (no GPU needed), the song-load path can be exercised under node by bundling with
esbuild (`--loader:.glsl=text`) and calling `loadSongInstruments(song)` over `DEMO_SONGS` — it must
not throw or leave `undefined` holes in the instrument table. Then audition in-browser.

---

## 12. The `*.shaderwave.json` file format (for LOAD)

Best produced by composing as a demo and clicking **SAVE**, or generated programmatically — it's
verbose to hand-write (patterns store flat arrays). Shape (format `shaderwave-song`, version **1**):

```jsonc
{
  "format": "shaderwave-song", "version": 1,
  "name": "...", "author": "...", "note": "...",
  "bpm": 120, "rowsPerBeat": 4, "master": 0.7,
  "pan": [0.5, 0.5, ...],                       // length 8
  "instruments": [                              // = params, each with its OWN fx (not per-type)
    { "name": "Bass", "type": "303", "color": "#...", "p0": [...], "p1": [...], "fx": { ...FxParams } }
  ],
  "order": [0, 1, 1],
  "patterns": [
    { "rows": 32, "channels": 8,
      "notes": [...], "inst": [...], "vol": [...], "fxCmd": [...], "fxVal": [...],   // flat, length rows*channels
      "autoTracks": [ { "scope": "inst", "instIdx": 0, "paramId": 0, "data": [...] } ] }  // data length = rows
  ],
  "lfos": [ { "shape": 0, "sync": true, "rateBeats": 4, "rateHz": 1, "wtBank": 0, "wtPos": 0 } ],
  "modRoutings": [ { "source": 0, "targetParamId": 4, "targetInstIdx": 0, "depth": 0.4, "bipolar": true } ]
}
```
Key differences from a demo `SongDef`: instruments carry their **own** `fx` (not a per-type map),
and pattern note/inst/vol/fxCmd/fxVal are **flat arrays** of length `rows*channels` (row-major:
`index = row*channels + channel`; empty note = the `EMPTY` sentinel, note-off = `OFF`). `paramId` is
the frozen automation target id (resolve from a code via the editor or `targetByCode`).

---

*Keep this file current as the engine grows — it's the contract for song authoring. When you add an
instrument/effect/automation target, update §5–8 here.*
