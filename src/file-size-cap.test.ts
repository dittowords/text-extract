import fs from "fs/promises";
import os from "os";
import path from "path";
import { runExtract } from "./extract";
import { extractFile } from "./extract-file";
import { MAX_FILE_BYTES } from "./walk";

// Many short lines, so the minified check does not skip it first.
const oversized = `const s = "Save changes";\n`.repeat(Math.ceil((MAX_FILE_BYTES + 1) / 26));

it("skips a file over the size cap in runExtract and still scans the rest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "size-cap-"));
  try {
    await fs.writeFile(path.join(root, "huge.tsx"), oversized);
    await fs.writeFile(path.join(root, "small.tsx"), `export const s = "Save changes";\n`);
    const { candidates, summary } = await runExtract({ inputPath: root });
    expect(summary.filesSkippedTooLarge).toBe(1);
    expect(summary.filesScanned).toBe(1);
    expect(candidates.every((c) => c.location.file === "small.tsx")).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("skips a source over the size cap in extractFile", async () => {
  const result = await extractFile({ relPath: "huge.tsx", source: oversized });
  expect(result).toEqual({ candidates: [], skipped: "too_large" });
});
