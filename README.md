# @dittowords/text-extract

Deterministic extraction of candidate user-facing strings from a codebase.

This is the shared engine behind both ways Ditto scans code:

- **`ditto scan`** (the CLI) — runs against a local working directory.
- **Ditto's GitHub integration** (ditto-app) — runs server-side against a
  checkout in a temp dir, and against changed files on a pull request.

Both were maintained as separate forks of the same code and drifted. This
package is the single copy.

## The one rule

**This package is pure.** No network, no LLM, no database, no config, no
telemetry. Given a directory (or a file's contents), it returns candidates.

That constraint is load-bearing, not stylistic:

- It's what makes the two consumers substitutable — the CLI runs on a user's
  machine against their private source, and it must not phone home.
- It's what keeps `runExtract` cheap enough to call in one step instead of
  fanning out across a job queue.
- The moment this needs an API key it stops being a library and becomes a
  service, and both consumers have to change shape.

Deciding *whether a candidate is user-facing* is the caller's job. In
ditto-app that's the classify pipeline (`services/ai/productTextDetection`).
The deterministic accept/reject rules belong here; the LLM does not.

## Usage

Two entry points, for the two shapes the work comes in.

**A whole directory** — `ditto scan`, or a repo checkout server-side:

```ts
import { runExtract } from "@dittowords/text-extract";

const { candidates, summary } = await runExtract({ inputPath: "/path/to/repo" });
```

**One file** — a pull request's changed files, where fetching the whole repo to
extract three files would be absurd. Pure: no filesystem, no network, so a
caller holding a blob's contents can use it directly.

```ts
import { extractFile } from "@dittowords/text-extract";

const { candidates, skipped } = await extractFile({
  relPath: "src/Button.tsx",
  source: blobContents,
  framework: ["react", "next"], // carry over from the last full scan; [] is fine
});
```

`skipped` is non-null when the file wasn't scanned at all
(`unsupported_language`, `unconfirmed_i18n_file`, `minified`) — distinct from
scanning it and finding nothing.

The two agree per file, because they share the language registry, the i18n
admission predicates, the minified check, and the extraction loop.
`src/extract-file.test.ts` asserts that directly rather than trusting it: if
they ever diverge, a PR scan and a full scan would produce different text items
for identical code.

Two repo-level facts `extractFile` can't see, so the caller owns them:

- **`framework`** — derived from the repo's `package.json` files and native
  project markers. Carry it from the last full scan.
- **Path exclusions** — `runExtract` skips vendored/build/test trees while
  walking. Here the caller picks the paths, so the caller applies the same
  exclusions. A PR touching `node_modules/**` shouldn't reach `extractFile`.

## Development

```sh
yarn test         # see "How this is tested" below
yarn typecheck
yarn build
```

## How this is tested

**Unit tests per extractor** (`src/lang/extractors/*.test.ts`) — does this
construct classify correctly? Small inputs, exact line and column. The workhorse.

**Golden tests** (`src/golden.test.ts`) — is the output right on realistic files?
Fixtures in `testing/golden/`, with expectations decided by hand rather than
recorded, so a green run means "still right" and not "still the same". Each case
also lists strings that must *never* be emitted, which pins the deliberate
rejects. Fixtures are tested under a realistic `relPath` that need not match
their location on disk, since path shape drives i18n admission and locale
detection.

**Failure tests** (`src/extract-failures.test.ts`) — a file whose extractor
throws is dropped so one bad file can't cost a whole scan, which means its
strings vanish from results that otherwise look clean. `summary.filesFailed`
and `summary.failures` carry it; these assert the count, that healthy files
still come through, and that a clean run reports zero.

**Performance tests** (`src/extract-performance.test.ts`) — the regex fallback
handles every language without a grammar, and a regex over quote/backslash-dense
source can backtrack catastrophically. The failure is a pinned CPU, not a wrong
answer, so the bound is loose: a cliff detector, not a benchmark.

### What this doesn't cover

Whether extraction got *better*. A change that dropped every real string would
pass everything except the golden set, and the golden set only knows the files
in it. Add a case whenever a real repo turns up copy this gets wrong.

### Proving a change inert

A different question that comes up during refactors: did output change at all?
Extract before and after and compare as **sets** — candidate order isn't stable
between runs, because globby's file iteration order varies. Worth a throwaway
script for the occasion, not a standing check: a snapshot of thousands of
candidates encodes no judgment and goes stale as soon as you improve something
on purpose.
