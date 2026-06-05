// @ts-nocheck
// Cached reads of CSS custom properties (theme vars). getComputedStyle +
// getPropertyValue were being called dozens of times per animation frame from
// the tracker grid and visualizer; the values only change when the accent is
// re-themed on instrument select, so cache them and invalidate explicitly.
let cache = new Map();

// Call whenever a CSS custom property on :root changes (e.g. --accent on select).
export function invalidateTheme() {
  cache.clear();
}

// Read a CSS custom property off :root, memoised until invalidateTheme().
export function themeVar(name, fallback = '') {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    cache.set(name, v);
  }
  return v;
}
