// Built-in instrument presets, keyed by engine type. Each engine's preset list
// is now owned by its descriptor (src/instruments/); this module just assembles
// them into the lookup the sidebar dropdown uses (Controls.loadPreset). Preset
// matching compares p0/p1 only. DX7 has no entries here — its patches come from
// the SysEx ROM banks parsed at runtime.
import { REGISTRY } from '../instruments/index.js';
import type { Preset } from '../types.js';

export type { Preset } from '../types.js';

export const PRESETS: Record<string, Preset[]> =
  Object.fromEntries(REGISTRY.map((d) => [d.type, d.presets ?? []]));
