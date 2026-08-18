import type { ExtractedHit, LanguageExtractor } from "../types";
import { computeLineOffsets } from "./util";

// Gettext `.po` files (Lingui, GNU gettext, Django, Crowdin, …).
//
// PO uses `msgid` as both the lookup key and the source-language text;
// `msgstr` holds the locale-specific translation. We emit:
//   value_raw            msgstr if non-empty, else msgid
//   context_identifiers  [msgctxt?, msgid, plural_tag?]
// Putting msgid in identifiers collapses the same logical entry across
// locale files when downstream groups by identifiers.
//
// Plural entries (msgid + msgid_plural) emit one candidate per plural
// index, tagged `plural:<idx>` (0 = singular, 1 = plural, additional
// indexes for languages with more forms). The empty `msgid ""` header
// is skipped.
export const poExtractor: LanguageExtractor = {
  async extract({ source }) {
    const lines = source.split(/\r?\n/);
    const lineOffsets = computeLineOffsets(source);
    const out: ExtractedHit[] = [];

    let entry: PoEntry | null = null;
    const flush = () => {
      if (entry) emit(entry, out);
      entry = null;
    };

    let i = 0;
    while (i < lines.length) {
      const rawLine = lines[i];
      const line = rawLine.trim();

      if (line === "") {
        flush();
        i++;
        continue;
      }

      // PO comments (`#`, `#.`, `#:`, `#,`, `#|`).
      if (line.startsWith("#")) {
        i++;
        continue;
      }

      const keyword = matchKeyword(line);
      if (!keyword) {
        i++;
        continue;
      }

      if (!entry) entry = {};

      // PO strings may continue on adjacent double-quoted lines.
      const initial = parsePoString(line.slice(keyword.consumed));
      let acc = initial ?? "";
      const startLine = i + 1; // 1-based
      let lastLineIdx = i;
      let j = i + 1;
      while (j < lines.length) {
        const nextTrim = lines[j].trim();
        if (!nextTrim.startsWith('"')) break;
        const continued = parsePoString(nextTrim);
        if (continued === null) break;
        acc += continued;
        lastLineIdx = j;
        j++;
      }
      i = j;

      const chunk: PoChunk = {
        value: acc,
        line: startLine,
        snapshot: quotedSpan(source, lines, lineOffsets, startLine - 1, lastLineIdx),
      };

      switch (keyword.kind) {
        case "msgctxt":
          entry.msgctxt = chunk;
          break;
        case "msgid":
          entry.msgid = chunk;
          break;
        case "msgid_plural":
          entry.msgidPlural = chunk;
          break;
        case "msgstr":
          entry.msgstr = chunk;
          break;
        case "msgstr_indexed":
          if (!entry.msgstrPlural) entry.msgstrPlural = new Map();
          entry.msgstrPlural.set(keyword.index ?? 0, chunk);
          break;
      }
    }
    flush();

    return out;
  },
};

// One `msgid`/`msgstr`/… string, plus where it sits in the file. `snapshot`
// is the contiguous source region the string was stitched from: the first
// quote of the chunk group through the last quote of its final line.
interface PoChunk {
  value: string;
  line: number;
  snapshot: string;
}

interface PoEntry {
  msgctxt?: PoChunk;
  msgid?: PoChunk;
  msgidPlural?: PoChunk;
  msgstr?: PoChunk;
  msgstrPlural?: Map<number, PoChunk>;
}

function emit(entry: PoEntry, out: ExtractedHit[]): void {
  // Skip header entry (`msgid ""`).
  if (entry.msgid === undefined || entry.msgid.value === "") return;
  const msgid = entry.msgid;

  const ctxtIds = entry.msgctxt ? [entry.msgctxt.value] : [];

  if (entry.msgidPlural !== undefined) {
    const plural = entry.msgstrPlural ?? new Map<number, PoChunk>();
    // Always consider indexes 0 (singular) and 1 (plural) even when no
    // translation is present, so the source msgid/msgidPlural still
    // surface in base-locale catalogs.
    const indexes = new Set<number>([0, 1, ...plural.keys()]);
    for (const idx of [...indexes].sort((a, b) => a - b)) {
      const source = idx === 0 ? msgid : entry.msgidPlural;
      if (source === undefined) continue;
      const chunk = pickNonEmpty(plural.get(idx), source);
      if (chunk === null) continue;
      out.push({
        value: chunk.value,
        location: { line: chunk.line, column: 1 },
        snapshotText: chunk.snapshot,
        context: { parentRole: "resource_value", identifiers: [...ctxtIds, msgid.value, `plural:${idx}`] },
        // msgid is gettext's lookup key; msgctxt stays in identifiers only.
        i18nKey: msgid.value,
      });
    }
    return;
  }

  const chunk = pickNonEmpty(entry.msgstr, msgid);
  if (chunk === null) return;
  out.push({
    value: chunk.value,
    location: { line: chunk.line, column: 1 },
    snapshotText: chunk.snapshot,
    context: { parentRole: "resource_value", identifiers: [...ctxtIds, msgid.value] },
    i18nKey: msgid.value,
  });
}

function pickNonEmpty(translated: PoChunk | undefined, source: PoChunk): PoChunk | null {
  if (translated !== undefined && translated.value.trim().length > 0) return translated;
  if (source.value.trim().length > 0) return source;
  return null;
}

// First quote of `firstIdx` through the last quote of `lastIdx`, read out of
// the original source so the region round-trips through `source.includes()`.
function quotedSpan(
  source: string,
  lines: string[],
  lineOffsets: number[],
  firstIdx: number,
  lastIdx: number
): string {
  const openQuote = lines[firstIdx].indexOf('"');
  const closeQuote = lines[lastIdx].lastIndexOf('"');
  if (openQuote === -1 || closeQuote === -1) return "";
  return source.slice(lineOffsets[firstIdx] + openQuote, lineOffsets[lastIdx] + closeQuote + 1);
}

interface KeywordMatch {
  kind: "msgctxt" | "msgid" | "msgid_plural" | "msgstr" | "msgstr_indexed";
  consumed: number;
  index?: number;
}

// Longest-prefix-first so `msgid_plural` doesn't match as `msgid` and
// `msgstr[N]` doesn't match as plain `msgstr`.
const KEYWORD_RE = /^(msgctxt|msgid_plural|msgid|msgstr\[(\d+)\]|msgstr)\s+/;

function matchKeyword(line: string): KeywordMatch | null {
  const m = KEYWORD_RE.exec(line);
  if (!m) return null;
  const raw = m[1];
  if (raw === "msgctxt") return { kind: "msgctxt", consumed: m[0].length };
  if (raw === "msgid_plural") return { kind: "msgid_plural", consumed: m[0].length };
  if (raw === "msgid") return { kind: "msgid", consumed: m[0].length };
  if (raw === "msgstr") return { kind: "msgstr", consumed: m[0].length };
  return { kind: "msgstr_indexed", consumed: m[0].length, index: Number(m[2]) };
}

// Returns null if the input isn't a complete double-quoted PO string.
function parsePoString(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith('"')) return null;
  let value = "";
  let i = 1;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "\\") {
      const next = trimmed[i + 1];
      i += 2;
      switch (next) {
        case "n":
          value += "\n";
          break;
        case "t":
          value += "\t";
          break;
        case "r":
          value += "\r";
          break;
        case "\\":
          value += "\\";
          break;
        case '"':
          value += '"';
          break;
        case "0":
          value += "\0";
          break;
        default:
          value += next ?? "";
      }
      continue;
    }
    if (ch === '"') return value;
    value += ch;
    i++;
  }
  return null;
}
