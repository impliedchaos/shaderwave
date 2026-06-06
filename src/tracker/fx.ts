// Pattern effect-column command set (phase 1) — classic tracker note-articulation
// effects: per-cell `cmd` + 2-hex `val` (XY). These modulate a playing voice's
// pitch/volume per render block (see engine._modulateVoices); they are distinct
// from the per-pattern automation tracks (which sequence instrument/fx params).
//
// The numeric `code` doubles as the single-char display nibble, so it must stay in
// 0..15 and match the key used to type it. -1 = no effect in a cell.
export const FX_NONE = -1;

export interface FxCmdDef {
  code: number;   // stored in Pattern.fxCmd; also the display/keyboard char (hex)
  key: string;    // keyboard key that selects it (upper-case)
  label: string;  // human description (help/tooltips)
}

// x = high nibble of val, y = low nibble (for two-parameter effects).
export const FX_CMDS: FxCmdDef[] = [
  { code: 0x0, key: '0', label: 'Arpeggio (x,y = semitones)' },
  { code: 0x1, key: '1', label: 'Pitch slide up (xx = rate)' },
  { code: 0x2, key: '2', label: 'Pitch slide down (xx = rate)' },
  { code: 0x3, key: '3', label: 'Tone portamento → note (meend)' },
  { code: 0x4, key: '4', label: 'Vibrato (x = speed, y = depth)' },
  { code: 0xA, key: 'A', label: 'Volume slide (x = up, y = down)' },
];

// Display char for a stored command code (null when empty).
export function fxChar(code: number): string | null {
  return code < 0 ? null : code.toString(16).toUpperCase();
}

// Resolve a typed key to a command def (null if it isn't an effect key).
export function fxByKey(key: string): FxCmdDef | null {
  const up = key.toUpperCase();
  return FX_CMDS.find((c) => c.key === up) || null;
}
