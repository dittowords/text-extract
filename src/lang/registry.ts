import { androidResourceExtractor } from "./extractors/android-resources";
import { arbExtractor } from "./extractors/arb";
import { jsonI18nExtractor } from "./extractors/json-i18n";
import { poExtractor } from "./extractors/po";
import { propertiesExtractor } from "./extractors/properties";
import { resxExtractor } from "./extractors/resx";
import { stringsExtractor } from "./extractors/strings";
import { stringsdictExtractor } from "./extractors/stringsdict";
import { grammarExtractor } from "./extractors/grammar";
import { GRAMMAR_LANGUAGES } from "./grammars";
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

// `res/values/` and locale-qualified `res/values-<X>/` both flow
// through; downstream groups by resource key.
function isAndroidResource(relPath: string): boolean {
  return /(^|\/)res\/values(?:-[^/]+)?\/[^/]+\.xml$/i.test(relPath);
}

// Web i18n formats (.json/.yaml/.po) are gated by the LLM discovery
// pass in `walk.ts` rather than by a path predicate here.

export const LANGUAGES: readonly Language[] = [
  ...GRAMMAR_LANGUAGES.map((g) => ({
    id: g.grammar,
    extensions: g.extensions,
    extractor: grammarExtractor,
    pathMatches: g.pathMatches,
  })),
  // iOS .lproj/ files — every locale flows through.
  { id: "ios_strings", extensions: [".strings"], extractor: stringsExtractor },
  {
    id: "ios_stringsdict",
    extensions: [".stringsdict"],
    extractor: stringsdictExtractor,
  },
  // Xcode String Catalog: every locale lives in one file; the extractor
  // walks each locale block internally.
  {
    id: "ios_xcstrings",
    extensions: [".xcstrings"],
    extractor: xcstringsExtractor,
  },
  {
    id: "android_resources",
    extensions: [".xml"],
    extractor: androidResourceExtractor,
    pathMatches: isAndroidResource,
  },
  // Bound by extension via findI18nLanguageForExt after the walker's
  // LLM discovery pass admits the file.
  { id: "json_i18n", extensions: [".json"], extractor: jsonI18nExtractor },
  {
    id: "yaml_i18n",
    extensions: [".yaml", ".yml"],
    extractor: yamlI18nExtractor,
  },
  { id: "po", extensions: [".po"], extractor: poExtractor },
  {
    id: "properties",
    extensions: [".properties"],
    extractor: propertiesExtractor,
  },
  { id: "arb", extensions: [".arb"], extractor: arbExtractor },
  { id: "xliff", extensions: [".xliff", ".xlf"], extractor: xliffExtractor },
  { id: "resx", extensions: [".resx", ".resw"], extractor: resxExtractor },
];

export function findLanguageForFile({
  ext,
  relPath,
}: {
  ext: string;
  relPath: string;
}): Language | null {
  const lower = ext.toLowerCase();
  for (const lang of LANGUAGES) {
    if (!lang.extensions.includes(lower)) continue;
    if (lang.pathMatches && !lang.pathMatches(relPath)) continue;
    return lang;
  }
  return null;
}

const I18N_LANGUAGE_IDS = new Set([
  "json_i18n",
  "yaml_i18n",
  "po",
  "properties",
  "arb",
  "xliff",
  "resx",
]);

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
