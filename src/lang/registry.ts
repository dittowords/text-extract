import { androidResourceExtractor } from "./extractors/android-resources";
import { arbExtractor } from "./extractors/arb";
import { fallbackExtractor } from "./extractors/fallback";
import { jsonI18nExtractor } from "./extractors/json-i18n";
import { poExtractor } from "./extractors/po";
import { propertiesExtractor } from "./extractors/properties";
import { resxExtractor } from "./extractors/resx";
import { stringsExtractor } from "./extractors/strings";
import { stringsdictExtractor } from "./extractors/stringsdict";
import { grammarExtractor } from "./extractors/grammar";
import { xcstringsExtractor } from "./extractors/xcstrings";
import { xliffExtractor } from "./extractors/xliff";
import { yamlI18nExtractor } from "./extractors/yaml-i18n";
import type { LanguageExtractor } from "./types";

export interface Language {
  id: string;
  extensions: string[];
  extractor: LanguageExtractor;
  // Optional second-stage filter. When the extension matches but the
  // pathMatches predicate rejects, this language is skipped. Used to
  // narrow an ambiguous extension like ".xml" to Android `res/values/`.
  // Note that iOS `.strings`/`.stringsdict` deliberately do not use a
  // pathMatches filter — every locale flows through.
  pathMatches?: (relPath: string) => boolean;
}

export const REGEX_FALLBACK_ID = "regex_fallback";

// Source-code-like extensions with no grammar either; the regex fallback
// still catches their quoted literals.
const REGEX_FALLBACK_EXTENSIONS: ReadonlySet<string> = new Set([".ejs"]);

// `res/values/` and locale-qualified `res/values-<X>/` both flow
// through; downstream groups by resource key.
function isAndroidResource(relPath: string): boolean {
  return /(^|\/)res\/values(?:-[^/]+)?\/[^/]+\.xml$/i.test(relPath);
}

// Web i18n formats (.json/.yaml/.po) are gated by the LLM discovery
// pass in `walk.ts` rather than by a path predicate here.

export const LANGUAGES: readonly Language[] = [
  // Code and markup go through the grammar extractor; `id` is the
  // `tm-grammars` grammar name.
  { id: "typescript", extensions: [".ts", ".cts", ".mts"], extractor: grammarExtractor },
  { id: "tsx", extensions: [".tsx"], extractor: grammarExtractor },
  { id: "javascript", extensions: [".js", ".cjs", ".mjs"], extractor: grammarExtractor },
  { id: "jsx", extensions: [".jsx"], extractor: grammarExtractor },
  { id: "html", extensions: [".html", ".htm"], extractor: grammarExtractor },
  { id: "vue", extensions: [".vue"], extractor: grammarExtractor },
  // Kotlin grammar also handles .kts (Gradle scripts) and .ktm (Kotlin modules).
  { id: "kotlin", extensions: [".kt", ".kts", ".ktm"], extractor: grammarExtractor },
  { id: "swift", extensions: [".swift"], extractor: grammarExtractor },
  { id: "python", extensions: [".py"], extractor: grammarExtractor },
  { id: "go", extensions: [".go"], extractor: grammarExtractor },
  { id: "ruby", extensions: [".rb"], extractor: grammarExtractor },
  { id: "java", extensions: [".java"], extractor: grammarExtractor },
  { id: "rust", extensions: [".rs"], extractor: grammarExtractor },
  { id: "c", extensions: [".c", ".h"], extractor: grammarExtractor },
  { id: "cpp", extensions: [".cc", ".cpp", ".hpp"], extractor: grammarExtractor },
  { id: "objective-c", extensions: [".m"], extractor: grammarExtractor },
  { id: "objective-cpp", extensions: [".mm"], extractor: grammarExtractor },
  { id: "csharp", extensions: [".cs"], extractor: grammarExtractor },
  // Laravel templates share the `.php` extension, so they go first.
  { id: "blade", extensions: [".php"], extractor: grammarExtractor, pathMatches: (p) => /\.blade\.php$/i.test(p) },
  { id: "php", extensions: [".php"], extractor: grammarExtractor },
  { id: "lua", extensions: [".lua"], extractor: grammarExtractor },
  { id: "dart", extensions: [".dart"], extractor: grammarExtractor },
  { id: "svelte", extensions: [".svelte"], extractor: grammarExtractor },
  { id: "astro", extensions: [".astro"], extractor: grammarExtractor },
  { id: "handlebars", extensions: [".hbs"], extractor: grammarExtractor },
  { id: "liquid", extensions: [".liquid"], extractor: grammarExtractor },
  { id: "erb", extensions: [".erb"], extractor: grammarExtractor },
  { id: "jinja-html", extensions: [".jinja", ".jinja2", ".j2", ".njk"], extractor: grammarExtractor },
  { id: "twig", extensions: [".twig"], extractor: grammarExtractor },
  // iOS .lproj/ files — every locale flows through.
  { id: "ios_strings", extensions: [".strings"], extractor: stringsExtractor },
  { id: "ios_stringsdict", extensions: [".stringsdict"], extractor: stringsdictExtractor },
  // Xcode String Catalog: every locale lives in one file; the extractor
  // walks each locale block internally.
  { id: "ios_xcstrings", extensions: [".xcstrings"], extractor: xcstringsExtractor },
  {
    id: "android_resources",
    extensions: [".xml"],
    extractor: androidResourceExtractor,
    pathMatches: isAndroidResource,
  },
  // Bound by extension via findI18nLanguageForExt after the walker's
  // LLM discovery pass admits the file.
  { id: "json_i18n", extensions: [".json"], extractor: jsonI18nExtractor },
  { id: "yaml_i18n", extensions: [".yaml", ".yml"], extractor: yamlI18nExtractor },
  { id: "po", extensions: [".po"], extractor: poExtractor },
  { id: "properties", extensions: [".properties"], extractor: propertiesExtractor },
  { id: "arb", extensions: [".arb"], extractor: arbExtractor },
  { id: "xliff", extensions: [".xliff", ".xlf"], extractor: xliffExtractor },
  { id: "resx", extensions: [".resx", ".resw"], extractor: resxExtractor },
];

const REGEX_FALLBACK_LANGUAGE: Language = {
  id: REGEX_FALLBACK_ID,
  extensions: [],
  extractor: fallbackExtractor,
};

export function findLanguageForFile({ ext, relPath }: { ext: string; relPath: string }): Language | null {
  const lower = ext.toLowerCase();
  for (const lang of LANGUAGES) {
    if (!lang.extensions.includes(lower)) continue;
    if (lang.pathMatches && !lang.pathMatches(relPath)) continue;
    return lang;
  }
  return REGEX_FALLBACK_EXTENSIONS.has(lower) ? REGEX_FALLBACK_LANGUAGE : null;
}

const I18N_LANGUAGE_IDS = new Set(["json_i18n", "yaml_i18n", "po", "properties", "arb", "xliff", "resx"]);

// Used by the walker once the LLM discovery pass has already admitted
// a path — skips the normal dispatch loop's pathMatches check.
export function findI18nLanguageForExt(ext: string): Language | null {
  const lower = ext.toLowerCase();
  for (const lang of LANGUAGES) {
    if (!I18N_LANGUAGE_IDS.has(lang.id)) continue;
    if (lang.extensions.includes(lower)) return lang;
  }
  return null;
}
