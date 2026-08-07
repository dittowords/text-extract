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

```ts
import { runExtract } from "@dittowords/text-extract";

const { candidates, summary } = await runExtract({ inputPath: "/path/to/repo" });
```

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

The corpus itself isn't vendored; these are whole third-party checkouts. Clone
them as siblings of this repo, or point `CORPUS_DIR` at a directory containing
them. A repo that isn't present is **skipped and reported**, so a partial corpus
gives a partial signal rather than a false pass.

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
