# Changelog

All notable changes to **ShaderWave** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project follows [Semantic Versioning](https://semver.org/). The version
in `package.json` is the source of truth; see **AGENTS.md → Git** for the bump +
changelog rules. Dates are the commit date of that version.

## [2.15.0] — 2026-06-21
### Added
- **Scale-aware harmonizer + more voices in the Pitch Shifter.** Pick a **Key** (C..B)
  and **Scale** (Major / Minor / Harmonic Minor + Dorian, Phrygian, Lydian, Mixolydian,
  Locrian) and each harmony interval snaps **diatonically** to the note you're playing —
  a "+2" is always a third *in the key* (major or minor depending on the degree), "+4" a
  fifth, and so on. No pitch detection: being a tracker, the engine already knows the note
  and feeds the chain the instance's lowest active voice. With **Scale = Off** intervals
  stay raw chromatic semitones (existing patches are unchanged).
- **Two more harmony voices** (now dry + up to 4 pitched voices = a full chord): **Harm 3 /
  Harm 4** with their own interval + level, plus a **Spread** knob that fans the harmony
  voices across the stereo field. New automation targets `PH3`, `PL3`, `PH4`, `PL4`, `PSP`.
  Defaults (levels 0, spread 0, Scale Off) keep the effect bit-identical to 2.14.0.

## [2.14.0] — 2026-06-20
### Added
- **Pitch Shifter effect (octave pedal / harmonizer).** A new effect in the chain
  (after EQ): a time-domain granular pitch shifter that reads a history ring back at a
  shifted rate, with two crossfaded grains to stay click-free. **Pitch** sets the
  interval (±24 st; ±12 = octave pedal), **Mix** the dry/wet blend. A second
  **Harmony** voice (own interval + **Harm Lvl**) stacks dry + two pitched voices for a
  chromatic harmonizer. All four params are automatable (`PSH`, `PSM`, `PH2`, `PHL`).
  Intervals are fixed/chromatic (not scale-aware); mono lines track best, dense chords
  warble like a real octave pedal.
### Fixed
- **Vocoder bypass feedback loop.** When bypassed, the vocoder only bound texture unit 1,
  leaving a stale unit-0 binding that could equal its own render target → a GPU feedback
  loop silently dropped the draw (silence). It now binds unit 0 like every other effect.
  Surfaced by the new pitch shifter (whose chain position triggered the aliasing), but a
  latent hazard for any chain.

## [2.13.0] — 2026-06-20
### Added
- **Spectra Freeze** (resynthesis). A new `Freeze` knob (and `FRZ` automation target) holds
  a loaded sample's analyzed spectrum indefinitely — turning a decaying/plucked timbre into
  an infinite sustained pad with that instrument's harmonic fingerprint. Freezing biases the
  held spectrum toward the bright attack (a pluck's sustain frames are near-silent), so
  percussive samples become rich drones rather than fading out. Automate `FRZ` to sweep a
  held note from natural decay into a frozen drone. New **Glacier (freeze)** preset showcases
  it (kalimba → shimmering glacial pad). Freeze at 0 is bit-identical to the formula/resynth
  spectrum.

## [2.12.1] — 2026-06-20
### Changed
- **Retuned the Spectra bowed-string presets** (Violin, Cello, Double Bass) so they read
  as focused bowed strings instead of a diffuse synth-strings wash: raised coherence out
  of the near-zero random-phase range, balanced the odd/even mix (was even-heavy, which
  put the octave above the fundamental and smeared the pitch), and added detune, a touch
  of natural inharmonicity, and tasteful per-instrument body formants.

## [2.12.0] — 2026-06-20
### Changed
- **Spectra resynthesis is now time-varying** (Phase 2 "deepen analysis"). Loading a
  sample no longer captures a single averaged spectrum — the analysis extracts an
  **attack** spectrum, a **sustain** spectrum, and a **per-harmonic decay rate**. A
  resynth voice now opens with a bright, complex strike that settles into the body, and
  each harmonic dies at the rate measured from the sample (highs typically decaying
  faster) — so plucked/struck resynth (e.g. the Kalimba preset) rings out naturally
  instead of sounding frozen. Pitch detection gained sub-bin (parabolic) refinement.
- Morph at 0 (or no sample) is unchanged — bit-identical to the formula spectrum.
- Re-tuned the **Kalimba (resynth)** preset to let the sample's own decay drive the tone.

## [2.11.0] — 2026-06-20
### Added
- **Mod-matrix self-targeting + global → per-instrument source modulation.** A
  per-instrument mod source (LFO 1/2, Env) is now a modulation *target*, reachable
  from both the per-instrument matrix (sources modulating each other) and the
  global LFO matrix. Targetable knobs: LFO **Rate / WtPos / Amount** and Env
  **A/D/S/R / Amount**.
- New per-source **Amount** (0–2) master multiplier on every route from a source —
  itself modulatable (e.g. Env → LFO Amount = vibrato/movement fade-in).
- "Amt" slider on every source panel; modsrc entries in the route + global routing
  dropdowns (a route can't target its own slot).
### Changed
- A modulated LFO Rate switches that source to phase accumulation so the rate
  change stays click-free; an unmodulated rate keeps the closed-form path
  (bit-identical to before). Source→source links carry one render block of latency.

## [2.10.x] — 2026-06-19 → 2026-06-20
- Gist sharing, preset-explorer popup, box-selection interpolation, and a batch of
  UI fixes (2.10.0).
- Header layout, Shift-click box selection, Spectra "Add Auto Track" fix,
  mod-matrix channel labels, song-picker fix.
- Narrower sidebar on small screens; move the Add Instrument button; 888State bits
  range fix.
- Docs sync across README/COMPOSING/AGENTS/ROADMAP; removed the obsolete design.md
  stub (2.10.3–2.10.4).
- Gist-token paste-dialog fixes — survive opening the token page / declining the PAT
  (2.10.5–2.10.6).
- Interpolate button shows a disabled style when a selection isn't rampable (2.10.7).

## [2.8.0] — 2026-06-19
### Added
- Compact **binary song format** (`SWB1`) + **permalink sharing** (`#s=` fragment),
  with gzip and legacy-JSON fallback on load.

## [2.7.0] — 2026-06-19
### Added
- Preset explorer: **A/B compare**, **morph** slider, and **randomize / nudge**.

## [2.6.0] — 2026-06-19
### Added
- **User presets** (save/load/rename/delete + single-preset import/export) and a
  dedicated **Instrument editor tab**.

## [2.5.0] — 2026-06-18
### Added
- **Per-instrument modulation matrix** — each instance owns 2 LFOs + 1 mod-envelope
  + routes to its own params, including click-free **vibrato** (Pitch target).
- Per-route **invert** switch on both matrices (2.5.4); envelope visualizer in the
  mod-matrix UI.
### Changed
- Automation targets regrouped, pitch block moved last (id-stable) (2.5.3).
- Exposed Distortion Tone + Level and filled remaining fx-target gaps (2.5.1–2.5.2).

## [2.3.0] — 2026-06-18
### Added
- **Stereo additive engine (Spectra)** + a stereo-capable mix bus.
- GitHub Pages build/deploy workflow (2.3.1).
### Changed
- `defaultFxParams()` now defaults every effect **off** (2.3.3).
- Skip idle engines + tuned `subBlock` for performance (2.3.4).
### Fixed
- Arpeggio mid-block NaN (2.3.4); 808 delay/demo tweaks (2.3.2).

## [2.2.0] — 2026-06-18
### Added
- Inst-scope automation for the **p2/p3** banks; reworked the Tantric demo.

## [2.1.0] — 2026-06-17
### Added
- **Spectra expressivity:** phase coherence, per-partial shimmer, movable formant,
  velocity → brightness.

## [2.0.0] — 2026-06-17
### Added
- **Spectra** GPU-parallel additive engine with presets + custom-sample resynthesis.
- Theming / **light mode**, plus quality-of-life polish.

## [1.37.0] — 2026-06-17
### Added
- Effect-column **pitch articulation on every engine** + demo "Slide Into My Pitches".

## [1.36.0] — 2026-06-17
### Added
- Second piano octave on the upper (Q) computer-keyboard row.

## [1.35.0] — 2026-06-16
### Added
- **Guitar (Gigi) realism overhaul** + mariachi-rock demo; grande-finale pattern
  (1.35.1).

## [1.34.0] — 2026-06-16
### Added
- **Piano (Pipi) realism overhaul** + per-engine `fxDefaults`.
- 888State pad presets (1.34.1); four genre demos — jazz, synthwave, vaporwave, DnB
  (1.34.2).
### Fixed
- Pipi chord clipping (per-voice detune, coherent strike) and output headroom
  (1.34.5–1.34.7); demo level/FX tweaks (1.34.3–1.34.4, 1.34.8–1.34.9).

## [1.33.0] — 2026-06-16
### Added
- **Live recording** — the record button arms notes + automation at the playhead;
  documented in help/README (1.33.1).

## [1.32.0] — 2026-06-16
### Added
- Demo "Vaffanculo in D Minor" (orchestral adagio build).
### Changed
- LFOs relabeled to zero-count (LFO 0–3) everywhere (1.32.1).

## [1.31.0] — 2026-06-16
### Added
- Demo "Too Drunk to Suck".
### Fixed
- Moog bass mix in "Nonconsensual"; sample/preset URL resolution for subpath
  deploys (1.31.1); Gigi short name GIG → GTR (1.31.2).

## [1.30.0] — 2026-06-15
### Added
- **Pulse-width (PWM)** on all four wave shapes — 303 + 888State.

## [1.28.0] — 2026-06-15
### Changed
- Extracted UI panels, input, and lifecycle out of `main.ts` (refactor); folded in
  bitcrush-continuity + new-instrument fx-default test guards (1.29.1).
- Demo "Burning Chlamydia Pissies".

## [1.27.0] — 2026-06-15
### Added
- Demo "Disgraced Child of a Robber Baron" (cumbia).

## [1.26.0] — 2026-06-15
### Added
- Demo "All That and a Bag of Dicks" (70s porno-funk).

## [1.25.0] — 2026-06-15
### Added
- **Note-delay** effect-column command (swing/humanize). Re-scoped to one step
  (1.25.1).

## [1.22.0] — 2026-06-15
### Added
- **GPU channel vocoder** (1.22.0), speech intelligibility defaults + unvoiced
  passthrough (1.23.0), and formant shift (1.24.0); docs (1.24.1).

## [1.21.0] — 2026-06-09
### Added
- URL-referenced samples + "Larynx Yard Sale" vocal-house demo; DX7 pluck lead +
  sampler tricks (1.21.1).

## [1.20.0] — 2026-06-09
### Added
- Sampler engine completed: persistence, UI, presets (DVS vocal, VCSL, Wilhelm
  Scream), CC0 sample fetching, OGG conversion.

## [1.18.0] — 2026-06-08 → 2026-06-09
### Added
- 3-band Linkwitz-Riley **EQ** and **sidechain dynamics** compression + visual EQ
  slider UI.
### Fixed
- Sidechain key-source ordering + EQ slider double-drag (1.18.2).

## [1.17.0] — 2026-06-08
### Changed
- Migrated song storage to **IndexedDB + gzip**.

## [1.16.0] — 2026-06-08
### Added
- localStorage **song library**: autosave, demo-fork, custom picker (built atop the
  SongStore layer).

## [1.15.0] — 2026-06-08
### Added
- Whole-document **undo/redo**.

## [1.14.0] — 2026-06-08
### Added
- **Compressor + limiter** and a reorderable FX chain; demo "Hervé's Fancy Dance"
  (1.14.1).

## [1.13.0] — 2026-06-08
### Added
- **Per-sample recursive FX chain** + resonant SVF filter.
### Fixed
- fx-scope LFO ignoring live edits of its target (1.13.1).

## [1.12.0] — 2026-06-08
### Added
- LFOs 3 & 4 and a **Pump** (sidechain ducking) shape.

## [1.11.0] — 2026-06-08
### Added
- **Async PBO readback** + a committed test suite.

## [1.10.0] — 2026-06-08
### Added
- **Overdrive** (Ibanez TS9 Tube Screamer) effect.
### Changed
- FX panel: collapse-when-off, cleaner labels, Output split; Output Level its own
  section + clean-slate FX for new instruments (1.10.1–1.10.2).
### Fixed
- Tempo-synced LFO phase discontinuity under BPM changes (1.10.4).

## [1.9.0] — 2026-06-08
### Changed
- **Bitcrusher rework** + per-effect on/off automation; song format reset to v1.
- Log Crush Hz knob; Crush Bits 4–33 with "Off" labels (1.9.1–1.9.2).

## [1.8.0] — 2026-06-07
### Added
- **LFO mod matrix** + Wavewright Env → Pos; demo "La Mesa de Onda" (1.7.1).

## [1.7.0] — 2026-06-07
### Added
- **Global LFOs** + the **Wavewright wavetable** synth (prototype/design notes in
  1.5.5).

## [1.5.0] — 2026-06-07
### Added
- **Per-instrument effect chains** + song tweaks; demos (Icepick Lobotomy Cotillion,
  Homecoming Drama Queen iterations).

## [1.4.0] — 2026-06-06
### Added
- **Guitar engine** — acoustic/electric modal plucked string.

## [1.3.0] — 2026-06-06
### Added
- **Pipi** — physically-informed modal piano.

## [1.2.0] — 2026-06-06
### Added
- **Tabla engine** (modal Indian hand drums); swapped into "Let That Raga Drop".

## [1.1.0] — 2026-06-06
### Added
- **Per-channel effect chains** + a data-driven effects registry (1.0.3 refactor).

## [1.0.0] — 2026-06-06
### Added
- **Song save/load** (versioned JSON) + a Song-editor overhaul.
- Title/Author/Note metadata on all demo songs (1.0.1).
### Fixed
- Variable-tempo row clock + BPM-automated chase demo (1.0.2).

## [0.10.0] — 2026-06-06
### Added
- **Locked Groove ("GRV")** — vinyl record-noise engine; E8E drum presets (0.10.1).

## [0.9.0] — 2026-06-06
### Added
- **888State ("E8E")** — 3-oscillator 8-bit additive synth; demo "World 3-1 Infinite
  Lives" (0.9.1).

## [0.8.0] — 2026-06-06
### Added
- **Pattern effect column** — slides, vibrato, arpeggio, volume slide; docs +
  "Shamanic Colonic" demo (0.8.1–0.8.2).

## [0.7.0] — 2026-06-06
### Added
- **Tanpura** instrument + per-engine names + "Let That Raga Drop".

## [0.6.0] — 2026-06-06
### Changed
- **Instrument registry** plug-in system.

## [0.5.0] — 2026-06-05
### Added
- Per-song global **volume** + Song-editor volume knob; default volume to unity, with
  per-song tuning (0.5.1–0.5.2).
### Fixed
- Reverb stereo decode (right channel was ~+4.6 dB hot).

## [0.1.0] — 2026-06-05
### Added
- **Per-channel stereo pan** (header slider + automation target).
- **Dedicated automation tracks** across engine/shaders/MIDI/demos.
- **MIDI input**; native DX7 4-stage envelope; configurable audio prebuffer with live
  latency readout; real pause/resume on the transport; playback volume as a decoupled
  monitor + L/R VU meter.
### Changed
- Full **TypeScript** conversion (strict; `noUnusedLocals/Parameters`).
- Render the recursive ladder in **strips** — O(BLOCK²) → O(BLOCK·SUB).
### Fixed
- Oscillator phase drift; post-export audio starvation; AudioWorklet shipped as plain
  JS so it loads in production.

## [0.0.0] — 2026-06-03 → 2026-06-04
- Initial prototype era: DX7 with per-operator envelopes, DS-1 distortion, and SysEx
  patch loading; 303 + 808 engines (onset-locked noise, reference-matched envelopes);
  pattern editor (per-note inst/vol, block copy/paste, scrolling); multiple instrument
  instances with per-instance colors; Vite + extracted GLSL; the first batch of demo
  songs; the in-app help dialog; data-driven FX-chain passes; WebM export.
