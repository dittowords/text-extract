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
export {
  runExtract,
  makeCandidateId,
  type DittoScanExtractOptions,
  type DittoScanExtractResult,
  type DittoScanExtractSummary,
} from "./extract";

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
