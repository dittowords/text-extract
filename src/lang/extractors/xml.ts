import { type SgNode } from "@ast-grep/napi";

import type { ExtractedHit } from "../types";

const CDATA_MARKER = "<![CDATA[";

export function tagName(element: SgNode): string | null {
  const start = element.children().find((c) => c.kind() === "start_tag");
  return (
    start
      ?.children()
      .find((c) => c.kind() === "tag_name")
      ?.text() ?? null
  );
}

export function elementAttribute(element: SgNode, name: string): string | null {
  const start = element.children().find((c) => c.kind() === "start_tag");
  if (!start) return null;
  for (const attr of start.children()) {
    if (attr.kind() !== "attribute") continue;
    const nameNode = attr.children().find((c) => c.kind() === "attribute_name");
    if (nameNode?.text() !== name) continue;
    const quoted = attr.children().find((c) => c.kind() === "quoted_attribute_value");
    const value = quoted
      ?.children()
      .find((c) => c.kind() === "attribute_value")
      ?.text();
    if (value !== undefined) return value;
    return (
      attr
        .children()
        .find((c) => c.kind() === "attribute_value")
        ?.text() ?? null
    );
  }
  return null;
}

// Emit a `resource_value` hit from all of `element`'s inner text. No-op when
// the element has no inner text, the text is whitespace-only, or the
// element contains a CDATA section (handled by `findCdataElements`). The
// HTML grammar parses CDATA inconsistently when its body looks like markup
// — `<![CDATA[Hi <b>x</b>]]>` can surface `]]` as a stray text node.
// Skipping any element whose source range contains `<![CDATA[` is simpler
// and matches the CDATA sweep, which recovers the real value.
// `transformValue` is per-format: Android processes escapes and printf specifiers
// inside a value; .resx and XLIFF don't, and pass nothing.
export function emitTextHit(
  element: SgNode,
  identifiers: string[],
  out: ExtractedHit[],
  source?: string,
  i18nKey?: string,
  transformValue?: (value: string) => string,
): void {
  if (source !== undefined && elementContainsCdata(element, source)) return;
  const inner = innerText(element, source);
  // A recovered span can reach past the point the grammar stopped at, so the
  // range check above may have missed a CDATA section that's now in view.
  if (!inner || inner.value.length === 0 || inner.raw.includes(CDATA_MARKER)) return;
  const { value, raw, line, column } = inner;
  out.push({
    value: transformValue ? transformValue(value) : value,
    location: { line, column },
    // The contiguous source region the value came from — nested markup
    // (`<b>`, `<xliff:g>`) and entities included. Whether that region can be
    // written over is a write-path concern, not an extraction one.
    snapshotText: raw,
    context: { parentRole: "resource_value", identifiers },
    i18nKey,
  });
}

// All of an element's inner text, with nested markup (`<xliff:g>`, `<b>`) stripped.
// Reads the source span: the grammar drops the whitespace next to a nested tag.
//
// With `source`, an element the grammar left without an `end_tag` is recovered
// by finding its closing tag in the text. HTML void elements (`<source>`,
// notably, which XLIFF uses for the original copy) can't hold children, so the
// grammar closes them at the first nested tag, promotes that tag to a sibling
// and demotes the real `</source>` to an `erroneous_end_tag`.
export function innerText(
  element: SgNode,
  source?: string,
): { value: string; raw: string; line: number; column: number } | null {
  const children = element.children();
  const start = children.find((c) => c.kind() === "start_tag");
  if (!start) return null;
  const from = start.range().end.index;
  const end = children.find((c) => c.kind() === "end_tag");
  const to = end
    ? end.range().start.index
    : source === undefined
    ? -1
    : findClosingTag(source, tagName(element), from);
  if (to === -1) return null;
  const offset = element.range().start.index;
  const raw =
    source === undefined
      ? element.text().slice(from - offset, to - offset)
      : source.slice(from, to);
  const { line, column } = start.range().end;
  return {
    value: decodeXmlEntities(raw.replace(/<[^>]*>/g, "")).trim(),
    raw,
    line: line + 1,
    column: column + 1,
  };
}

/**
 * Offset of the first `</tag>` at or after `from`, or -1 when there is none.
 * Used to recover an element the grammar left unclosed, where the tree offers
 * no `end_tag` to read the span's end from.
 *
 * The first match is the right one: the XML formats here don't nest an element
 * inside another of the same name, so no depth tracking is needed. A `tag` of
 * `null` — an element whose name the tree didn't give us — finds nothing.
 */
function findClosingTag(source: string, tag: string | null, from: number): number {
  if (!tag) return -1;
  const at = source.slice(from).search(new RegExp(`</${escapeRegex(tag)}\\s*>`));
  return at === -1 ? -1 : from + at;
}

// `&amp;` resolves last, so an escaped entity like `&amp;lt;` stays `&lt;`.
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function elementContainsCdata(element: SgNode, source: string): boolean {
  const range = element.range();
  const idx = source.indexOf(CDATA_MARKER, range.start.index);
  return idx !== -1 && idx < range.end.index;
}

export interface CdataMatch {
  tag: string;
  attrsRaw: string;
  value: string;
  // Offset of the matched outer tag, e.g. `<source ...><![CDATA[...]]></source>`.
  offset: number;
  // Offset of the CDATA payload itself (the char after `<![CDATA[`). Use this
  // for hit locations so they point at the extracted text rather than the tag.
  valueOffset: number;
}

// ast-grep's HTML grammar drops CDATA text nodes silently, so an AST walk
// over `<value><![CDATA[...]]></value>` sees no text child at all. This
// regex sweep recovers those by name. The AST pass never captures CDATA in
// the first place, so there's no overlap — no dedup needed.
export function findCdataElements(source: string, tagNames: readonly string[]): CdataMatch[] {
  if (tagNames.length === 0) return [];
  const alt = tagNames.map(escapeRegex).join("|");
  const re = new RegExp(`<(${alt})\\b([^>]*)>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</\\1>`, "g");
  const out: CdataMatch[] = [];
  for (const m of source.matchAll(re)) {
    if (m[3] === "") continue;
    const offset = m.index ?? 0;
    // Hop past `<tag attrs>` and any whitespace to find the `<![CDATA[` opener.
    const cdataPos = m[0].indexOf(CDATA_MARKER);
    const valueOffset = cdataPos === -1 ? offset : offset + cdataPos + CDATA_MARKER.length;
    out.push({ tag: m[1], attrsRaw: m[2], value: m[3], offset, valueOffset });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
