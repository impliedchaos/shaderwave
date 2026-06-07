import { defineConfig } from 'vite';

// Relative base so the build works whether served from a domain root or a
// subpath (e.g. GitHub Pages project sites). Runtime fetches of sysex banks use
// relative URLs too, and those files live in public/ so they're copied verbatim.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',     // top-level await / import.meta.url in the worklet path
    outDir: 'dist',
    // Keep the AudioWorklet as a real emitted file rather than an inlined
    // data: URI — addModule() is happier with a fetchable URL.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: 'index.html',
        // Wavewright wavetable prototype — a self-contained page (no src/ imports),
        // shipped so it's viewable on the deployed site at /test/wavetable-proto.html.
        'wavetable-proto': 'test/wavetable-proto.html',
      },
    },
  },
});
