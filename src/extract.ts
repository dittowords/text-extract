import fs from "fs/promises";
import { loadGlobby } from "./lang/globby";
import path from "path";

import {
  DittoScanDetectionKindSchema,
  type DittoScanCandidate,
  type DittoScanDetectionKind,
} from "./types";
import { createHash } from "crypto";
import type { FileDiscoveryStats } from "./lang/file-discovery";
import type { ExtractedHit } from "./lang/types";
import { shouldEmit } from "./rules";
import { walkCodebase } from "./walk";
import type { Language } from "./lang/registry";

export interface DittoScanExtractOptions {
  inputPath: string;
}

export interface DittoScanExtractResult {
  candidates: DittoScanCandidate[];
  summary: DittoScanExtractSummary;
}

export interface DittoScanExtractFailure {
  file: string;
  language: string;
  message: string;
}

// Caps the reported detail, not the count — `filesFailed` stays exact.
const MAX_REPORTED_FAILURES = 20;

export interface DittoScanExtractSummary {
  filesScanned: number;
  filesByKind: Record<string, number>;
  filesSkippedMinified: number;
  candidatesEmitted: number;
  candidatesByKind: Record<DittoScanDetectionKind, number>;
  framework: string[];
  elapsedMs: number;
  i18nFileDiscovery: FileDiscoveryStats | null;
  // Files an extractor threw on. Dropped from the results, so a non-zero count
  // means strings are missing from a scan that otherwise looks clean.
  filesFailed: number;
  failures: DittoScanExtractFailure[];
}

const CONTEXT_LINES = 3;
const MAX_CONTEXT_LINE_CHARS = 200;

// Maps a dependency name in package.json to the framework token we surface
// to the LLM. Only frameworks that meaningfully shift the user-facing
// likelihood of strings are listed (UI frameworks, server frameworks).
const FRAMEWORK_MARKERS: ReadonlyArray<
  readonly [pattern: RegExp, token: string]
> = [
  [/^react-native$/, "react-native"],
  [/^react(-dom)?$/, "react"],
  [/^next$/, "next"],
  [/^@remix-run\//, "remix"],
  [/^vue$/, "vue"],
  [/^nuxt$/, "nuxt"],
  [/^svelte$/, "svelte"],
  [/^@sveltejs\/kit$/, "sveltekit"],
  [/^@angular\/core$/, "angular"],
  [/^solid-js$/, "solid"],
  [/^preact$/, "preact"],
  [/^astro$/, "astro"],
  [/^express$/, "express"],
  [/^fastify$/, "fastify"],
  [/^koa$/, "koa"],
  [/^@nestjs\/core$/, "nestjs"],
  [/^@hapi\/hapi$/, "hapi"],
];

function zeroKindCounts(): Record<DittoScanDetectionKind, number> {
  return Object.fromEntries(
    DittoScanDetectionKindSchema.options.map((k) => [k, 0])
  ) as Record<DittoScanDetectionKind, number>;
}

function buildSourceContext(lines: string[], targetLine: number): string {
  const start = Math.max(1, targetLine - CONTEXT_LINES);
  const end = Math.min(lines.length, targetLine + CONTEXT_LINES);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const raw = lines[i - 1] ?? "";
    const text =
      raw.length > MAX_CONTEXT_LINE_CHARS
        ? raw.slice(0, MAX_CONTEXT_LINE_CHARS) + "…(truncated)"
        : raw;
    out.push(`${i}: ${text}`);
  }
  return out.join("\n");
}

const VCS_MARKERS = [".git", ".hg", ".svn"] as const;

