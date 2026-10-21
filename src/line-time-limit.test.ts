import fs from "fs/promises";
import os from "os";
import path from "path";
import { runExtract } from "./extract";
import { extractFile } from "./extract-file";
import { extractWithGrammar, MAX_LINE_LENGTH } from "./lang/extractors/grammar";

// A negative limit makes vscode-textmate stop before its first rule match, so the
// fallback runs on every line without a pathological input.
const STOP_AT_ONCE = -1;
const LONG = "x".repeat(MAX_LINE_LENGTH + 1);
// Short lines keep the mean line length under the `looksMinified` limit.
const PAD = "const pad = 1;\n".repeat(1000);

async function extract(src: string, opts: { lineTimeLimitMs?: number } = {}) {
  const stopped: number[] = [];
  const hits = await extractWithGrammar(src, "tsx", { ...opts, onSkippedLine: (line) => stopped.push(line) });
  return { values: hits.map((h) => [h.value, h.location.line]), stopped };
}

it("skips a line the grammar gave up on and records it", async () => {
  const { values, stopped } = await extract(`const a = "Save changes";\nconst b = t('Cancel');\n`, {
    lineTimeLimitMs: STOP_AT_ONCE,
  });
  expect(values).toEqual([]);
  expect(stopped).toEqual([1, 2, 3]);
});

it("skips a line over MAX_LINE_LENGTH without tokenizing it", async () => {
  const long = `const a = "Save changes"; ${LONG}\n`;
  const hits = await extractWithGrammar(long + `const b = <p>Cancel</p>;\n`, "tsx");
  expect(hits.map((h) => [h.value, h.location.line, h.context.parentRole])).toEqual([["Cancel", 2, "markup_text"]]);
});

it("does not stay inside a comment that ends on a skipped line", async () => {
  const { values, stopped } = await extract(`/* start\n${LONG} */\nconst a = "Save changes";\n`);
  expect(values).toEqual([['"Save changes"', 3]]);
  expect(stopped).toEqual([2]);
});

it("does not stay inside a string that ends on a skipped line", async () => {
  const { values, stopped } = await extract(`const a = \`start\n${LONG}\`;\nconst b = foo;\nconst c = "Cancel";\n`);
  expect(values).toEqual([["`start", 1], ['"Cancel"', 4]]);
  expect(stopped).toEqual([2]);
});

it("keeps the template string open across a skipped line of SVG path data", async () => {
  const path = "M12 2L2 7l10 5 10-5-10-5z ".repeat(200);
  const src = ["const icon = `<svg>", `  <path d="${path}"/>`, "</svg>`;", 'const a = "Save changes";', ""].join("\n");
  const { values, stopped } = await extract(src);
  // The skipped line splits the template string into two hits.
  expect(values).toEqual([["`<svg>", 1], ["</svg>`", 3], ['"Save changes"', 4]]);
  expect(stopped).toEqual([2]);
});

it("keeps the stack from before a skipped line that cannot be shortened", async () => {
  const src = `/* start\n${"a=b;".repeat(MAX_LINE_LENGTH)}\n*/\nconst a = "Save changes";\n`;
  const { values, stopped } = await extract(src);
  expect(values).toEqual([['"Save changes"', 4]]);
  expect(stopped).toEqual([2]);
});

it("gives the event loop a turn inside a large file", async () => {
  // Warm the grammar so loading I/O cannot satisfy the timer assertion.
  await extractWithGrammar(`const s = "warm";\n`, "tsx");
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
  expect((await extract(`const a = "Save changes";\n`)).stopped).toEqual([]);
});

it("extractFile returns stopped lines with its own result", async () => {
  const res = await extractFile({ relPath: "a.tsx", source: `const a = 1;\n${LONG}\n${PAD}` });
  expect(res.stoppedEarlyLines).toEqual([2]);
  const next = await extractFile({ relPath: "b.tsx", source: `const b = 1;\n` });
  expect(next.stoppedEarlyLines).toEqual([]);
});

it("runExtract attributes stopped lines to their file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "line-limit-"));
  try {
    await fs.writeFile(path.join(root, "a.tsx"), `export const s = "Save changes";\n`);
    await fs.writeFile(path.join(root, "b.tsx"), `export const s = "Save changes";\n// ${LONG}\n${PAD}`);
    const { summary } = await runExtract({ inputPath: root });
    expect(summary.linesStoppedEarly).toBe(1);
    expect(summary.stoppedEarlyLines).toEqual([{ file: "b.tsx", line: 2 }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
