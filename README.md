# ShaderWave — WebGL2 Synthesizer & Tracker

A classic-style music tracker whose instruments are synthesized **entirely on the
GPU**. Every audio sample is computed in a fragment shader, read back to the CPU,
and streamed to the audio device through a lock-free ring buffer.

## Run

The project is built with [Vite](https://vite.dev). In a WebGL2 browser:

```bash
npm install
npm run dev        # dev server with HMR → http://localhost:5173
npm run build      # production bundle → dist/
npm run preview    # serve the production build locally
npm run deploy     # build and deploy to the remote server
```

Then click the **▶** (Play) button. The `dist/` output is plain static files — host it anywhere
(GitHub Pages, S3, nginx…). No special headers are needed: audio is delivered to the
AudioWorklet via `postMessage` (no `SharedArrayBuffer`), so no cross-origin-isolation
(`COOP`/`COEP`) headers are required. The build uses a relative `base`, so it works
served from a domain root or a subpath.

### Controls

| Key                         | Action                                                        |
| --------------------------- | ------------------------------------------------------------- |
| **Z–M** / **S,D,G,H,J**    | Piano keys — write a note to the cursor cell & preview        |
| **Arrows**                  | Move cursor; **←/→** step note → instrument → volume → effect sub-columns, then across automation-track columns |
| **0–9** / **A–F**          | Set the inst/volume field (2-digit); on an automation-track column, enter a hex byte (`00`–`FF`) |
| **0–5 / A**                 | On the **effect** sub-column, pick a command (see below) then type its 2-hex value |
| **Shift+↑/↓**              | Nudge the note's volume ±5%                                  |
| **PageUp/Dn**, **Home/End** | Page / jump the cursor; **mouse wheel** scrolls the grid      |
| **Click+drag**              | Select a block of cells (note channels and automation tracks) |
| **Ctrl/⌘+C/X/V**           | Copy / cut / paste the selected block (notes + automation)    |
| **Del**                     | Clear the cell (a note, or an automation-track value)         |
| **=**                       | Note-off                                                      |
| **Space**                   | Play / Stop                                                   |
| **[ / ]**                   | Octave down / up                                              |
| **Ctrl/⌘+A**               | Select the whole pattern                                      |
| **Click a channel header**  | Mute / unmute that channel (outside the pan slider)           |
| **Drag a header pan slider**| Pan that channel left / right (snaps to centre)               |
| **?**                       | Open the help / shortcuts dialog                              |

The transport bar's **LEN** field sets the current pattern's row count.

### Recording

The **● Record** button arms live recording and starts playback (song mode, unless
something is already playing); click it again or press Stop to disarm — its icon
glows red while armed. With it armed and playing:

- **Notes** from the keyboard or MIDI land at the **playhead** on the cursor's
  channel (move the cursor to pick which channel), instead of stepping the editor.
- **Parameter moves** — turning an instrument/FX knob, or a MIDI CC — record into
  that parameter's **automation track** at the playhead, creating the track if one
  doesn't exist. While you hold the knob the existing track is suppressed so it
  can't fight you, and the value is latched into every row you sweep over.

### Instruments & the instrument table

The sidebar lists an **instrument table** — instances you play from. Each note in a
pattern references one. Use **+ Add** to add another instance of any engine type
(e.g. a second 303 with a different cutoff, or three DX7s on different patches);
right-click an instance to remove it. Each instance has its own color so duplicates
are distinguishable in the grid. Pick an instance and tweak its parameters in the
sidebar; a song shows only the instruments it uses.

## Instruments

### 303 — Acid Bass (Roland TB-303)

Saw/square oscillator through a 4-pole nonlinear ladder filter with downward
envelope sweep and accent. Parameters: **Cutoff**, **Reso**, **EnvMod**,
**Accent**, **Wave** (saw/square/tri/sine/noise), **FiltDecay**, **AmpDecay**,
**PulseW** (pulse-width warp on all four shapes; automatable).

Modded to also allow triangle/sine/noise oscillators.

### 808 — Drum Machine (Roland TR-808)

Analytical drum synthesis — swept-sine kick/toms, sine+noise snare, metallic
hi-hats, clap, cowbell. Parameters: **Tone**, **Decay**, **Snappy**.

### Moog — Minimoog Model D

A faithful Model D voice: three oscillators with independent **waveform**
(triangle / saw / square / wide + narrow pulse) and **octave range** (32′–2′),
mixed into a 4-pole transistor **ladder filter** with mixer overdrive,
self-oscillation, and the Model D's uncompensated low-end loss as resonance
climbs. Analog character comes from per-voice oscillator **drift** (a static
detune plus a slow wander) and **exponential (RC-curve) contours** for the
filter and amp envelopes. Also: **glide** (portamento), a **noise** source, and
filter **keyboard tracking**.

Parameters: **Cutoff**, **Reso**, **EnvAmt**, **KbdTrack**, **Detune**,
**AmpSus**, **FiltDecay**, **AmpDecay**, per-oscillator **Wave** and **Oct**,
**Glide**, and **Noise**. Glide and drift are computed analytically so
oscillator phase stays continuous across render blocks with no extra state.

### DX7 — FM Synthesizer (Yamaha DX7)

6-operator FM synthesis with all 32 DX7 algorithms, operator-level envelope
control (per-operator **Decay**, **Sustain**, **Release**), individual
**Coarse**, **Fine**, **Detune**, **Level**, and **Mode** (ratio / fixed-Hz)
parameters, and operator feedback.

Patches are loaded from **DX7 `.syx` SysEx files** (packed 32-voice banks).
A ROM selector in the sidebar lets you browse 9 banks (ROM 1A–4B + Bass)
containing 288 factory and community patches total. Selecting a patch
automatically configures all 6 operators, algorithm, and feedback from the
SysEx data.

### Tanpura — Indian Drone

Additive / modal synthesis (closed-form, like the 808/DX7): each sample is a sum
of decaying partials. The character is the **jivari** — the buzzing overtone
bloom of a string grazing a curved bridge — modelled as a gaussian spectral
formant that sweeps upward over the decay and sustains bright, the way a real
tanpura's spectral centroid *rises* instead of dimming. Parameters: **Decay**,
**Jivari**, **Bright**, **Pluck**, **Partials**, **Inharm**, **Bloom**, **Attack**,
and **Infinite** (a toggle that disables the decay so the drone rings until
note-off). Play it as a plucked-string voice — the demo *Let That Raga Drop*
programs the classic Pa–sa–sa–Sa· cycle across channels.

### 888State — 8-bit Additive (short name **E8E**)

A 3-oscillator additive synth (closed-form, like the 808/DX7/Tanpura) crunched
through a deliberate **8-bit quantizer** — the staircase that gives it its lo-fi
chiptune bite (the name nods to 808 State). Each oscillator is independently
**Sine / Saw / Square / Triangle / Noise**, and the **Oscs** knob runs it as a
single, dual or triple oscillator. Parameters: **Attack/Decay/Sustain/Release**
(a standard ADSR), **Detune2** and **Detune3** (osc 2/3 offset in semitones —
fractional values beat against osc 1), **Bits** (1–16; the quantizer depth, 8 by
default = 256 steps), **Drive**, three **Wave** selectors (which display the
waveform name), per-oscillator **Levels**, and **PulseW** (pulse-width warp on all
shapes — sine/saw/tri, not just square).
The expressive controls (detune, bits, drive) live in the p0/p1 banks so they're
automatable; the short name is **E8E** to stay visually distinct from the 808.

### Locked Groove — Vinyl Noise (short name **GRV**)

A vinyl record-noise texture (closed-form, no recursion) for laying grit under a
mix. It layers **surface hiss**, aperiodic **crackle**, dust **pops**, motor
**rumble**, and — the part that makes it read as *vinyl* rather than generic
noise — a **rotation-locked defect layer**: a handful of clicks/pops that recur
once per platter revolution (**33⅓ RPM → every 1.8 s**, also 45/78). Each defect
sits at a hashed angular position, **drifts** slightly per revolution (a radial
scratch crossing many grooves as the needle spirals in) and breathes in and out
across revolutions, so the ticks never sound metronomic. The **Cycle** knob
blends the pop energy from fully-random to fully-rotation-locked. Other
parameters: **Hiss**, **Crackle**, **Pop**, **Wear** (a macro that ages the
record — more/louder defects), **Tone**, **Rumble**, **Drift**, **RPM**,
**Defects** (count), **Color** (click voicing) and **Fade**. Play it as a drone
— one long note lays down the bed; pitch is ignored, velocity sets the level.

### Tabla — Indian Hand Drums (short name **TBL**)

Modal synthesis (closed-form, like the Tanpura/808): each sample is a sum of
exponentially-decaying, **near-harmonic modes**. On a real tabla the central syahi
(tuning paste) loads the membrane so its low modes fall on ~harmonic ratios — which
is what gives the drum a definite musical **pitch** (set by the played note) instead
of a dull thud. A short **strike** transient is the finger/palm contact; **Damp**
shortens the ring for closed strokes (*te/ka*); and **Bend** is the bayan's signature
palm-heel pitch glide (*ge/ghe*) — play a low note with a positive Bend. The bend is a
linear chirp so its phase stays analytic (no per-block glitch) and every mode rides it
together. Parameters: **Decay**, **Damp**, **Strike**, **Bend**, **Modes**, **Inharm**,
**BendTime**, **Tone**. Pairs naturally with the Tanpura for the raga demos.

### Pipi — Piano (short name **PNO**)

A physically-*informed* piano: modal synthesis (closed-form) that captures the piano
physics that matter, rather than a true waveguide (which would need per-voice delay
lines carried across blocks). Each note is a sum of decaying string partials with:
**inharmonicity** (a stiff string's partials stretch sharp, `fn = n·f0·√(1+B·n²)` —
the "stretch" that makes a piano sound like a piano), a **hammer-strike comb**
spectrum (the hammer hits ~1/8 along the string, suppressing partials near multiples
of 8) that **brightens with velocity** (ff is brighter than pp), a **two-rate
frequency-dependent decay** (high partials die fast; the long "aftersound" tail is the
piano double-decay), a **detuned string pair** that beats for shimmer, and a **hammer
thunk** transient. Parameters: **Decay**, **Inharm**, **Hardness**, **Hammer**,
**Partials**, **Detune**, **Damping**, **Release** (a long Release ≈ holding the
sustain pedal). Presets: Grand, Mellow, Bright, Honky-Tonk, Upright, Bell Piano.

### Gigi — Acoustic / Electric Guitar (short name **GIG**)

A plucked-string synth (modal, closed-form) that **morphs between acoustic and electric**
via the **Body** control. The string is a sum of decaying near-harmonic partials combed by
**pluck position** (near the bridge = bright/twangy, over the middle = mellow). As Body goes
from electric→acoustic it crossfades a magnetic-**pickup comb** + long sustain (electric)
into a **soundboard body resonance** (a woody ~185 Hz formant) with faster high-partial
damping (acoustic). A **pick** transient gives the attack, and a built-in **Drive** adds
electric overdrive/crunch (on top of the per-instrument fx chain). Parameters: **Decay**,
**PluckPos**, **Tone**, **Body**, **Partials**, **Drive**, **Pick**, **Release** (palm-mute
↔ let-ring). Presets: Steel Acoustic, Nylon Classical, Clean Electric, Overdrive, Crunch
Rock, Muted Funk.

### Wavewright — Wavetable Synth (short name **WVT**)

Two oscillators sweep a continuous **Position** through one of **16 morph banks**
(Classic, Harmonic, PWM, Formant, Resonant, Metallic, Wavefolder, Digital, Organ,
Sync, Saturate, Comb, Skew, Noise, Power, Glass), mixed with a sine **sub** and an
optional **cross-FM** (osc 2 phase-modulates osc 1). It is **band-limited** (per-octave
mips → no aliasing) and **phase-accumulating** (click-free detune/pitch). The 16 banks
are baked once into a shared GPU texture (also drawn by the sidebar oscilloscopes).
Parameters: **Attack/Decay/Sustain/Release**, **Pos1/Pos2** (the morph axes — ideal
LFO/automation targets), **Detune2**, **FM**, **Bank1/Bank2**, **Sub**, **SubOct**,
**Level1/Level2**, **EnvPos1/EnvPos2** (ADSR → morph Position). Presets: Classic Sweep,
PWM Strings, Vowel Pad, Metallic FM, Sub Bass.

### Sampler — GPU PCM Playback (short name **SMP**)

A fully GPU-accelerated PCM sampler. Audio files loaded via the UI are decoded, resampled to the engine rate, and densely packed into a massive shared 2D atlas texture (`4096×4096`). The sampler shader reads this texture using fractional interpolated lookups driven by the note's pitch ratio.
It supports **One-Shot** and **Forward Loop** modes.
Parameters: **Tune(st)**, **Start**, **Gain**, **Attack**, **Decay**, **Sustain**, **Release**. Load a sample using the "Load Sample..." button in the instrument panel. Sample data is automatically persisted (base64 encoded) when saving songs to a file or IndexedDB.

## Effect column

Each pattern cell has a fourth sub-column — a classic tracker **effect command**
(`cmd` + a 2-hex value, e.g. `340`). These are per-note articulations, distinct
from the automation tracks (which sequence instrument/effect *parameters*). Type
the command key, then two hex digits.

| Cmd | Effect | Value |
| --- | ------ | ----- |
| `0` | Arpeggio | x, y = semitone offsets, cycled |
| `1` / `2` | Pitch slide up / down | `xx` = rate |
| `3` | **Tone portamento** (meend) — slides to the cell's note without re-attacking | `xx` = rate |
| `4` | **Vibrato** (gamak) | x = speed, y = depth |
| `5` | **Note delay** — pushes the note's attack later within its step (swing / humanize) | `xx` = fraction of one step (`00` none · `80` ½ · `FF` ≈ full) |
| `A` | Volume slide | x = up, y = down |

Most of these modulate a *playing* voice once per render block (~93 Hz). **Note delay**
(`5`) is different — it's a scheduler effect: the note's trigger frame is pushed later by
`xx/255` of **one step** (sample-accurate, possibly into a later block), and the voice keeps
playing its previous note until then. Use it for swing (nudge the off-beats) or humanized
"drunken" timing. Pitch effects
are smooth on the phase-accumulating melodic engines (**303**, **Moog**); the
closed-form engines (Tanpura/DX7/808/E8E) step on per-block pitch changes, so pitch
effects are best on the leads — volume slide works on any instrument.

## Presets

Each instrument ships with curated presets (defined in `src/ui/presets.ts`)
selectable from a dropdown in the sidebar. Presets set both the synth parameters
and recommended effects settings (distortion, delay, reverb, chorus, etc.).
Loading a demo song also syncs the full UI to the song's instrument/effect state.

## Effects Chain

A second shader stage runs between the synth mix and the audio readback. All
effects are editable from the **Instrument FX** panel.

```
input → Compressor → Filter → EQ → Vocoder → Overdrive → Distortion → Chorus → Tremolo → Delay → Reverb → Bitcrusher → Width → Limiter → Master Out
```

Each effect is its own GPU pass over a `BLOCK × 1` stereo buffer. The order above is
the default (`DEFAULT_FX_ORDER` in `src/gl/effects.ts`), but the chain is
**reorderable per instrument instance** — the ▲▼ controls on each FX category header
move that effect earlier/later, stored as `fxOrder` on the instance (so e.g. a pad
can compress-then-reverb while drums reverb-then-compress). A terminal master pass
applies the output gain and additively accumulates each instrument's result.

Most effects are pointwise or ring-buffer-based, but the **Filter** is **per-sample
recursive** (each output sample depends on the previous sample's filter state). It
borrows the synth ladder's trick: the block is rendered in `FX_SUB`-wide strips that
carry the filter state forward via an MRT state texture (and across blocks via a
persistent ping-pong), so the recursion is exact without an `O(BLOCK²)` recompute.

### Distortion — Boss DS-1 Emulation

Modelled after the Boss DS-1 diode hard-clipping circuit:
- **Drive** — drive amount (gain into the clipping stage)
- **Tone** — post-clip tilt EQ (dark ↔ bright)
- **Level** — output volume

### Overdrive — Ibanez TS9 Tube Screamer

A softer, warmer dirt box than the DS-1, placed right after it. Models the TS9's three
signatures: a **bass cut before the clipper** (keeps lows tight), **soft asymmetric**
clipping (even harmonics), and the **mid-hump** that emerges from the bass-cut + treble-roll.
- **Drive** — gain into the soft clipper
- **Tone** — post-clip treble roll
- **Level** — output volume

### Filter — Resonant State-Variable

A TPT (topology-preserving transform) state-variable filter — the chain's only
per-sample recursive effect. Self-oscillation-capable resonance; the cutoff is the
primary target the LFOs / mod matrix were built to sweep.
- **Cutoff** — corner frequency (Hz, log)
- **Reso** — resonance / Q (→ self-oscillation near the top)
- **Mode** — LP (low-pass) · HP (high-pass) · BP (band-pass)
- **Mix** — wet/dry blend

### Equalizer — 3-Band

Three bands (low shelf · peaking mid · high shelf) split by two per-sample crossover
filters (TPT, zero-delay-feedback). Perfectly transparent at 0 dB.
- **Low / Mid / High** — per-band gain (dB)
- **Low Cut / High Cut** — crossover frequencies (Hz, log)

### Vocoder — Channel Vocoder

Imposes the spectral envelope of a **modulator** (another instrument instance) onto the
**carrier** (the instance this effect sits on). Per-sample recursive, like the filter: the
bands run as texture **rows** (one bandpass + envelope follower per row), so it holds a whole
filter bank of state. The modulator is read from the same sidechain dry bus the compressor
keys off, so **Source** picks an instrument instance. Use a **bright** carrier (saw / pulse /
e8e / bright wvt) — a sine has no high harmonics for the upper formants to shape.
- **Source** — modulator instrument-instance index (−1 = off)
- **Bands** — analysis/synthesis band count (1–16; more = finer, gap-free formants)
- **Q** — per-band resonance / selectivity
- **Attack / Release** — envelope follower time constants (ms)
- **Mix** — dry/wet (1 = fully vocoded)
- **Unvoiced** — sibilance passthrough: passes the modulator's own gated high frequencies so
  consonants (s/t/f/sh — broadband noise a tonal carrier can't voice) stay crisp
- **Formant** — shifts the formant peaks ±12 st **without changing pitch** (pitch is the
  carrier's note); up = smaller/brighter, down = bigger/darker

### Compressor

A per-sample envelope follower (the same strip + MRT state-carry as the filter),
stereo-LINKED: one peak detector on `max(|L|,|R|)` drives one gain applied to both
channels (preserving the stereo image). Defaults first in the chain.
- **Thresh** — level above which compression starts (dB)
- **Ratio** — amount of reduction (`gain = (env/thresh)^-(1-1/ratio)`)
- **Attack / Release** — envelope time constants (ms)
- **Makeup** — output gain to recover the lost level (dB)

### Limiter — Transparent

Shares the compressor's envelope core with ∞ ratio (a brick wall to the ceiling) and
a fixed fast attack. Defaults dead last as the output ceiling.
- **Ceiling** — peak the output is pinned below (dB)
- **Release** — recovery time (ms)

### Chorus

Stereo chorus via modulated delay line:
- **Mix** — wet/dry blend
- **Rate** — LFO speed (Hz)
- **Depth** — modulation depth (ms)

### Tremolo

Auto-pan amplitude modulation:
- **Mix** — effect depth
- **Rate** — LFO speed (Hz)

### Delay

Stereo feedback delay stored in a persistent ping-pong ring texture (~2.7 s max):
- **Time** — delay length (s)
- **Feedback** — regeneration amount
- **Mix** — wet/dry blend

### Reverb

4-line FDN (Feedback Delay Network) with a Householder feedback matrix and
per-line damping lowpass:
- **Decay** — tail length
- **Damp** — high-frequency absorption
- **Send** — input send level
- **Mix** — wet/dry blend

### Bitcrusher

Digital bit-depth quantizer + sample-rate decimator (zero-order sample-and-hold, carried
across blocks) with a dry/wet mix:
- **Bits** — true bit depth, `2^N−1` mid-tread levels that keep silence (4–33; **33 = off**)
- **Hz** — decimation rate, logarithmic (100 Hz – sample rate; **max = off**)
- **Mix** — dry/wet blend

### Stereo Width

Mid/side stereo width control. Values > 1.0 widen; < 1.0 narrow toward mono.

## Modulation — Automation, LFOs & Mod Matrix

Beyond the per-cell effect column, parameters can be modulated three ways:
- **Automation tracks** — per-pattern lanes that sequence one parameter (inst / fx / channel /
  global scope) over the rows as normalized 2-hex bytes. Add via the **+ Auto Track** button.
- **Global LFOs** — four song-wide LFO **sources** (Sine / Triangle / Square / Saw / S&H / Ramp /
  Wavetable / **Pump** shapes, tempo-synced in beats or free-running in Hz). Configured in the Song
  Editor. LFOs 0–2 are general; **LFO 3 defaults to the Pump**.
- **Pump (sidechain ducking)** — the Pump shape is a one-sided downward ducking envelope: a full duck
  on the beat that swells back before the next. Route it to instruments' **Level** via the matrix to
  pump them in lockstep (leave the kick unrouted) — the classic sidechain pump without a compressor.
- **Mod matrix** — a list of **routings**, each aiming a target at an LFO source with its own depth
  and polarity. Because routings reference a source, **one LFO can drive many parameters** at once.

LFO phase derives from song time, so modulated playback renders **deterministically** for export.

## Volume

Two independent volumes:

- **Global volume** — the render-level output gain, baked into the rendered audio,
  so it **affects recordings/exports**. Set it per song with the **Volume** knob in
  the **Song Editor** tab (100% = the default), saved with the song, and reset to
  the default on **New Song**. It's also automatable as the **Volume** (global)
  target, and the per-engine FX **Level** trims each engine within the mix.
- **Playback volume** — the monitor slider in the header. Affects only what you
  hear; it never touches the render or a recording.

Automation lives in dedicated **tracks** — extra columns to the right of the note
channels, each sequencing one parameter independently of note triggers. Click
**+ Auto Track** in the Pattern Editor toolbar to pick a parameter; a new column
appears. Type two hex digits (`00`–`FF`) per row to set a value; an empty `··` row
holds the previous value. Right-click a track's header to remove it.

The byte maps across the parameter's real range (log-scaled for cutoffs, linear
elsewhere). The parameter-target registry lives in `src/tracker/automation.ts`, and
that normalised byte is also the currency for MIDI-CC recording (below).

Four scopes, distinguished by colour/tag in the grid:

- **Instrument** (cyan) — cutoff, resonance, FM mod index, … applied to an
  instrument *instance*. It holds across that instance's note retriggers, so a
  column of cutoff values is the classic acid filter sweep, and reverts to the
  instrument's base on stop.
- **Effect** (amber) — distortion, delay/reverb mix, … written to the engine
  type's shared FX chain, so the change is track-wide for that engine. Persists
  until re-set.
- **Channel** (cyan) — currently **PAN**, per-channel and engine-agnostic; the
  value reads as `L../C/R..`. The channel header's pan slider sets the base (saved
  with the song); an automation value overrides it during playback, reverting on stop.
- **Global** (red) — **BPM** and **Volume** (the global output level). Song-wide.

Values apply per row during playback, right after the row's note triggers, so a
value on a note's row overrides the note's snapshot; sidebar knobs follow live and
revert to the stored base on stop. The demo songs *Dextroamphetamine Suppository*,
*Where'd I Put My Keys?*, *Feral Roomba Sabbath* and *Tinnitus Cathedral* use 303
cutoff/resonance sweeps; *Frying pans. Who knew?* uses per-channel PAN.

### MIDI input

With a Web MIDI device connected, note on/off play (and, with **record** armed,
write to the pattern). CC knobs map to the selected instrument's parameters and
record straight into the matching automation track — created on the fly if one
doesn't exist yet.

## How It Works

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
3. **Effects pass** → one pass per effect over a `BLOCK × 1` stereo buffer, run in
   a data-driven order (distortion → chorus → tremolo → delay → reverb →
   bitcrusher → width → master).
4. **Readback** (`readPixels`) → interleaved stereo `Float32Array` → ring buffer.

The recursive ladder filter (303, Moog) can't be parallelised trivially: each
output sample recomputes its voice's filter from a checkpoint using carried-in
state. To keep that from being an O(N²) recompute per block, the ladder is
rendered in strips of `subBlock` samples (default 64), each picking up from the
previous strip's saved state — O(N·subBlock), and bit-identical to the old
single-pass render. See `synth-renderer.ts`.

## Layout

```
index.html                 app shell, tracker grid, sidebar controls (Vite entry)
vite.config.js             build config (relative base, worklet emitted as a file)
public/                    static assets copied verbatim (favicon, sysex banks)
src/constants.ts           shared sizes, note→freq, ring layout
src/main.ts                app init, song loading, UI sync
src/gl/                    context, program helpers, SynthRenderer, shaders/
  shaders/*.glsl             raw GLSL, imported as strings via Vite's ?raw
  shaders/synth-303.glsl       acid bass synth
  shaders/synth-808.glsl       drum machine
  shaders/synth-moog.glsl      Minimoog Model D voice
  shaders/synth-dx7.glsl       6-op FM (all 32 algorithms)
  shaders/synth-tanpura.glsl   additive/modal Indian drone (jivari)
  shaders/synth-e8e.glsl       888State — 3-osc additive, 8-bit crunch
  shaders/synth-groove.glsl    Locked Groove — vinyl noise (rotation-locked)
  shaders/synth-tabla.glsl     Tabla — modal Indian hand drums (dayan/bayan)
  shaders/synth-pipi.glsl      Pipi — physically-informed modal piano
  shaders/synth-guitar.glsl    Guitar — modal plucked string (acoustic/electric)
  shaders/fx-distortion.glsl   DS-1 distortion stage
  shaders/fx-chorus-*.glsl     chorus ring update + tap
  shaders/fx-tremolo.glsl      auto-pan tremolo stage
  shaders/fx-delay-*.glsl      stereo delay ring update + tap
  shaders/fx-fdn-*.glsl        FDN reverb ring update + tap
  shaders/fx-bitcrush.glsl     bit-depth / sample-rate crush stage
  shaders/fx-width.glsl        mid/side stereo width stage
  shaders/fx-master.glsl       master gain + additive accumulate
  shaders/mix.glsl             voice mixdown
  shaders/common.glsl          shared ADSR, noise, filter utilities (the prelude)
src/gl/effects.ts          per-effect pass pipeline (data-driven chain order)
src/audio/                 worklet.js (classic script — plain JS so Vite emits a real .js asset), pipeline.ts
src/instruments/           instrument registry — one descriptor per engine (shader, params, presets, automation, help); add a synth here + one .glsl
src/tracker/               pattern, song (+ demo songs), engine (BPM clock), automation (param-target registry), fx (effect-column commands)
src/ui/                    tracker-view (canvas grid), controls (sidebar + SysEx loader), presets (instrument preset bank)
public/sysex/DX7/          .syx patch banks (ROM 1A–4B, Bass)
test/                      headless GLSL / render / audio harnesses
```

## Tests (headless Chrome + SwiftShader)

The harnesses are plain ES-module pages — serve them with the dev server
(`npm run dev`) and load over `localhost:5173`:

```bash
# shaders compile & link
google-chrome --headless=new --enable-unsafe-swiftshader --dump-dom \
  http://localhost:5173/test/glsl-check.html
# full GPU render path produces finite signal:  test/render-check.html
# live audio ring/worklet drains with no underruns:  test/audio-check.html
# drum spectrum / autocorrelation vs reference:   test/drum-analyze.html
# vinyl-noise stats (click rate, tilt, rotation):  test/vinyl-analyze.html
# two instances of one engine render differently:  test/instance-check.html
# a drum sounds identical on every trigger:         test/onset-check.html
```

The Locked Groove engine was tuned by **matching the measured statistics of real
CC0 vinyl recordings** (click rate ≈18/s, dark low-tilted spectrum, ~1.8 s
rotation tick), the same objective approach used for the 808 drums.
`vinyl-analyze.html` prints those stats for the synth so it can be re-checked
against the reference targets baked into the harness header.

## New Instrument Ideas

*(Wishlist cleared — 888State, Locked Groove, Tabla, Pipi and the acoustic/electric
Gigi guitar all shipped. Add new ideas here.)*

## Song files (save / load)

The **💾 Save** / **📂 Load** toolbar buttons export and import the whole song as
a versioned JSON document (`*.shaderwave.json`): patterns (notes/inst/vol/effect
column + automation tracks), the instrument table (params + DX7 ops), per-engine
fx chains, order, bpm, pan and master. The file carries `format` + `version`
headers; `src/tracker/song-io.ts` validates them, refuses files from a newer
format, and routes older files through a `migrate()` step so the schema can keep
evolving without breaking saved songs. Automation stores the **frozen** target
ids, so a saved track still resolves after new engines are appended.

## Known Limitations / Next Steps

- Instrument editor for creating and editing instrument patches from scratch.
