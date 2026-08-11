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
| `extract-performance.test.ts` | That the regex fallback doesn't backtrack catastrophically on dense input. |
