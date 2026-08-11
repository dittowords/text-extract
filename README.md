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
yarn test         # unit tests — extraction and rules are deterministic
yarn typecheck
yarn build
yarn corpus       # corpus regression check (see below)
```

## The corpus check

Unit tests can't see extraction *quality* regressions: a rule change that
quietly drops 500 candidates from a real repo passes every assertion. So
`testing/corpus.mjs` snapshots the candidate set for a list of real repos and
diffs against it.

```sh
yarn corpus --write   # record snapshots (do this BEFORE a refactor)
yarn corpus           # compare (must be clean after a change that shouldn't alter output)
```

A snapshot is two files per repo: a readable `.digest` (one line per candidate —
id, location, kind, value preview) and a `.sha256` over the full serialization,
which catches the one field the digest omits (`source_context`, 7 lines of code
per candidate — including it made snapshots 19MB).

**Snapshots are gitignored, deliberately.** The corpus isn't pinned — these are
whole third-party checkouts, and `CORPUS_DIR` points at whatever is on disk — so
a committed snapshot would fail for everyone whose checkout sits at a different
commit, for reasons unrelated to the code. And the instinctive fix for a red
corpus check is `--write`, which silently overwrites the baseline. So this is a
local before/after tool: record, change, compare.

Consequently a run with no snapshots is the normal state on a fresh clone, and
**comparing nothing exits non-zero** rather than reporting success. Same for a
repo that isn't on disk: skipped and reported, never silently passed.

To make this CI-enforceable, the corpus would need pinning — a manifest of repo
URL plus commit SHA, and a fetch step. Worth doing when extraction changes start
landing regularly; extraction itself only takes a couple of seconds per repo, so
cloning is the only real cost.

Two things worth knowing about the output:

- Candidate **order** is not stable between runs — globby's file iteration order
  varies. The candidate **set** is stable. Snapshots are sorted and compared as
  sets.
- `globby` v16 is ESM-only, and `unicorn-magic/node` is only exported under the
  `import` condition, so requiring it from CJS fails. It works because both
  consumers bundle with esbuild leaving this package external, and Node ≥22
  resolves it through `require(esm)`. The corpus harness deliberately runs
  against the built `dist/` with plain node so it exercises that exact path
  rather than a transpiler's idea of it.
