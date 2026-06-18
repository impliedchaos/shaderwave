# Lorenz Attractor Farm — Synthesizer Design Document

## Overview

The Lorenz Attractor Farm is a GPU-native synthesizer instrument for the WebGL tracker.
Rather than computing audio waveforms directly (as oscillators, samplers, or physical models
do), this instrument generates audio as *emergent behavior* from a massively parallel
dynamical system. The sound is the trace of chaos, not a programmed waveform.

The core idea: run N copies of the Lorenz chaotic attractor simultaneously on the GPU, each
in its own thread, with slightly varied parameters or initial conditions. The mean x-coordinate
of the ensemble over time becomes the audio output. Controlling the *statistical properties*
of the ensemble — rather than individual waveforms — is how you play the instrument.

This technique produces timbres that are genuinely impossible with any oscillator-based
synthesis: organic, slightly alive, with natural ensemble chorusing that emerges from
physics rather than being patched in.

---

## The Lorenz System

The Lorenz attractor is a system of three coupled ordinary differential equations:

```
dx/dt = σ(y - x)
dy/dt = x(ρ - z) - y
dz/dt = xy - βz
```

Classic parameters: σ=10, ρ=28, β=8/3

The system has a **chaos threshold** near ρ ≈ 24.06 (the Hopf bifurcation point):

| ρ range      | Behavior                                           |
|--------------|----------------------------------------------------|
| ρ < 1        | All trajectories converge to origin (silence)      |
| 1 < ρ < 13.9 | Converges to one of two fixed points C+/C−         |
| 13.9 < ρ < 24.06 | Fixed points become unstable, limit cycles appear |
| ρ ≈ 24–26    | Edge of chaos — metastable, slow irregular swings |
| ρ = 28       | Classic chaotic Lorenz butterfly                   |
| ρ > 35       | Increasingly violent, high-frequency chaos         |

The **fixed points** C+ and C− are located at:

```
C± = (±√(β(ρ-1)),  ±√(β(ρ-1)),  ρ-1)
```

At ρ=22, β=8/3: C± ≈ (±7.48, ±7.48, 21)

---

## Why GPU

Each attractor instance is completely independent — no attractor depends on any other's
result. The parallel structure is perfect for GPU compute:

- One thread per attractor instance
- Each thread: read own state, step equations, write new state
- Final audio sample: reduce (sum) all x-values, divide by N
- Zero inter-thread dependencies except the final atomic reduction

On CPU: 128 simultaneous Lorenz systems with RK4 integration at audio rate is expensive.
On GPU: 100,000+ is a routine dispatch.

---

## GPU Implementation

### Data Structures

```glsl
// Per-attractor state — one element per thread
struct AttractorState {
    vec3 pos;       // current (x, y, z)
    float localRho; // per-attractor ρ variation
};

// Per-voice uniform data (updated each audio sample)
struct VoiceParams {
    float dt;       // simulation step size — encodes pitch
    float curRho;   // current ρ envelope value
    float sigma;    // σ parameter
    float beta;     // β parameter
};
```

### Compute Shader

