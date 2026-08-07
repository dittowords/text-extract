/**
 * Deterministic extraction of candidate user-facing strings from a codebase.
 *
 * This is the shared engine behind both `ditto scan` (CLI, local filesystem)
 * and Ditto's GitHub integration (server-side, a checkout in a temp dir). It is
 * deliberately PURE: no network, no LLM, no database, no config. Classification
 * of a candidate is the caller's job — see ditto-app's classify pipeline.
 *
 * The surface here intentionally mirrors what `cli/lib/src/scan` exported
 * before the move, so switching the CLI over is provably a no-op. The
 * `extractFile` / repo-level split comes next.
 */
/** Whole-directory extraction — `ditto scan`, and a repo checkout server-side. */
export {
  runExtract,
  extractFromResolvedFile,
  makeCandidateId,
  type DittoScanExtractOptions,
  type DittoScanExtractResult,
  type DittoScanExtractSummary,
} from "./extract";

/**
 * Single-file extraction — a pull request's changed files. Pure: hand it a path
 * and its contents. Reaches the same verdict per file as `runExtract`, which
 * `extract-file.test.ts` asserts directly.
 */
export {
  extractFile,
  resolveFile,
  admitsAsI18nFile,
  type ExtractFileOptions,
  type ExtractFileResult,
  type ResolvedFile,
  type SkipReason,
} from "./extract-file";

export { shouldEmit } from "./rules";

export {
  walkCodebase,
  type DiscoveredFile,
  type WalkResult,
} from "./walk";

export {
  DittoScanCandidateSchema,
  DittoScanDetectionKindSchema,
  DittoScanStatusSchema,
  DittoScanUsageEvidenceSchema,
  type DittoScanCandidate,
  type DittoScanDetectionKind,
  type DittoScanEnclosingContext,
  type DittoScanStatus,
  type DittoScanUsageEvidence,
} from "./types";

export type { FileDiscoveryStats } from "./lang/file-discovery";
export type { ExtractedHit, LanguageExtractor } from "./lang/types";
