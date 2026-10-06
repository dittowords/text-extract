import { z } from "zod";

// The LLM's verdict on a candidate.
export const DittoScanStatusSchema = z.enum(["user-facing", "not-user-facing", "unsure", "error"]);
export type DittoScanStatus = z.infer<typeof DittoScanStatusSchema>;

// The syntactic site a string was found in.
export const DittoScanDetectionKindSchema = z.enum([
  "markup_text", // text content of a JSX/HTML-like element
  "markup_attr", // value of an HTML-shaped attribute
  "resource_value", // value inside a localization resource file (strings.xml, .strings, .stringsdict, .xcstrings)
  "other", // any other string position — the LLM reads source_context for nuance
]);
export type DittoScanDetectionKind = z.infer<typeof DittoScanDetectionKindSchema>;

// The extractor's view of a hit's site: the kind, and the attribute name or the
// resource key path. Surfaced on the candidate as `detection_kind` and
// `context_identifiers`.
export interface DittoScanEnclosingContext {
  parentRole: DittoScanDetectionKind;
  identifiers: string[];
}

// One occurrence of the candidate string somewhere else in the codebase. Used
// when the literal is declared as a constant and referenced from elsewhere, so
// the LLM can see how it's actually used. Not populated by the current extract
// pass; reserved for a future constant-reference resolver.
export const DittoScanUsageEvidenceSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  excerpt: z.string(),
});
export type DittoScanUsageEvidence = z.infer<typeof DittoScanUsageEvidenceSchema>;

// A single string literal found in the source, with some context to help the
// LLM decide whether it's user-facing.
export const DittoScanCandidateSchema = z.object({
  id: z.string(),
  value_raw: z.string(),
  detection_kind: DittoScanDetectionKindSchema,
  location: z.object({
    file: z.string(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  }),
  occurrence_index: z.number().int().nonnegative(),
  snapshot_text: z.string(),
  language: z.string(),
  // Locale key derived from the file's path when the candidate comes from a
  // per-locale i18n resource file admitted by i18n file discovery (e.g. "en"
  // for locales/en/common.json, "de-DE" for messages.de-DE.json). Null for
  // source-code candidates and i18n files with no locale token in their path.
  locale_key: z.string().nullable(),
  // The string's lookup key within its localization resource file, as
  // written in the file: the dot-joined key path for JSON/YAML catalogs
  // ("labels.paste", "item_one"), the property key, the PO msgid, the
  // XLIFF unit id, the resource name for Android/.resx, the catalog key
  // for iOS .strings/.stringsdict/.xcstrings. Null for source-code
  // candidates and resource hits where no key could be recovered.
  i18n_key: z.string().nullable(),
  // Framework signals derived from the input project's package.json
  // (e.g., ["react", "next"] or ["vue"]). Same for every candidate in a run.
  framework: z.array(z.string()),
  // N surrounding lines with `line: ` prefixes.
  source_context: z.string(),
  context_identifiers: z.array(z.string()),
  usage_evidence: z.array(DittoScanUsageEvidenceSchema).nullable().optional(),
  // The extractor's view of the wrapping construct (DIT-13628).
  // The source between the end of this hit and the start of the next hit in
  // the same file, when they are close: at most GAP_TO_NEXT_MAX characters
  // and no blank line. The server asks whether the two read as one piece of
  // copy and renders the joined value from the spans. Null otherwise.
  gap_to_next: z.string().nullable(),
});
export type DittoScanCandidate = z.infer<typeof DittoScanCandidateSchema>;
