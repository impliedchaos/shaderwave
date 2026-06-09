// Fetch an audio file (any format the browser's decodeAudioData supports — wav,
// ogg, mp3) and return it as mono Float32 PCM at the engine sample rate. Shared by
// the preset loader (ui/controls.ts) and demo-song sample-URL hydration (main.ts),
// so both decode/resample/clamp identically.
const ENGINE_SR = 48000;
// Sampler atlas frame cap — MUST match the clamp in ui/controls.ts and the atlas
// dimensions in gl/synth-renderer.ts (SMP_ATLAS_W * SMP_ATLAS_H / SMP_ATLAS_W rows).
const MAX_FRAMES = 4096 * (4096 / 16);

export async function decodeSampleUrl(url: string): Promise<Float32Array> {
  const buf = await (await fetch(url)).arrayBuffer();
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: ENGINE_SR });
  try {
    const audio = await ctx.decodeAudioData(buf);
    let pcm = audio.getChannelData(0);
    if (audio.sampleRate !== ENGINE_SR) {
      // Safety net — decodeAudioData usually resamples to the context rate already.
      const ratio = audio.sampleRate / ENGINE_SR;
      const newLen = Math.floor(pcm.length / ratio);
      const out = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        const pos = i * ratio, idx = Math.floor(pos), frac = pos - idx;
        out[i] = idx + 1 < pcm.length ? pcm[idx] * (1 - frac) + pcm[idx + 1] * frac : pcm[idx];
      }
      pcm = out;
    }
    if (pcm.length > MAX_FRAMES) pcm = pcm.slice(0, MAX_FRAMES);
    return pcm.slice();   // own the bytes; the decoded buffer is transient
  } finally {
    ctx.close?.();
  }
}
