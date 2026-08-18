import type { ExtractedHit, LanguageExtractor } from "../types";
import { computeLineOffsets } from "./util";

/**
 * Java `.properties` resource bundles (messages_en.properties, labels.properties, …).
 *
 * Format: each logical line is `KEY<sep>VALUE` where `<sep>` is `=`, `:`, or
 * unescaped whitespace. Lines starting with `#` or `!` are comments. A value
 * continues onto the next physical line when the previous one ends with an
 * unescaped trailing `\`.
 *
 * The walker only dispatches this extractor on files the LLM has confirmed
 * as i18n (i.e. not Spring/log4j config), so every key-value pair emits a
 * `resource_value` hit. Escapes (`\n`, `\\`, `\uXXXX`, …) are kept verbatim
 * in the value — same approach as the iOS .strings extractor.
 */
export const propertiesExtractor: LanguageExtractor = {
  async extract({ source }) {
    const out: ExtractedHit[] = [];
    const lines = source.split(/\r?\n/);
    const lineOffsets = computeLineOffsets(source);
    let i = 0;
    while (i < lines.length) {
      const startIdx = i;
      const first = lines[i];
      const stripped = stripLeadingWs(first);
      if (stripped === "" || stripped.startsWith("#") || stripped.startsWith("!")) {
        i++;
        continue;
      }

      const segments: Segment[] = [
        { lineIdx: startIdx, indent: first.length - stripped.length, text: stripped },
      ];
      let logical = stripped;
      i++;
      while (endsWithContinuation(logical) && i < lines.length) {
        const continued = stripLeadingWs(lines[i]);
        const last = segments[segments.length - 1];
        last.text = last.text.slice(0, -1);
        segments.push({ lineIdx: i, indent: lines[i].length - continued.length, text: continued });
        logical = logical.slice(0, -1) + continued;
        i++;
      }
      const lastIdx = i - 1;

      const parsed = splitKeyValue(logical);
      if (!parsed) continue;
      const { key, value, valueStart } = parsed;
      if (value.trim().length === 0) continue;

      const keyColumn = segments[0].indent + 1;
      const spanStart = offsetOfLogicalIndex(segments, lineOffsets, valueStart);
      out.push({
        value,
        location: { line: startIdx + 1, column: keyColumn },
        snapshotText: source.slice(spanStart, lineOffsets[lastIdx] + lines[lastIdx].length),
        context: { parentRole: "resource_value", identifiers: [key] },
        i18nKey: key,
      });
    }
    return out;
  },
};

interface Segment {
  lineIdx: number;
  indent: number;
  text: string;
}

// Maps an index into the assembled logical line back to its absolute offset in
// the source, so a value whose key was itself continued still spans only the
// value.
function offsetOfLogicalIndex(segments: Segment[], lineOffsets: number[], index: number): number {
  let remaining = index;
  for (const seg of segments) {
    if (remaining < seg.text.length) return lineOffsets[seg.lineIdx] + seg.indent + remaining;
    remaining -= seg.text.length;
  }
  const last = segments[segments.length - 1];
  return lineOffsets[last.lineIdx] + last.indent + last.text.length;
}

function stripLeadingWs(line: string): string {
  let i = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 32 || ch === 9 || ch === 12) i++;
    else break;
  }
  return line.slice(i);
}

function endsWithContinuation(line: string): boolean {
  let backslashes = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] === "\\") backslashes++;
    else break;
  }
  return backslashes % 2 === 1;
}

// Splits at the first unescaped `=`, `:`, or whitespace. Flanking
// whitespace and an optional `=`/`:` are dropped per the spec.
function splitKeyValue(line: string): { key: string; value: string; valueStart: number } | null {
  let i = 0;
  let key = "";
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      key += ch + line[i + 1];
      i += 2;
      continue;
    }
    if (ch === "=" || ch === ":" || ch === " " || ch === "\t" || ch === "\f") break;
    key += ch;
    i++;
  }
  if (key === "") return null;
  while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === "\f")) i++;
  if (i < line.length && (line[i] === "=" || line[i] === ":")) i++;
  while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === "\f")) i++;
  return { key, value: line.slice(i), valueStart: i };
}
