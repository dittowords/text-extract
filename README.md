# @dittowords/text-extract

Finds strings in a codebase that are potentially user-facing.

## Usage

**A whole directory:**

```ts
import { runExtract } from "@dittowords/text-extract";

const { candidates, summary } = await runExtract({ inputPath: "/path/to/repo" });
```

Skips vendored, build and test trees, and honors `.gitignore`.

**One file:**

```ts
import { extractFile } from "@dittowords/text-extract";

const { candidates, skipped } = await extractFile({
  relPath: "src/Button.tsx", // used verbatim as `location.file`
  source: fileContents,
  framework: ["react", "next"], // optional
});
```

Scans whatever path it's given — no exclusions are applied. `framework` is the
same token list `runExtract` derives from `package.json` files and native
project markers; omitting it only costs a classification hint.

`skipped` is set when the file wasn't scanned at all (`unsupported_language`,
`unconfirmed_i18n_file`, `minified`) — not the same as scanning it and finding
nothing.

Both entry points reach the same verdict on the same file.

### Notes

- Candidate order may not be stable between runs, because globby's file iteration
  order varies. The set is stable; compare accordingly.
- `summary.filesFailed` counts files an extractor threw on. They're dropped from
  the results, so a non-zero count means strings are missing.
- `summary.linesStoppedEarly` counts lines that were skipped because they are
  longer than `MAX_LINE_LENGTH` or slower than `LINE_TIME_LIMIT_MS` to tokenize.
  A skipped line has no candidates. `summary.stoppedEarlyLines` lists up to 20
  skipped lines with their files. `extractFile` returns all skipped lines of its
  file in `stoppedEarlyLines`.

## Development

```sh
yarn test
yarn typecheck
yarn build
```

| Tests | |
|---|---|
| `lang/extractors/*.test.ts` | Per-construct classification. Exact line and column. |
| `golden.test.ts` | Realistic fixtures from `testing/golden/`, with hand-written expectations. Fixtures are tested under a `relPath` that need not match their location on disk, since path shape drives i18n admission and locale detection. |
| `extract-file.test.ts` | That the two entry points agree per file. |
| `extract-failures.test.ts` | That a throwing extractor is counted, not swallowed. |
| `extract-performance.test.ts` | That the grammar extractor doesn't backtrack catastrophically on dense input. |
| `line-time-limit.test.ts` | That long or slow lines are skipped and reported per file, and that the state after a skipped line is correct. |
