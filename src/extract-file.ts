/**
 * Single-file extraction: given a path and its contents, return candidates.
 *
 * This is the entry point for scanning a pull request's changed files, where
 * fetching the whole repo to extract three files would be absurd. It is PURE —
 * no filesystem, no network — so a caller holding a blob's contents can use it
 * directly.
 *
 * It reaches the same verdict per file as `runExtract` does, because it reuses
 * the same pieces: the same language registry, the same per-file i18n
 * admission predicates, the same minified check, and the same extraction loop
 * (`extractFromResolvedFile`). `extract-file.test.ts` asserts the two agree.
 *
 * Two things the caller owns, because they are repo-level facts this function
 * cannot see:
 *
 *  - `framework` — derived from the repo's package.json files and native
 *    project markers. Carry it over from the last full scan; passing `[]` is
 *    valid and only means the classifier loses a hint.
 *  - Path exclusions — `runExtract` skips vendored/build/test trees while
 *    walking, and never hands those paths to extraction. Here the caller
 *    chooses the paths, so the caller must apply the same exclusions. A PR
 *    touching `node_modules/**` should not reach this function.
 */
import path from "path";

import { extractFromResolvedFile } from "./extract";
import {
  extractLocaleFromPath,
  I18N_FILE_EXTENSIONS,
  I18N_FILES_TASK,
} from "./lang/i18n-file-discovery";
import {
  findI18nLanguageForExt,
  findLanguageForFile,
  REGEX_FALLBACK_ID,
  type Language,
} from "./lang/registry";
import { looksMinified, platformLocaleForPath } from "./walk";
import type { DittoScanCandidate } from "./types";

// `runFileDiscoveryTask` reads this many characters off the head of a file for
// the heuristic. Matching it matters: admission must not depend on whether the
// caller had the whole file or a preview.
const PREVIEW_CHARS = 400;

/** Why a file produced no candidates — `null` reason means it was scanned. */
export type SkipReason =
  | "unsupported_language"
  | "unconfirmed_i18n_file"
  | "minified";

export interface ResolvedFile {
  language: Language;
  languageLabel: string;
  localeKey: string | null;
}

export interface ExtractFileResult {
  candidates: DittoScanCandidate[];
  /** Set when the file was not scanned at all. */
  skipped: SkipReason | null;
}

/**
 * The per-file half of the i18n admission heuristic. An i18n-shaped extension
 * (.json, .yaml, …) is only scanned when discovery confirms it actually holds
 * localized copy — otherwise every package.json and tsconfig in the repo would
 * be read as a message catalog.
 *
 * Safe to evaluate per file: the task's three predicates each look at one path
 * and its own head bytes, with no cross-file state. The batch pass in
 * `walkCodebase` only adds the file listing and the stats.
 */
export function admitsAsI18nFile(relPath: string, source: string): boolean {
  const base = path.basename(relPath);
  if (I18N_FILES_TASK.preFilter?.(base, relPath)) return false;
  if (I18N_FILES_TASK.autoInclude?.(relPath)) return true;
  return I18N_FILES_TASK.heuristicMatch(relPath, source.slice(0, PREVIEW_CHARS));
}

/**
 * Decide how (or whether) to scan a file. Mirrors `walkCodebase`'s per-file
 * branch: i18n-shaped extensions go through admission, everything else through
 * the language registry.
 */
export function resolveFile(
  relPath: string,
  source: string
): ResolvedFile | SkipReason {
  const ext = path.extname(relPath).toLowerCase();

  let language: Language | null;
  let localeKey: string | null = null;

  if (I18N_FILE_EXTENSIONS.has(ext)) {
    if (!admitsAsI18nFile(relPath, source)) return "unconfirmed_i18n_file";
    language = findI18nLanguageForExt(ext);
    if (!language) return "unsupported_language";
    localeKey = extractLocaleFromPath(relPath);
  } else {
    language = findLanguageForFile({ ext, relPath });
    if (!language) return "unsupported_language";
    localeKey = platformLocaleForPath(language.id, relPath);
  }

  // Checked after language resolution so an unsupported file reports the more
  // specific reason.
  if (looksMinified(source)) return "minified";

  return {
    language,
    languageLabel:
      language.id === REGEX_FALLBACK_ID ? ext.slice(1) || "unknown" : language.id,
    localeKey,
  };
}

export interface ExtractFileOptions {
  /** Repo-relative POSIX path. Ends up verbatim in `location.file`. */
  relPath: string;
  source: string;
  /** Repo-level framework tokens; `[]` is valid. See the note above. */
  framework?: string[];
}

export async function extractFile(
  opts: ExtractFileOptions
): Promise<ExtractFileResult> {
  const resolved = resolveFile(opts.relPath, opts.source);
  if (typeof resolved === "string") {
    return { candidates: [], skipped: resolved };
  }

  const candidates = await extractFromResolvedFile({
    relPath: opts.relPath,
    source: opts.source,
    language: resolved.language,
    languageLabel: resolved.languageLabel,
    localeKey: resolved.localeKey,
    framework: opts.framework ?? [],
  });

  return { candidates, skipped: null };
}
