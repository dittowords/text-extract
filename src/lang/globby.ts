/**
 * globby v16 is ESM-only and this package emits CommonJS, so a static import
 * compiles to an illegal `require()` of an ES module — it works only via
 * Node 22's `require(esm)`, and fails on Node 18/20. A dynamic import is the
 * real mechanism; `module: node18` preserves it instead of downleveling it.
 */
type Globby = typeof import("globby", {
  with: { "resolution-mode": "import" },
}).globby;

let cached: Promise<Globby> | null = null;

export function loadGlobby(): Promise<Globby> {
  if (!cached) cached = import("globby").then((m) => m.globby);
  return cached;
}
