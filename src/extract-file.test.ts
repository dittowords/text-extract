import fs from "fs/promises";
import os from "os";
import path from "path";

import { runExtract } from "./extract";
import { extractFile, resolveFile } from "./extract-file";

// A small tree that exercises the branches where the two entry points could
// disagree: JSX markup, an admitted i18n catalog, and an i18n-SHAPED file that
// must NOT be admitted (package.json is the canonical trap — it's .json and
// full of strings).
const FILES: Record<string, string> = {
  "src/Button.tsx": [
    "export function Button() {",
    "  return (",
    '    <button aria-label="Save your work" className="btn">',
    "      Save changes",
    "    </button>",
    "  );",
    "}",
  ].join("\n"),
  "locales/en/common.json": JSON.stringify(
    { greeting: "Hello there", nav: { home: "Home page" } },
    null,
    2
  ),
  "package.json": JSON.stringify(
    { name: "fixture", version: "1.0.0", dependencies: { react: "^18.0.0" } },
    null,
    2
  ),
};

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "text-extract-"));
  // Stops framework detection walking above the fixture, which would make the
  // detected tokens depend on wherever the tmpdir happens to live.
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("extractFile", () => {
  // The load-bearing test. runExtract walks a directory; extractFile takes one
  // file. If they ever disagree, a PR scan and a full scan produce different
  // text items for identical code — the exact drift this package exists to end.
  it("produces the same candidates per file as a full runExtract", async () => {
    const { candidates, summary } = await runExtract({ inputPath: dir });
    expect(candidates.length).toBeGreaterThan(0);

    const byFile = new Map<string, string[]>();
    for (const c of candidates) {
      const list = byFile.get(c.location.file) ?? [];
      list.push(JSON.stringify(c));
      byFile.set(c.location.file, list);
    }

    // Without this the per-file comparison below could pass vacuously: an
    // empty list on both sides is "agreement" that proves nothing.
    expect(byFile.get("src/Button.tsx")?.length).toBeGreaterThan(0);
    expect(byFile.get("locales/en/common.json")?.length).toBeGreaterThan(0);
    expect(byFile.has("package.json")).toBe(false);

    for (const rel of Object.keys(FILES)) {
      const { candidates: single } = await extractFile({
        relPath: rel,
        source: FILES[rel],
        // Repo-level fact runExtract derives and extractFile can't see.
        framework: summary.framework,
      });
      expect(single.map((c) => JSON.stringify(c)).sort()).toEqual(
        (byFile.get(rel) ?? []).sort()
      );
    }
  });

  it("admits a locale catalog and reports why it skipped package.json", async () => {
    const catalog = await extractFile({
      relPath: "locales/en/common.json",
      source: FILES["locales/en/common.json"],
    });
    expect(catalog.skipped).toBeNull();
    expect(catalog.candidates.map((c) => c.value_raw)).toEqual(
      expect.arrayContaining(["Hello there", "Home page"])
    );
    // The locale comes from the path, not the contents.
    expect(catalog.candidates.every((c) => c.locale_key === "en")).toBe(true);

    const pkg = await extractFile({
      relPath: "package.json",
      source: FILES["package.json"],
    });
    expect(pkg.skipped).toBe("unconfirmed_i18n_file");
    expect(pkg.candidates).toEqual([]);
  });

  it("skips files it cannot scan instead of throwing", async () => {
    expect(await extractFile({ relPath: "a.bin", source: "hello" })).toEqual({
      candidates: [],
      skipped: "unsupported_language",
    });
    // Mean line length over the threshold reads as a bundle.
    const minified = "a".repeat(2048);
    expect(resolveFile("dist/app.js", minified)).toBe("minified");
  });

  it("defaults framework to empty rather than guessing", async () => {
    const { candidates } = await extractFile({
      relPath: "src/Button.tsx",
      source: FILES["src/Button.tsx"],
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.framework.length === 0)).toBe(true);
  });
});