// Aggregates deps from every package.json:
//   - Walking *up* from inputPath to the repo root, since monorepo
//     subpackages often have a near-empty package.json with the real
//     deps living one or more levels up.
//   - Walking *down* from inputPath via gitignore-aware globby, since
//     the inverse is also common: pnpm/yarn workspace monorepos where
//     the root package.json is empty and react/vue/etc. live in
//     `packages/*/package.json`. Without this pass, large frontend
//     monorepos (excalidraw, nx-style repos) would surface
//     `framework: (none detected)`.
//
// On top of the package.json passes, we sniff for native Android/iOS
// project markers anywhere under inputPath so a Gradle-only or
// Xcode-only project still surfaces an `android` / `ios` token to the
// LLM. We never read the marker contents — presence alone is the signal.
async function detectFramework(inputPath: string): Promise<string[]> {
  const tokens = new Set<string>();

  const ingestPackageJson = (raw: string) => {
    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(raw);
    } catch {
      return;
    }
    for (const name of Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    })) {
      for (const [pattern, token] of FRAMEWORK_MARKERS) {
        if (pattern.test(name)) tokens.add(token);
      }
    }
  };

  // Upward walk (inputPath → repo root).
  let dir = path.resolve(inputPath);
  while (true) {
    try {
      ingestPackageJson(
        await fs.readFile(path.join(dir, "package.json"), "utf8")
      );
    } catch {
      // no package.json here, keep walking
    }
    if (await isRepoRoot(dir)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Downward walk (inputPath/**/package.json). Honors .gitignore and
  // skips the usual large-directory denylist so we don't spelunk through
  // node_modules / build artifacts.
  const globby = await loadGlobby();
  const nested = await globby(["**/package.json"], {
    cwd: path.resolve(inputPath),
    gitignore: true,
    onlyFiles: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/build/**",
      "**/dist/**",
      "**/.next/**",
      "**/.nuxt/**",
    ],
    followSymbolicLinks: false,
    suppressErrors: true,
    absolute: true,
  });
  for (const pkgPath of nested) {
    try {
      ingestPackageJson(await fs.readFile(pkgPath, "utf8"));
    } catch {
      // unreadable / malformed, ignore
    }
  }

  for (const platformToken of await detectMobilePlatforms(inputPath)) {
    tokens.add(platformToken);
  }

  return [...tokens].sort();
}

const ANDROID_MARKER_RE =
  /(?:^|\/)(?:AndroidManifest\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/;
const IOS_MARKER_RE =
  /(?:^|\/)(?:[^/]+\.xcodeproj\/project\.pbxproj|Package\.swift|Podfile)$/;

async function detectMobilePlatforms(inputPath: string): Promise<string[]> {
  const tokens = new Set<string>();
  const globby = await loadGlobby();
  const matches = await globby(
    [
      "**/AndroidManifest.xml",
      "**/build.gradle",
      "**/build.gradle.kts",
      "**/settings.gradle",
      "**/settings.gradle.kts",
      "**/*.xcodeproj/project.pbxproj",
      "**/Package.swift",
      "**/Podfile",
    ],
    {
      cwd: path.resolve(inputPath),
      gitignore: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/build/**", "**/Pods/**"],
      followSymbolicLinks: false,
      suppressErrors: true,
    }
  );
  for (const m of matches) {
    if (ANDROID_MARKER_RE.test(m)) tokens.add("android");
    if (IOS_MARKER_RE.test(m)) tokens.add("ios");
  }
  return [...tokens];
}

async function isRepoRoot(dir: string): Promise<boolean> {
  for (const marker of VCS_MARKERS) {
    try {
      await fs.access(path.join(dir, marker));
      return true;
    } catch {
      // marker not present, try the next one
    }
  }
  return false;
}

// Deterministic id for a candidate so the same string in the same place gets
// the same id across runs.
export function makeCandidateId(
  file: string,
  line: number,
  column: number,
  value: string
): string {
  return createHash("sha1")
    .update(`${file}:${line}:${column}:${value}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * The extraction step for one resolved file, no I/O. Both `runExtract` and
 * `extractFile` route through here so there's only one copy of it. Extractor
 * failures propagate; the caller decides what a bad file costs.
 */
export function assignOccurrenceIndexes(
  hits: readonly Pick<ExtractedHit, "value" | "location">[]
): number[] {
  const sourceOrder = hits
    .map((_, index) => index)
    .sort((a, b) => {
      const left = hits[a].location;
      const right = hits[b].location;
      return left.line - right.line || left.column - right.column || a - b;
    });

  const seen = new Map<string, number>();
  const indexes = new Array<number>(hits.length);

  for (const index of sourceOrder) {
    const count = seen.get(hits[index].value) ?? 0;
    indexes[index] = count;
    seen.set(hits[index].value, count + 1);
  }

  return indexes;
}

export async function extractFromResolvedFile(args: {
  relPath: string;
  source: string;
  language: Language;
  languageLabel: string;
  localeKey: string | null;
  framework: string[];
}): Promise<DittoScanCandidate[]> {
  const { relPath, source, language, languageLabel, localeKey, framework } =
    args;
  const hits = await language.extractor.extract({
    source,
    kind: language.id,
  });

  const lines = source.split(/\r?\n/);
  const candidates: DittoScanCandidate[] = [];

  const emitted = hits.filter((hit) => shouldEmit(hit.value, hit.context));
  const occurrenceIndexes = assignOccurrenceIndexes(emitted);

  for (const [index, hit] of emitted.entries()) {
    candidates.push({
      id: makeCandidateId(
        relPath,
        hit.location.line,
        hit.location.column,
        hit.value
      ),
      value_raw: hit.value,
      detection_kind: hit.context.parentRole,
      location: {
        file: relPath,
        line: hit.location.line,
        column: hit.location.column,
      },
      occurrence_index: occurrenceIndexes[index],
      snapshot_text: hit.snapshotText ?? null,
      language: languageLabel,
      locale_key: hit.localeKey ?? localeKey,
      i18n_key: hit.i18nKey ?? null,
      framework,
      source_context: buildSourceContext(lines, hit.location.line),
      context_identifiers: hit.context.identifiers,
      usage_evidence: null,
    });
  }

  return candidates;
}

export async function runExtract(
  opts: DittoScanExtractOptions
): Promise<DittoScanExtractResult> {
  const t0 = Date.now();
  const framework = await detectFramework(opts.inputPath);
  const { files, filesSkippedMinified, i18nFileDiscovery } = await walkCodebase(
    opts.inputPath
  );

  const filesByKind: Record<string, number> = {};
  for (const f of files)
    filesByKind[f.language.id] = (filesByKind[f.language.id] ?? 0) + 1;

  const candidatesByKind = zeroKindCounts();
  const candidates: DittoScanCandidate[] = [];
  const failures: DittoScanExtractFailure[] = [];
  let filesFailed = 0;

  for (const file of files) {
    let fileCandidates: DittoScanCandidate[];
    try {
      fileCandidates = await extractFromResolvedFile({
        relPath: file.relPath,
        source: file.source,
        language: file.language,
        languageLabel: file.languageLabel,
        localeKey: file.localeKey,
        framework,
      });
    } catch (e) {
      // Returned in the summary rather than written to stderr, so callers can
      // surface it however they need.
      filesFailed++;
      if (failures.length < MAX_REPORTED_FAILURES) {
        failures.push({
          file: file.relPath,
          language: file.language.id,
          message: (e as Error).message,
        });
      }
      continue;
    }

    for (const candidate of fileCandidates) {
      candidates.push(candidate);
      candidatesByKind[candidate.detection_kind]++;
    }
  }

  return {
    candidates,
    summary: {
      filesScanned: files.length,
      filesByKind,
      filesSkippedMinified,
      candidatesEmitted: candidates.length,
      candidatesByKind,
      framework,
      elapsedMs: Date.now() - t0,
      i18nFileDiscovery,
      filesFailed,
      failures,
    },
  };
}
