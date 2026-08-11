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
yarn test         # unit, golden, and robustness tests — see below
yarn typecheck
yarn build
```

## How this is tested

Three layers, each answering a different question.

**Unit tests, per extractor** (`src/lang/extractors/*.test.ts`) — "does this
construct classify correctly?" Small inputs, exact expected line and column.
This is the workhorse, and it grows with each new extractor.

**Golden tests** (`src/golden.test.ts`) — "is the output right on realistic
files?" Fixtures in `testing/golden/` with the correct answer **decided by hand**
and written down. Nothing here was recorded from output, which is the whole
point: a green run means "still right", not "still the same as last time". Each
case also lists the strings that must *never* be emitted, so the deliberate
rejects (`className`, `data-testid`, import specifiers, `translatable="false"`)
are asserted rather than assumed.

Fixtures are tested under a **realistic `relPath`** that need not match where the
file sits on disk, because path shape is itself an input: it drives i18n
admission (`locales/` in the path) and locale detection (`values-es/`,
`es.lproj/`). One fixture covers several path cases without building fake trees.

When a golden test fails, either extraction regressed or the agreed answer
changed. Both need a person to look, which is the intent.

**Robustness tests** (`src/robustness.test.ts`) — the two failure modes the
other two layers structurally cannot see:

- *Silent data loss.* A file whose extractor throws is dropped and the scan
  continues. That's right for one bad file, but every string in it goes missing
  while the scan reports success. `summary.filesFailed` and `summary.failures`
  make it visible; the test asserts a throwing extractor is counted, that
  healthy files still come through, and that a clean run reports zero.
- *Pathological slowness.* The regex fallback extractor handles every language
  without a dedicated grammar, and a regex over quote- and backslash-dense
  source is the classic catastrophic-backtracking setup. The failure isn't a
  wrong answer, it's pinning a CPU until something kills the process — invisible
  to unit tests on three-line inputs. Synthetic adversarial inputs run under a
  deliberately loose time bound: a cliff detector, not a benchmark.

Both use synthetic input, so there's no corpus to clone and nothing recorded on
disk.

### What none of this covers

Whether extraction got *better*. A change that dropped every real string in a
codebase would pass the robustness layer, and the golden set only knows about
the files in it. Growing the golden set is how that coverage grows — add a case
whenever a real repo turns up copy this gets wrong.

### Proving a change inert

Different question, and it comes up during refactors: *did this change output at
all?* For that, extract before and after and compare as sets — candidate **order
is not stable** between runs, because globby's file iteration order varies, so
compare sets and not bytes. That's a throwaway script for the occasion, not a
standing check; a snapshot of thousands of candidates from an unpinned checkout
encodes no judgment and goes stale the moment you improve something on purpose.