```glsl
layout(local_size_x = 256) in;

layout(std430, binding = 0) buffer States {
    vec4 state[];   // xyz + localRho, interleaved by voice
    // Voice 0: state[0..N-1]
    // Voice 1: state[N..2N-1]
    // Voice V: state[V*N..(V+1)*N-1]
};

layout(std430, binding = 1) buffer AudioOut {
    float mix_out;      // accumulated x sum (atomic)
    uint  sample_count; // total contributions (atomic)
};

uniform int   voice_count;
uniform int   attractors_per_voice; // N
uniform float dt[MAX_VOICES];
uniform float cur_rho[MAX_VOICES];
uniform float sigma;
uniform float beta;

vec3 lorenz(vec3 s, float r) {
    return vec3(
        sigma * (s.y - s.x),
        s.x * (r - s.z) - s.y,
        s.x * s.y - beta * s.z
    );
}

vec3 rk4(vec3 s, float r, float h) {
    vec3 k1 = lorenz(s,             r);
    vec3 k2 = lorenz(s + h*.5*k1,  r);
    vec3 k3 = lorenz(s + h*.5*k2,  r);
    vec3 k4 = lorenz(s + h*k3,     r);
    return s + (h/6.0) * (k1 + 2.0*k2 + 2.0*k3 + k4);
}

void main() {
    uint gid   = gl_GlobalInvocationID.x;
    uint voice = gid / attractors_per_voice;
    if (voice >= voice_count) return;

    float r    = cur_rho[voice];
    float h    = dt[voice];
    vec3  s    = state[gid].xyz;
    float lRho = state[gid].w;

    // Use per-attractor ρ variation if present
    s = rk4(s, lRho > 0.0 ? lRho : r, h);
    state[gid].xyz = s;

    // Chaos gate: smoothly silence the voice below the bifurcation point
    float chaos = clamp((r - 22.5) / 3.0, 0.0, 1.0);

    atomicAdd(mix_out, s.x * chaos);
    atomicAdd(sample_count, 1u);
}
```

### Audio Thread Integration

```javascript
// Called once per audio sample (e.g. from AudioWorklet)
function getNextSample() {
    // 1. Update cur_rho[] uniforms based on ρ envelope state
    gl.uniform1fv(uCurRho, voiceRhoValues);

    // 2. Dispatch compute
    gl.dispatchCompute(Math.ceil(totalAttractors / 256), 1, 1);
    gl.memoryBarrier(gl.SHADER_STORAGE_BARRIER_BIT);

    // 3. Read back mix_out and sample_count
    const [mixOut, sampleCount] = readAudioOutputBuffer();

    // 4. Clear for next sample
    clearAudioOutputBuffer();

    return sampleCount > 0 ? mixOut / sampleCount : 0.0;
}
```

---

## Pitch → `dt` (Simulation Step Size)

**This is the key insight**: pitch is not controlled by oscillator frequency. It is controlled
by how fast time flows through the simulation. A larger `dt` = faster simulation advance =
higher apparent audio frequency.

### Calibration

The Lorenz system at ρ=28, σ=10, β=8/3 has a natural oscillation period of approximately
T_natural ≈ 0.9 simulation time units.

To produce a musical note at frequency `f` Hz with audio sample rate `SR`:

```
dt = (f × T_natural) / SR
```

Example values at SR = 44100 Hz:

| Note | Frequency | dt        |
|------|-----------|-----------|
| C3   | 130.8 Hz  | 0.002671  |
| E3   | 164.8 Hz  | 0.003363  |
| G3   | 196.0 Hz  | 0.003999  |
| C4   | 261.6 Hz  | 0.005340  |
| A4   | 440.0 Hz  | 0.008980  |
| C5   | 523.3 Hz  | 0.010681  |

### MIDI Note to `dt`

```javascript
const T_NATURAL = 0.9;   // measured empirically or tuned
const SAMPLE_RATE = 44100;

function midiNoteToDt(midiNote) {
    const freq = 440.0 * Math.pow(2, (midiNote - 69) / 12);
    return (freq * T_NATURAL) / SAMPLE_RATE;
}
```

### Caveat: ρ-Dependent Pitch Drift

The natural period T_natural varies with ρ. When ρ changes (e.g., during the attack
envelope), the pitch shifts slightly. To compensate, recompute `dt` at each ρ value
using a precomputed lookup table:

```javascript
// Built at init time: run the system, count zero-crossings
const T_BY_RHO = buildNaturalPeriodTable(rhoMin=24, rhoMax=40, steps=64);

function dtForNote(midiNote, currentRho) {
    const freq = midiNoteToFreq(midiNote);
    const T    = T_BY_RHO[quantizeRho(currentRho)];
    return (freq * T) / SAMPLE_RATE;
}
```

