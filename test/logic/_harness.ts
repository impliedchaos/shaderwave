// Tiny zero-dependency test harness for the committed node logic suite.
//
// There is no unit-test framework in this repo (see AGENTS.md). These tests run
// under plain node after an esbuild bundle (`npm run test`), so they exercise the
// real engine/song/automation/LFO logic — the interacting state that the GPU
// HTML harnesses can't reach. Each test file calls `test(name, fn)` at import;
// `index.ts` imports them all then calls `run()`, which sets a non-zero exit code
// if anything fails (so CI / the shell `&&` chain reports it).
type TestFn = () => void | Promise<void>;

const tests: { name: string; fn: TestFn }[] = [];
export function test(name: string, fn: TestFn) { tests.push({ name, fn }); }

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

export function assertClose(actual: number, expected: number, eps: number, msg: string) {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg}: expected ${expected} ± ${eps}, got ${actual} (Δ${Math.abs(actual - expected)})`);
  }
}

// Max absolute step between adjacent samples of a series (used for continuity).
export function maxStep(xs: number[]): number {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs(xs[i] - xs[i - 1]));
  return m;
}

export async function run() {
  let pass = 0;
  const failures: string[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      pass++;
    } catch (e) {
      const msg = e instanceof Error ? (e.stack || e.message) : String(e);
      console.log(`  ✗ ${t.name}\n      ${msg.split('\n').join('\n      ')}`);
      failures.push(t.name);
    }
  }
  console.log(`\n${pass}/${tests.length} passed` + (failures.length ? `, ${failures.length} FAILED` : ''));
  if (failures.length) {
    if (typeof process !== 'undefined') process.exitCode = 1;
  }
}
