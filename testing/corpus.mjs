/**
 * Corpus regression harness.
 *
 * Extraction quality regressions are invisible to unit tests: a rule change
 * that quietly drops 200 candidates from a real repo passes every assertion.
 * So we snapshot the candidate set for a list of real repos and diff against it.
 *
 *   yarn corpus --write    # record snapshots (do this BEFORE a refactor)
 *   yarn corpus            # compare against them (must be clean after)
 *
 * Runs against the BUILT `dist/` with plain node, deliberately: that's the exact
 * path both consumers take (esbuild leaves this package external, so Node
 * resolves it as CJS at runtime), so the harness exercises the shipped artifact
 * rather than a transpiler's idea of it. globby v16 is ESM-only and reachable
 * from CJS only via Node's require(esm) — so this also guards the packaging.
 *
 * Candidate ORDER is not stable between runs (globby's file iteration order
 * varies), but the candidate SET is. Snapshots are written sorted and compared
 * as sets.
 *
 * The corpus lives outside the repo — these are whole third-party checkouts,
 * far too big to vendor. Point CORPUS_DIR at a directory of clones; any repo
 * named here that isn't present is skipped and REPORTED, so a partial corpus
 * gives a partial signal instead of a false pass.
 */
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { runExtract } from "../dist/index.js";

// Chosen for language spread, not size: JS/TS/JSX + i18n catalogs (excalidraw),
// Kotlin/Android resources, Swift/iOS .strings, and two Next.js apps.
const CORPUS = [
  "excalidraw-gh-bot-test",
  "ditto-android-demo",
  "ditto-ios-demo",
  "ditto-pay-demo",
  "v0-demo",
  "trial-trough",
];

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = process.env.CORPUS_DIR ?? path.resolve(here, "../..");
const SNAPSHOT_DIR = path.resolve(here, "snapshots");

const VALUE_PREVIEW_CHARS = 100;

/**
 * A readable, diffable line per candidate — everything that identifies it,
 * minus `source_context`. Full snapshots run 19MB (source_context is 7 lines
 * of code per candidate), which is too heavy to commit and churns on every
 * change; the digest is ~10x smaller and reviewable in a PR. `fullHash` below
 * covers the fields the digest drops, so nothing goes unchecked.
 */
function digestLine(c) {
  const loc = `${c.location.file}:${c.location.line}:${c.location.column}`;
  const value = JSON.stringify(c.value_raw.slice(0, VALUE_PREVIEW_CHARS));
  const extras = [
    c.locale_key && `locale=${c.locale_key}`,
    c.i18n_key && `key=${c.i18n_key}`,
    c.context_identifiers.length && `ids=${c.context_identifiers.join(",")}`,
  ].filter(Boolean);
  return [c.id, loc, c.language, c.detection_kind, ...extras, value].join("\t");
}

async function snapshot(repoPath) {
  const { candidates } = await runExtract({ inputPath: repoPath });
  const digest = candidates.map(digestLine).sort().join("\n") + "\n";
  // Covers every field, source_context included — a change the digest can't
  // see still trips this.
  const fullHash = createHash("sha256")
    .update(candidates.map((c) => JSON.stringify(c)).sort().join("\n"))
    .digest("hex");
  return { digest, fullHash, count: candidates.length };
}

async function main() {
  const write = process.argv.includes("--write");
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });

  let failed = 0;
  let skipped = 0;
  let compared = 0;

  for (const repo of CORPUS) {
    const repoPath = path.join(CORPUS_DIR, repo);
    try {
      await fs.access(repoPath);
    } catch {
      console.log(`- ${repo}: SKIPPED (not found at ${repoPath})`);
      skipped++;
      continue;
    }

    const digestPath = path.join(SNAPSHOT_DIR, `${repo}.digest`);
    const hashPath = path.join(SNAPSHOT_DIR, `${repo}.sha256`);
    const { digest, fullHash, count } = await snapshot(repoPath);

    if (write) {
      await fs.writeFile(digestPath, digest, "utf8");
      await fs.writeFile(hashPath, fullHash + "\n", "utf8");
      console.log(`✓ ${repo}: wrote ${count} candidates`);
      continue;
    }

    let expected;
    let expectedHash;
    try {
      expected = await fs.readFile(digestPath, "utf8");
      expectedHash = (await fs.readFile(hashPath, "utf8")).trim();
    } catch {
      console.log(`- ${repo}: SKIPPED (no snapshot; run with --write)`);
      skipped++;
      continue;
    }

    compared++;

    if (expected === digest) {
      if (expectedHash === fullHash) {
        console.log(`✓ ${repo}: ${count} candidates match`);
        continue;
      }
      // Same candidates in the same places, but some other field moved —
      // source_context is the only one the digest omits.
      console.log(
        `✗ ${repo}: digest matches but full hash differs — source_context changed`
      );
      failed++;
      continue;
    }

    const before = new Set(expected.trim().split("\n"));
    const after = new Set(digest.trim().split("\n"));
    const added = [...after].filter((l) => !before.has(l));
    const removed = [...before].filter((l) => !after.has(l));
    console.log(
      `✗ ${repo}: ${added.length} added, ${removed.length} removed (${before.size} -> ${after.size})`
    );
    for (const line of removed.slice(0, 5)) console.log(`    - ${line.slice(0, 160)}`);
    for (const line of added.slice(0, 5)) console.log(`    + ${line.slice(0, 160)}`);
    failed++;
  }

  if (skipped) console.log(`\n${skipped} repo(s) skipped — partial coverage.`);
  if (failed) {
    console.log(`\n${failed} repo(s) changed. Intentional? Re-run with --write.`);
    process.exit(1);
  }
  // Comparing nothing is not passing. Snapshots aren't committed (the corpus
  // isn't pinned, so they wouldn't be reproducible), which means a run with no
  // snapshots on disk is the DEFAULT state — and reporting that as success is
  // exactly how a regression walks through.
  if (!write && compared === 0) {
    console.log(
      "\nNothing compared. Record a baseline first: `yarn corpus --write`."
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