This pitch correction is optional but recommended for melodic material.

---

## Note Lifecycle: ρ as Envelope

This is the most novel aspect of the instrument. There is no traditional ADSR amplitude
envelope. Instead, the ρ parameter is ramped between two zones:

- **Below chaos threshold** (ρ_floor ≈ 22): system converges to fixed points → near-silence
- **Above chaos threshold** (ρ > 24): butterfly attractor → oscillating audio output

### State Machine

```
IDLE    → NOTE_ON  → ATTACK  → SUSTAIN  → NOTE_OFF → RELEASE → IDLE
ρ=22       trigger    ramp up    hold        trigger    ramp down   ρ=22
```

### ρ Envelope Update (per audio sample)

```javascript
const RHO_FLOOR = 22.0;

// Exponential approach (natural-sounding)
function updateRhoEnvelope(voice, deltaTime) {
    const target = voice.noteHeld ? voice.rhoTarget : RHO_FLOOR;

    if (voice.curRho < target) {
        // Attack
        const tau = voice.attackTime;
        const alpha = 1.0 - Math.exp(-deltaTime / tau);
        voice.curRho += alpha * (target - voice.curRho);
    } else {
        // Release
        const tau = voice.releaseTime;
        const alpha = 1.0 - Math.exp(-deltaTime / tau);
        voice.curRho += alpha * (target - voice.curRho);
    }
}
```

### Why This Sounds Good

Attack: as ρ rises through the bifurcation point (~24), the fixed points C+/C− become
unstable. Trajectories spiral away from them and are captured by the strange attractor.
This "ignition" has a natural transient that sounds like a physical attack — energy
building, then blooming into full sound.

Release: as ρ falls back below 24, the strange attractor disappears. Trajectories converge
back to fixed points. Sound naturally extinguishes with an organic decay.

No amplitude envelope generator is needed. The physics provides the envelope.

### Initialization for Maximum Attack Clarity

Initialize attractors at a 50/50 split between C+ and C−, then warm up at ρ_floor:

```javascript
function initVoiceAttractors(voice, N) {
    voice.states = [];
    for (let i = 0; i < N; i++) {
        const sign = i < N / 2 ? 1 : -1;
        voice.states.push({
            x: sign * 7.4 + (Math.random() - 0.5) * 0.3,
            y: sign * 7.4 + (Math.random() - 0.5) * 0.3,
            z: 21.0  + (Math.random() - 0.5) * 0.3,
        });
    }
    // Warm up at RHO_FLOOR so attractors settle at C+/C−
    for (let step = 0; step < 800; step++) {
        for (let i = 0; i < voice.states.length; i++) {
            voice.states[i] = rk4(voice.states[i], voice.dt, sigma, RHO_FLOOR);
        }
    }
}
```

With 50% at C+ (x≈+7.4) and 50% at C− (x≈-7.4), the ensemble mean x ≈ 0 → silence.
When ρ crosses 24, trajectories leave the fixed points and the mean starts oscillating.

---

## Tracker Integration

### Note Row Format

```
NOTE  INST  VEL   [EFFECTS...]
C-4   01    64    Rho:28.5  Sig:10.0  Bet:2.67  ICS:1.0  RHS:0.5
```

| Column   | Maps to            | Notes                                       |
|----------|--------------------|---------------------------------------------|
| NOTE     | `dt` (pitch)       | Standard MIDI note → dt via formula above   |
| INST     | Voice preset       | Loads σ, β, N, base ρ, spread config        |
| VEL      | Amplitude scale    | Or IC spread (see options below)            |
| Rho:     | `rhoTarget`        | Target ρ when note is held                  |
| Sig:     | `sigma`            | Lorenz σ — like filter character            |
| Bet:     | `beta`             | Lorenz β — reshapes attractor geometry      |
| ICS:     | IC spread          | Initial condition variance — coherence dial |
| RHS:     | ρ spread           | Per-attractor ρ variance — detuning         |

