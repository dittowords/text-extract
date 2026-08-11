/**
 * Pure single-file extraction, for scanning a PR's changed files.
 *
 * Agrees with `runExtract` per file by sharing its pieces; `extract-file.test.ts`
 * asserts that. Two repo-level facts the caller must supply, since this can't
 * see them: `framework`, and the path exclusions `runExtract` applies while
 * walking (don't pass it `node_modules/**`).
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

// Must match what `runFileDiscoveryTask` reads, or admission would depend on
// how much of the file the caller had.
const PREVIEW_CHARS = 400;

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
 * An i18n-shaped extension (.json, .yaml, …) is scanned only if it looks like it
 * holds localized copy — otherwise every package.json reads as a message catalog.
 * Safe per file: the task's predicates use one path and its own head bytes, so
 * the batch pass in `walkCodebase` adds only the listing and stats.
 */
export function admitsAsI18nFile(relPath: string, source: string): boolean {
  const base = path.basename(relPath);
  if (I18N_FILES_TASK.preFilter?.(base, relPath)) return false;
  if (I18N_FILES_TASK.autoInclude?.(relPath)) return true;
  return I18N_FILES_TASK.heuristicMatch(relPath, source.slice(0, PREVIEW_CHARS));
}

/** Mirrors `walkCodebase`'s per-file branch. */
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

  // After language resolution, so an unsupported file reports that instead.
  if (looksMinified(source)) return "minified";

  return {
    language,
    languageLabel:
      language.id === REGEX_FALLBACK_ID ? ext.slice(1) || "unknown" : language.id,
    localeKey,
  };
}

export interface ExtractFileOptions {
  /** Repo-relative POSIX path; used verbatim as `location.file`. */
  relPath: string;
  source: string;
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
