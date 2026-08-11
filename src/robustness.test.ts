/**
 * The two failure modes unit tests on small inputs can't see, and that a golden
 * file can't either: silent data loss, and pathological slowness.
 *
 * Both are written as ordinary deterministic tests against synthetic input, so
 * they need no corpus of real repos and nothing recorded on disk.
 */
import { Lang } from "@ast-grep/napi";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { runExtract } from "./extract";
import { fallbackExtractor } from "./lang/extractors/fallback";
import { javascriptExtractor } from "./lang/extractors/javascript";
import { findLanguageForFile } from "./lang/registry";

// `javascriptExtractor` is a factory — the registry builds one instance per
// language id. So the perf cases construct their own, while the failure case
// below has to reach the registry's instance, since that's the object
// `runExtract` will actually call.
const tsxExtractor = javascriptExtractor(Lang.Tsx);

describe("extraction failures are reported, not swallowed", () => {
  // `runExtract` drops a file whose extractor throws and carries on, which is
  // right — one unparseable file shouldn't cost the whole scan. But the file's
  // strings are gone, so if this weren't counted, a grammar that broke on every
  // .kt file in a repo would produce a scan that looked clean and simply had no
  // Kotlin copy in it.
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "text-extract-fail-"));
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "ok.tsx"),
      "export const A = () => <p>Real copy here</p>;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(dir, "broken.tsx"),
      "export const B = () => <p>Also real copy</p>;\n",
      "utf8"
    );
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("counts a throwing extractor and still returns the other files", async () => {
    const tsx = findLanguageForFile({ ext: ".tsx", relPath: "any.tsx" });
    if (!tsx) throw new Error("expected .tsx to resolve to a language");

    const realExtract = tsx.extractor.extract.bind(tsx.extractor);
    const spy = jest
      .spyOn(tsx.extractor, "extract")
      .mockImplementation(async (input) => {
        if (input.source.includes("Also real copy")) {
          throw new Error("simulated grammar failure");
        }
        return realExtract(input);
      });

    const { candidates, summary } = await runExtract({ inputPath: dir });

    expect(summary.filesFailed).toBe(1);
    expect(summary.failures).toEqual([
      {
        file: "broken.tsx",
        language: expect.any(String),
        message: "simulated grammar failure",
      },
    ]);

    // The healthy file still came through — a failure isn't fatal.
    expect(candidates.map((c) => c.value_raw)).toContain("Real copy here");
    // And the broken file's copy is genuinely absent, which is exactly why the
    // count above has to be surfaced to the caller.
    expect(candidates.map((c) => c.value_raw)).not.toContain("Also real copy");

    spy.mockRestore();
  });

  it("reports no failures on healthy input", async () => {
    const { summary } = await runExtract({ inputPath: dir });
    expect(summary.filesFailed).toBe(0);
    expect(summary.failures).toEqual([]);
  });
});

describe("extraction does not blow up on adversarial input", () => {
  // The regex-based fallback extractor handles every language without a
  // dedicated grammar (.py, .go, .rb, .java, …). A regex over quote- and
  // backslash-dense source is the classic catastrophic-backtracking setup, and
  // the failure mode isn't a wrong answer — it's pinning a CPU until something
  // kills the process. Unit tests on three-line inputs cannot see it.
  //
  // The bound is deliberately loose. This is a cliff detector, not a
  // benchmark: it should never flake on a slow machine, and it should scream
  // when linear turns quadratic.
  const BUDGET_MS = 10_000;

  function timed(label: string, run: () => Promise<unknown>) {
    it(`${label} finishes well inside the budget`, async () => {
      const started = Date.now();
      await run();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });
  }

  // Escape-dense: unbalanced quotes followed by backslash runs is the shape
  // that made an equivalent regex elsewhere backtrack exponentially.
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

  // A single very long line, which is what a template or generated payload
  // looks like before the minified check catches the file.
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
    // A time bound alone would pass if extraction silently gave up.
    const hits = await fallbackExtractor.extract({
      source: manyLiterals,
      kind: "regex_fallback",
    });
    expect(hits.length).toBeGreaterThan(7000);
  });
});