### Effect Commands (tracker-style Exx notation)

| Command | Parameter      | Range  | Effect                                          |
|---------|----------------|--------|-------------------------------------------------|
| `Rxx`   | ρ target       | 00–FF  | Set target ρ (mapped to 24.5–50)                |
| `Sxx`   | σ              | 00–FF  | Set σ (mapped to 1–20)                          |
| `Bxx`   | β              | 00–FF  | Set β (mapped to 0.5–5.0)                       |
| `Ixx`   | IC spread      | 00–FF  | Set initial condition spread (0–30)             |
| `Pxx`   | ρ spread       | 00–FF  | Set per-attractor ρ variance (0–15)             |
| `Nxx`   | N attractors   | 00–FF  | Set attractor count per voice (8–512)           |
| `Axx`   | Attack time    | 00–FF  | Set ρ attack time in ms (10–2000)               |
| `Lxx`   | Release time   | 00–FF  | Set ρ release time in ms (50–5000)              |
| `Dxx`   | Readout dim    | 00–02  | Audio output from x=00, y=01, z=02             |
| `Mxx`   | XYZ mix        | 00–FF  | Blend between x and z readout (timbre morph)    |

### Polyphony Model

Each active voice is an independent attractor farm:

```
Voice 0 (C4): N attractors, dt=0.00534, curRho=28.0
Voice 1 (E4): N attractors, dt=0.00672, curRho=26.5
Voice 2 (G4): N attractors, dt=0.00799, curRho=28.0
...
```

All farms are dispatched in a single compute shader call. The output buffer sums
contributions from all voices. Voices are allocated from a pool; note-off triggers
a release phase rather than immediately freeing the slot.

```javascript
class VoicePool {
    constructor(maxVoices, attractorsPerVoice) {
        this.voices = Array.from({ length: maxVoices }, (_, i) => ({
            id: i,
            state: 'idle',   // idle | attack | sustain | release
            midiNote: null,
            curRho: RHO_FLOOR,
            tgtRho: RHO_FLOOR,
            dt: 0,
            // ... other params
        }));
        this.stateBuffer = createGPUBuffer(maxVoices * attractorsPerVoice);
    }

    noteOn(midiNote, velocity, params) {
        const voice = this.findFreeVoice();
        if (!voice) return; // voice steal logic here
        voice.state    = 'attack';
        voice.midiNote = midiNote;
        voice.dt       = midiNoteToDt(midiNote);
        voice.tgtRho   = params.rhoTarget ?? 28.0;
        voice.noteHeld = true;
        initVoiceAttractors(voice, this.attractorsPerVoice);
    }

    noteOff(midiNote) {
        const voice = this.voices.find(v => v.midiNote === midiNote && v.noteHeld);
        if (!voice) return;
        voice.noteHeld = false;
        voice.tgtRho   = RHO_FLOOR;
        voice.state    = 'release';
    }

    findFreeVoice() {
        // Prefer idle, then steal oldest release
        return this.voices.find(v => v.state === 'idle')
            ?? this.voices.filter(v => v.state === 'release')
                          .sort((a, b) => a.releaseStartTime - b.releaseStartTime)[0];
    }
}
```

---

## Musical Parameter Reference

### σ (sigma) — "Response"

Controls how fast the system responds to differences between x and y. Higher σ → system
evolves faster → brighter, more agitated timbre. Lower σ → slower, more sluggish response.
Analogous to filter resonance / envelope speed. Range: 2–20, default 10.

### ρ (rho) — "Chaos Depth"

The primary timbre control. Below 24: silence. 24–26: edge-of-chaos flutter. 28: full chaos.
35+: turbulent noise. This is the instrument's main expressive dimension — both as a static
tone color setting and as the envelope carrier.

### β (beta) — "Shape"

