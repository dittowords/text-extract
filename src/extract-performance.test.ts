/**
 * A grammar is a set of regexes. Source dense with quotes and backslashes
 * is the classic input for catastrophic backtracking. The failure is a CPU
 * at 100%, not a wrong answer, so a small unit test does not show it. The
 * bound is loose on purpose. This is a cliff detector, not a benchmark.
 */

import { grammarExtractor } from "./lang/extractors/grammar";

const BUDGET_MS = 10_000;

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

timed("escape-dense source", () => grammarExtractor.extract({ source: escapeDense, kind: "tsx" }));

timed("many literals", () => grammarExtractor.extract({ source: manyLiterals, kind: "tsx" }));

timed("one huge line", () => grammarExtractor.extract({ source: oneHugeLine, kind: "tsx" }));

it("still finds the strings in the large input", async () => {
  // A time bound alone would pass if extraction gave up.
  const hits = await grammarExtractor.extract({ source: manyLiterals, kind: "tsx" });
  expect(hits.length).toBeGreaterThan(7000);
});
