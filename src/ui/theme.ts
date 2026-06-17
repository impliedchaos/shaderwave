// Cached reads of CSS custom properties (theme vars). getComputedStyle +
// getPropertyValue were being called dozens of times per animation frame from
// the tracker grid and visualizer; the values only change when the accent is
// re-themed on instrument select, so cache them and invalidate explicitly.
let cache = new Map<string, string>();

// Call whenever a CSS custom property on :root changes (e.g. --accent on select).
export function invalidateTheme() {
  cache.clear();
}

// Read a CSS custom property off :root, memoised until invalidateTheme().
export function themeVar(name: string, fallback = ''): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    cache.set(name, v);
  }
  return v;
}

// ── Light / dark palette switching ──────────────────────────────────────────
// The palette is just CSS vars (see :root and :root[data-theme="light"] in
// index.html); switching is a data-attribute on <html>. The inline <head> script
// applies the saved value before first paint to avoid a flash. The canvas reads
// the vars through themeVar, so invalidate the cache (caller redraws) after a switch.
const THEME_KEY = 'shaderwave-theme';

export function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(name: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem(THEME_KEY, name); } catch { /* private mode — fine */ }
  invalidateTheme();
}

// Flip to the other theme and return the new one.
export function toggleTheme(): 'light' | 'dark' {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function toHex(r: number, g: number, b: number): string {
  const cl = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return '#' + [cl(r), cl(g), cl(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// A neon accent that pops on the dark theme (cyan/green/yellow) has very high luminance
// and is unreadable as text/accent on the light background. In LIGHT mode, darken an
// over-bright colour toward a readable shade, preserving its hue; DARK mode returns it
// unchanged. Used for the UI --accent and for canvas note/instrument labels.
export function displayAccent(hex: string): string {
  if (currentTheme() !== 'light') return hex;
  const c = parseHex(hex);
  if (!c) return hex;
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;   // 0..255
  if (lum <= 150) return hex;                                // already readable on white
  const k = 108 / lum;                                       // pull luminance to ~108, keep hue
  return toHex(c.r * k, c.g * k, c.b * k);
}