Controls the geometry of the two attractor lobes. Changes the harmonic balance of the output.
Lower β → lobes compress, more harmonic content. Higher β → lobes spread, smoother tone.
Range: 0.5–5.0, default 2.667 (8/3).

### IC Spread — "Coherence"

Variance in initial conditions across the N attractors. Zero spread → all attractors phase-
locked → nearly pure tone (plus chaotic noise). High spread → attractors in random phases →
dense, noisy texture. This is the instrument's tone-to-noise axis. Range: 0–30.

### ρ Spread — "Detuning"

Per-attractor variation in ρ. Creates natural detuning between attractor instances, similar
to the unison detune control on a supersaw. Each attractor is slightly more or less chaotic
than its neighbors. Range: 0–15.

### N Attractors — "Richness"

Number of parallel attractor instances per voice. More attractors → denser ensemble sound,
better averaging, smoother output. Fewer → more individual attractor character audible,
grainier texture. GPU-limited upper bound (practically thousands). Default: 128–256.

### Readout Dimension — "Timbre Mode"

Which coordinate of the attractor to use as audio output:

- **x**: oscillates between positive and negative lobes — most pitched, symmetric
- **y**: similar to x but phase-shifted, slightly different harmonic content
- **z**: always positive (range 0–50), more impulsive/spiky character, needs highpass filter
           to remove DC offset. Good for percussive material.
- **XYZ mix**: blend between dimensions continuously for spectral morphing

---

## Interesting Behaviors to Expose

### Edge-of-Chaos Hovering

Set ρ to hover just above the bifurcation point (~24.1–24.5). The system oscillates slowly
and irregularly, occasionally seeming to "decide" which lobe to orbit — then changes its mind.
This produces a natural slow tremolo that is completely non-periodic. Ideal for pads.

### Chaos Freeze

Stop advancing the attractor states (dt=0) mid-note. The ensemble is frozen at a single
point on the attractor surface. Release and it resumes. This is the dynamical-systems
equivalent of a granular freeze effect.

### ρ Automation as LFO Replacement

Automate ρ between 24 and 40 at audio or sub-audio rate. Near the threshold, the modulation
produces amplitude-like effects (chaos on/off). Deep in chaos, the modulation produces
timbre changes (brightness/density). One parameter serves as both amplitude LFO and filter LFO
simultaneously, with naturally coupled behavior.

### Coupled Voices (Advanced)

Add a weak coupling term between voice ensembles: each voice's mean x slightly perturbs the
adjacent voice's ρ. Voices become sympathetically linked — like strings on a soundboard.
This is the dynamical-systems analog of sympathetic string resonance.

```glsl
// In the compute shader, after reading cur_rho[voice]:
float coupling = voice > 0 ? coupling_strength * prev_voice_mean_x : 0.0;
float r = cur_rho[voice] + coupling;
```

---

## Integration Notes for Claude Code

- This instrument fits in the same voice/instrument architecture as the existing additive
  synth. The GPU buffer layout follows the same pattern: a large state buffer partitioned
  by voice, dispatched in a single compute pass.

- The ρ envelope update should happen on the **audio thread** (AudioWorklet), not the render
  thread, to avoid sample-accurate timing issues with note events.

- `dt` should be recomputed whenever ρ changes significantly if pitch accuracy matters.
  For textural/pad use cases, skip the compensation — the pitch drift sounds organic.

- Consider exposing IC spread and ρ spread as **modulatable** parameters in the tracker
  (not just set-and-forget) — sweeping IC spread from 0→high mid-note is one of the most
  distinctive sounds this instrument produces.

- The `z` readout dimension needs a DC-blocking highpass filter before mixing (cutoff ~20Hz)
  since z is always positive and its mean is ~ρ-1 (a large DC offset at audio rate).

- RK4 integration at audio rate (44100 Hz) with dt ≈ 0.003–0.01 is numerically stable for
  the Lorenz system. Euler integration is not recommended — it diverges at these step sizes.
