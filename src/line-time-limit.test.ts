import fs from "fs/promises";
import os from "os";
import path from "path";
import { runExtract } from "./extract";
import {
  extractWithGrammar,
  MAX_LINE_LENGTH,
  takeStoppedEarlyLines,
} from "./lang/extractors/grammar";

// A negative limit makes vscode-textmate stop before its first rule match, so the
// fallback runs on every line without a pathological input.
const STOP_AT_ONCE = -1;

it("skips a line the grammar gave up on and records it", async () => {
  const src = `const a = "Save changes";\nconst b = t('Cancel');\n`;
  const hits = await extractWithGrammar(src, "tsx", { lineTimeLimitMs: STOP_AT_ONCE });
  expect(hits).toEqual([]);
  expect(takeStoppedEarlyLines()).toEqual([1, 2, 3]);
  expect(takeStoppedEarlyLines()).toEqual([]);
});

it("skips a line over MAX_LINE_LENGTH without tokenizing it", async () => {
  const long = `const a = "Save changes"; ${"x".repeat(MAX_LINE_LENGTH)}\n`;
  const hits = await extractWithGrammar(long + `const b = <p>Cancel</p>;\n`, "tsx");
  expect(hits.map((h) => [h.value, h.location.line, h.context.parentRole])).toEqual([["Cancel", 2, "markup_text"]]);
  expect(takeStoppedEarlyLines()).toEqual([1]);
});

it("gives the event loop a turn inside a large file", async () => {
  const src = `export const s = "Save changes";\n`.repeat(20000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await extractWithGrammar(src, "tsx");
  } finally {
    clearInterval(timer);
  }
  expect(ticks).toBeGreaterThan(0);
});

it("reports nothing stopped early under the default limit", async () => {
  await extractWithGrammar(`const a = "Save changes";\n`, "tsx");
  expect(takeStoppedEarlyLines()).toEqual([]);
});

it("runExtract attributes stopped lines to their file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "line-limit-"));
  try {
    await fs.writeFile(
      path.join(root, "a.tsx"),
      `export const s = "Save changes";\n`
    );
    const { summary } = await runExtract({ inputPath: root });
    expect(summary.linesStoppedEarly).toBe(0);
    expect(summary.stoppedEarlyLines).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
