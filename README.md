# @dittowords/text-extract

Finds candidate user-facing strings in a codebase. Pure and deterministic — no
network, no LLM. Deciding whether a candidate *is* user-facing happens
downstream.

Shared by both ways Ditto scans code: the `ditto scan` CLI, and ditto-app's
GitHub integration.

## Usage

**A whole directory:**

```ts
import { runExtract } from "@dittowords/text-extract";

const { candidates, summary } = await runExtract({ inputPath: "/path/to/repo" });
```

**One file** — for a PR's changed files:

```ts
import { extractFile } from "@dittowords/text-extract";

const { candidates, skipped } = await extractFile({
  relPath: "src/Button.tsx",
  source: blobContents,
  framework: ["react", "next"], // from the last full scan; [] is fine
});
```

`skipped` is set when the file wasn't scanned at all (`unsupported_language`,
`unconfirmed_i18n_file`, `minified`) — not the same as scanning it and finding
nothing.

Both entry points share their internals and are asserted to agree per file. But
`extractFile` needs two things from the caller that one file can't reveal:

- **`framework`** — carry it over from the last full scan.
- **Path exclusions** — `runExtract` skips vendored/build/test trees while
  walking. Apply the same exclusions here, so `node_modules/**` never reaches it.

## Development

```sh
yarn test
yarn typecheck
yarn build
```

## Tests

| File | What it answers |
|---|---|
| `lang/extractors/*.test.ts` | Does this construct classify correctly? Small inputs, exact line and column. The workhorse. |
| `golden.test.ts` | Is the output right on realistic files? Expectations are hand-written, so green means "still right", not "still the same". |
| `extract-file.test.ts` | Do `runExtract` and `extractFile` agree? If they drift, a PR scan and a full scan disagree about identical code. |
| `extract-failures.test.ts` | Is a file whose extractor threw reported? It's dropped from results, so an uncounted failure looks like a clean scan. |
| `extract-performance.test.ts` | Does the regex fallback backtrack catastrophically on dense input? Loose bound — a cliff detector, not a benchmark. |

Golden fixtures live in `testing/golden/`, tested under a realistic `relPath`
that need not match where the file sits on disk — path shape drives i18n
admission and locale detection, so one fixture covers several cases.

Nothing here measures whether extraction got *better*. Only the golden set
speaks to quality, and only for the files in it, so add a case whenever a real
repo turns up copy this gets wrong.

## Proving a refactor changed nothing

Extract before and after, and compare candidates as **sets** — order isn't
stable between runs, because globby's file iteration order varies. Worth a
throwaway script for the occasion, not a standing check.
