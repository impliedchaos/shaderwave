// Entry point for the committed node logic suite. Bundle + run with `npm run test`
// (esbuild resolves the `.glsl?raw` imports our engine pulls in transitively).
// Import each test file (they register via `test(...)` at import) then run.
import './lfo.test.js';
import './mod-matrix.test.js';
import './automation.test.js';
import './effects.test.js';
import './song-io.test.js';
import './demo-songs.test.js';
import './history.test.js';
import './song-store.test.js';
import './note-delay.test.js';
import { run } from './_harness.js';

run();
