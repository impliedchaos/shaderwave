// Typed DOM lookup helpers. The bare `document.getElementById` returns
// `HTMLElement | null`, which makes every `.value` / `.checked` access a type
// error and forces a null check at each call site. These wrappers fold the cast
// and the null handling into one place.
//
//   el<HTMLInputElement>('bpm').value      // required: throws if missing
//   byId<HTMLInputElement>('bpm')?.value   // optional: null-safe

/** Look up a required element by id, narrowed to T. Throws if it's not in the DOM. */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Expected element #${id} in the DOM`);
  return node as T;
}

/** Look up an element by id, narrowed to T, or null if absent. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** First descendant matching `selector`, narrowed to T, or null. */
export function qs<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector(selector) as T | null;
}

/** All descendants matching `selector`, narrowed to T, as a real array. */
export function qsa<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return Array.from(root.querySelectorAll(selector)) as T[];
}
