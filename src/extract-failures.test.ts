/**
 * Dropping a file whose extractor throws is right; dropping it silently isn't.
 * Uncounted, a grammar that broke on every .kt file in a repo would look like a
 * clean scan that just happened to find no Kotlin copy.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";

import { runExtract } from "./extract";
import { findLanguageForFile } from "./lang/registry";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "text-extract-fail-"));
  // Stops framework detection walking above the fixture.
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
  // The registry builds one extractor instance per language id, so the spy has
  // to target that instance — it's the object runExtract will call.
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

  expect(candidates.map((c) => c.value_raw)).toContain("Real copy here");
  // Genuinely absent — which is why the count above has to be surfaced.
  expect(candidates.map((c) => c.value_raw)).not.toContain("Also real copy");

  spy.mockRestore();
});

it("reports no failures on healthy input", async () => {
  const { summary } = await runExtract({ inputPath: dir });
  expect(summary.filesFailed).toBe(0);
  expect(summary.failures).toEqual([]);
});
