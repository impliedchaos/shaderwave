import type { InstrumentDef, Preset } from '../types.js';
import shader from '../gl/shaders/synth-sampler.glsl?raw';

// Curated DVS CC0 vocal shouts — [display label, file slug in public/samples].
// The full 200-clip pack is converted to OGG and shipped in public/samples/; these
// are the handful surfaced as one-tap presets (the rest stay loadable by file). All
// were peak-normalized on conversion, so a flat gain of 1.0 plays them consistently.
const DVS_VOCALS: [string, string][] = [
  ['Yeah', 'dvs-yeah-1'], ['Yo', 'dvs-yo-1'], ['Check It Out', 'dvs-check-it-out-1'],
  ['Drop The Beat', 'dvs-drop-the-beat-1'], ['Here We Go', 'dvs-here-we-go-1'],
  ['Come On', 'dvs-come-on-1'], ['Everybody', 'dvs-everybody-1'], ['Fire', 'dvs-fire-1'],
  ['Freak', 'dvs-freak-1'], ['Fresh', 'dvs-fresh-1'], ['Go', 'dvs-go-1'], ['Hey', 'dvs-hey-1'],
  ['Ho', 'dvs-ho-1'], ['Hot', 'dvs-hot-1'], ['Lets Go', 'dvs-lets-go-1'], ['Louder', 'dvs-louder-1'],
  ['Move', 'dvs-move-1'], ['Oh', 'dvs-oh-1'], ['Okay', 'dvs-okay-1'], ['Oww', 'dvs-oww-1'],
  ['Rock On', 'dvs-rock-on-1'], ['Stop', 'dvs-stop-1'], ['Turn It Up', 'dvs-turn-it-up-1'],
  ['Uh', 'dvs-uh-1'], ['What', 'dvs-what-1'],
];
// One-shot vocal: instant attack, sustain=1 so the whole clip plays (shader ends it
// at the sample's end), short release tail. rootNote 60 = unity pitch at C4.
const dvsPreset = ([label, slug]: [string, string]): Preset => ({
  name: `DVS: ${label}`,
  p0: [0, 0, 1.0, 0],
  p1: [0.001, 0.1, 1.0, 0.08],
  sample: { name: `DVS ${label}`, rootNote: 60, loopStart: 0, loopEnd: 0, loopMode: 0, url: `/samples/${slug}.ogg` },
});

export const isampler: InstrumentDef = {
  type: 'sampler',
  name: 'Sampler',
  short: 'SMP',
  label: 'Sampler — PCM Playback',
  blurb: 'Plays a loaded audio file, pitched by note. Start, loop, amp envelope.',
  shader,
  defaults: { p0: [0, 0, 1, 0], p1: [0.001, 0.2, 1, 0.05] },   // tune, start, gain ; A D S R
  paramDefs: [
    { label: 'Tune',   type: 'global', bank: 'p0', i: 0, min: -24, max: 24, step: 1 },
    { label: 'Start',  type: 'global', bank: 'p0', i: 1, min: 0, max: 1, step: 0.001 },
    { label: 'Gain',   type: 'global', bank: 'p0', i: 2, min: 0, max: 2, step: 0.01 },
    { label: 'Attack', type: 'global', bank: 'p1', i: 0, min: 0.001, max: 1, step: 0.001 },
    { label: 'Decay',  type: 'global', bank: 'p1', i: 1, min: 0.001, max: 2, step: 0.001 },
    { label: 'Sustain',type: 'global', bank: 'p1', i: 2, min: 0, max: 1, step: 0.01 },
    { label: 'Release',type: 'global', bank: 'p1', i: 3, min: 0.001, max: 2, step: 0.001 },
  ],
  autoTargets: [
    { code: 'TUN', label: 'Tune',   bank: 'p0', index: 0, min: -24, max: 24, curve: 'lin' },
    { code: 'STR', label: 'Start',  bank: 'p0', index: 1, min: 0, max: 1, curve: 'lin' },
    { code: 'GAN', label: 'Gain',   bank: 'p0', index: 2, min: 0, max: 2, curve: 'lin' },
    { code: 'ATK', label: 'Attack', bank: 'p1', index: 0, min: 0.001, max: 1, curve: 'lin', unit: 's' },
    { code: 'DEC', label: 'Decay',  bank: 'p1', index: 1, min: 0.001, max: 2, curve: 'lin', unit: 's' },
    { code: 'SUS', label: 'Sustain',bank: 'p1', index: 2, min: 0, max: 1, curve: 'lin' },
    { code: 'REL', label: 'Release',bank: 'p1', index: 3, min: 0.001, max: 2, curve: 'lin', unit: 's' },
  ],
  presets: [
    {
      name: 'VCSL Crash Cymbal',
      p0: [0, 0, 1, 0],
      p1: [0.001, 3, 0, 0.4],
      sample: {
        name: 'crash.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/crash.ogg'
      }
    },
    {
      name: 'VCSL Cowbell',
      p0: [0, 0, 1.2, 0],
      p1: [0.001, 1, 0, 0.1],
      sample: {
        name: 'cowbell.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/cowbell.ogg'
      }
    },
    {
      name: 'VCSL Tambourine',
      p0: [0, 0, 1.5, 0],
      p1: [0.001, 1, 0, 0.05],
      sample: {
        name: 'tamb.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/tamb.ogg'
      }
    },
    {
      // sustain=1 + the shader's one-shot end (pos>=len → silence) lets the whole
      // clip play at full volume; release is just the note-off tail.
      name: 'Wilhelm Scream',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 0.1, 1.0, 0.2],
      sample: {
        name: 'wilhelm.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/wilhelm.ogg'
      }
    },
    {
      name: 'VCSL Anvil',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 0.1, 1.0, 0.2],
      sample: {
        name: 'anvil.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/anvil.ogg'
      }
    },
    {
      name: 'VCSL Slapstick (Whip)',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 0.1, 1.0, 0.05],
      sample: {
        name: 'slapstick.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/slapstick.ogg'
      }
    },
    {
      name: 'VCSL Flexatone',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 0.1, 1.0, 0.1],
      sample: {
        name: 'flexatone.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/flexatone.ogg'
      }
    },
    {
      name: 'VCSL Ratchet',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 0.1, 1.0, 0.1],
      sample: {
        name: 'ratchet.ogg',
        rootNote: 60,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/ratchet.ogg'
      }
    },
    {
      // Melodic — recorded at A4 (MIDI 69), so it tracks the keyboard pitch.
      name: 'VCSL Kalimba',
      p0: [0, 0, 1.0, 0],
      p1: [0.001, 0.1, 1.0, 0.3],
      sample: {
        name: 'kalimba.ogg',
        rootNote: 69,
        loopStart: 0,
        loopEnd: 0,
        loopMode: 0,
        url: '/samples/kalimba.ogg'
      }
    },
    ...DVS_VOCALS.map(dvsPreset),
  ],
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
