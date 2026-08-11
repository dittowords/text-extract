/**
 * Deterministic extraction of candidate user-facing strings. Pure: no network,
 * no LLM, no database. Deciding whether a candidate is user-facing is the
 * caller's job. See README.md.
 */

/** Whole-directory extraction. */
export {
  runExtract,
  extractFromResolvedFile,
  makeCandidateId,
  type DittoScanExtractOptions,
  type DittoScanExtractResult,
  type DittoScanExtractSummary,
} from "./extract";

/** Single-file extraction, for a PR's changed files. */
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
