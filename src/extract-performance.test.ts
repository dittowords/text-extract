/**
 * The regex fallback handles every language without a grammar, and a regex over
 * quote/backslash-dense source is the classic catastrophic-backtracking setup —
 * where the failure is a pinned CPU, not a wrong answer. Three-line unit tests
 * can't see it. Loose bound on purpose: a cliff detector, not a benchmark.
 */
import { Lang } from "@ast-grep/napi";

import { fallbackExtractor } from "./lang/extractors/fallback";
import { javascriptExtractor } from "./lang/extractors/javascript";

const BUDGET_MS = 10_000;

const tsxExtractor = javascriptExtractor(Lang.Tsx);

function timed(label: string, run: () => Promise<unknown>) {
  it(`${label} finishes well inside the budget`, async () => {
    const started = Date.now();
    await run();
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  });
}

// Unbalanced quotes before backslash runs: the shape that made an equivalent
// regex backtrack exponentially elsewhere.
const escapeDense =
  Array.from(
    { length: 4000 },
    (_, i) => `value = "it's \\\\ ${"\\\\".repeat(8)} escaped ${i}";`
  ).join("\n") + "\n";

const manyLiterals =
  Array.from(
    { length: 8000 },
    (_, i) => `const s${i} = "Some user facing string number ${i}";`
  ).join("\n") + "\n";

// One very long line, as a generated payload looks before the minified check.
const oneHugeLine = `const x = ${Array.from(
  { length: 5000 },
  (_, i) => `"chunk ${i}"`
).join(" + ")};\n`;

timed("fallback extractor on escape-dense source", () =>
  fallbackExtractor.extract({ source: escapeDense, kind: "regex_fallback" })
);

timed("fallback extractor on many literals", () =>
  fallbackExtractor.extract({ source: manyLiterals, kind: "regex_fallback" })
);

timed("fallback extractor on one huge line", () =>
  fallbackExtractor.extract({ source: oneHugeLine, kind: "regex_fallback" })
);

timed("javascript extractor on many literals", () =>
  tsxExtractor.extract({ source: manyLiterals, kind: "tsx" })
);

it("still finds the strings in the large input", async () => {
  // A time bound alone would pass if extraction gave up.
  const hits = await fallbackExtractor.extract({
    source: manyLiterals,
    kind: "regex_fallback",
  });
  expect(hits.length).toBeGreaterThan(7000);
});
