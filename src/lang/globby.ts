/**
 * Import globby dynamically. v16 is ESM-only, and a static import would
 * compile to a `require()`, which cannot load ESM.
 */
type Globby = typeof import("globby", {
  with: { "resolution-mode": "import" },
}).globby;

let cached: Promise<Globby> | null = null;

export function loadGlobby(): Promise<Globby> {
  if (!cached) cached = import("globby").then((m) => m.globby);
  return cached;
}
