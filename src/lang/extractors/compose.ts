import type { ExtractedHit, HitPiece } from "../types";
import { decodeEscapes } from "./util";

/**
 * Composer: turns adjacent fragments into the copy a reader sees, with the
 * holes rendered as `{{name}}` placeholders. Deterministic; no model.
 *
 * Two kinds of cluster are composed:
 *
 *   1. Markup text split by inline elements and expression holes.
 *        Read the terms on{" "}<Anchor>GitHub</Anchor>.   -> "Read the terms on GitHub."
 *        <p>Hello {name}, you have {count} items</p>    -> "Hello {{name}}, you have {{count}} items"
 *      Fragments join only while the text reads as one sentence: the left
 *      side does not end a sentence, or the right side continues in lower case.
 *
 *   2. String literals concatenated with `+` (or PHP `.`), with optional
 *      expression operands between or around them.
 *        "Hello " + name + ", welcome"                   -> "Hello {{name}}, welcome"
 *
 * The composed hit keeps `snapshotText` as the verbatim span from the first
 * piece to the last, and lists every piece with its own location in `pieces`,
 * so write-back can regenerate the expression and nothing loses its span.
 * A hit that is not part of a cluster passes through untouched.
 */

const SENTENCE_END = /[.!?:]\s*$/;
// A block element boundary in the glue means two separate nodes.
const BLOCK_TAG =
  /<\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|thead|tbody|table|section|article|header|footer|nav|label|button|option|form|blockquote|pre|dd|dt|dl|figcaption|br|hr|Text|Title|Button|Badge|Table\.[A-Za-z]+|Accordion\.[A-Za-z]+)\b/;
const STARTS_LOWER = /^\s*[a-z]/;
// `{% %}` and `{# #}` are template blocks, not holes.
const GAP_MARKUP = /^(?:\s|<\/?[A-Za-z][^<>]*>|\{\{[^{}]*\}\}|\{(?![%#])[^{}]*\})*$/;
// `+ expr +`, `+`, or PHP `. expr .`; expressions are identifiers, member
// chains, calls with simple args, or index access.
const EXPR = String.raw`[A-Za-z_$][\w$]*(?:(?:\?\.|\.|->|::)[A-Za-z_$][\w$]*)*(?:\([^()]*\))?(?:\[[^\]]*\])?`;
const GAP_CONCAT = new RegExp(String.raw`^\s*([+.])\s*(?:(${EXPR})\s*\1\s*)?$`);
const TRAILING_EXPR = new RegExp(String.raw`^\s*([+.])\s*(${EXPR})\s*(?=[;,)\]}]|$|\n)`);
const LEADING_EXPR = new RegExp(String.raw`(${EXPR})\s*([+.])\s*$`);

type Offsets = { lineStarts: number[] };

function offsets(source: string): Offsets {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  return { lineStarts };
}
const toOffset = (o: Offsets, line: number, column: number) => o.lineStarts[line - 1] + column - 1;
function toLineCol(o: Offsets, offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = o.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (o.lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - o.lineStarts[lo] + 1 };
}

/** `user.firstName` -> firstName, `items.length` -> length, `t("k")` -> t, `x|title` -> x. */
export function placeholderName(expr: string, taken: Set<string>): string {
  let e = expr.trim().replace(/\|.*$/, "").replace(/\([^()]*\)\s*$/, "").replace(/\[[^\]]*\]\s*$/, "");
  const segments = e.split(/\?\.|\.|->|::/).filter(Boolean);
  let name = (segments[segments.length - 1] ?? "").replace(/^[$@]+/, "");
  if (!/^[A-Za-z_][\w]*$/.test(name)) name = "value";
  let unique = name;
  for (let i = 2; taken.has(unique); i++) unique = `${name}${i}`;
  taken.add(unique);
  return unique;
}

/** Render the holes of one markup text node: `{" "}` inlines, `{expr}` becomes `{{name}}`. */
function renderMarkupText(text: string, taken: Set<string>, pieces: HitPiece[], at: (i: number) => { line: number; column: number }) {
  const HOLE = /\{\{([^{}]*)\}\}|\{(?![%#])([^{}]*)\}/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  const pushLiteral = (from: number, to: number) => {
    if (to <= from) return;
    const lit = text.slice(from, to);
    out += lit;
    pieces.push({ kind: "literal", text: lit, ...at(from) });
  };
  while ((m = HOLE.exec(text)) !== null) {
    pushLiteral(last, m.index);
    const inner = (m[1] ?? m[2] ?? "").trim();
    const lit = /^(["'`])([\s\S]*)\1$/.exec(inner);
    if (lit) {
      out += lit[2];
      pieces.push({ kind: "literal", text: lit[2], ...at(m.index) });
    } else {
      const name = placeholderName(inner, taken);
      out += `{{${name}}}`;
      pieces.push({ kind: "placeholder", text: m[0], name, ...at(m.index) });
    }
    last = m.index + m[0].length;
  }
  pushLiteral(last, text.length);
  return out;
}

// JSX and HTML collapse whitespace runs that contain a newline to one space.
const collapse = (s: string) => s.replace(/\s*\n\s*/g, " ");

export function composeHits(hits: ExtractedHit[], source: string): ExtractedHit[] {
  const o = offsets(source);
  const sorted = [...hits].sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
  const consumed = new Set<number>();
  const out: ExtractedHit[] = [];
  const startOf = (h: ExtractedHit) => toOffset(o, h.location.line, h.location.column);
  const endOf = (h: ExtractedHit) => startOf(h) + h.snapshotText.length;

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(i)) continue;
    const first = sorted[i];
    const kind = first.context.parentRole;
    if (kind !== "markup_text" && kind !== "other") {
      out.push(first);
      continue;
    }
    // Grow the cluster while the gap to the next hit of the same kind is
    // glue. Hits of another kind inside the gap (a `{" "}` literal, an
    // attribute value in an inline tag) are left alone and stay in the output.
    const cluster = [first];
    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(j)) continue;
      const next = sorted[j];
      if (next.context.parentRole !== kind) {
        if (kind === "markup_text") continue;
        break;
      }
      const prev = cluster[cluster.length - 1];
      const gapFrom = endOf(prev);
      const gapTo = startOf(next);
      if (gapTo < gapFrom) break;
      const gap = source.slice(gapFrom, gapTo);
      const joins =
        kind === "markup_text"
          ? GAP_MARKUP.test(gap) && !BLOCK_TAG.test(gap) && (!SENTENCE_END.test(prev.value) || STARTS_LOWER.test(next.value))
          : GAP_CONCAT.test(gap);
      if (!joins) break;
      cluster.push(next);
      consumed.add(j);
    }

    const start = startOf(first);
    let end = endOf(cluster[cluster.length - 1]);
    const taken = new Set<string>();
    const pieces: HitPiece[] = [];
    let value = "";

    if (kind === "markup_text") {
      for (const [k, hit] of cluster.entries()) {
        const base = startOf(hit);
        if (k > 0) {
          // Glue between fragments: inline tags vanish, holes render.
          const gapFrom = endOf(cluster[k - 1]);
          const gap = source.slice(gapFrom, base).replace(/<\/?[A-Za-z][^<>]*>/g, "");
          value += renderMarkupText(gap, taken, pieces, (idx) => toLineCol(o, gapFrom + idx));
        }
        value += renderMarkupText(hit.snapshotText, taken, pieces, (idx) => toLineCol(o, base + idx));
      }
      out.push({ ...first, value: collapse(value).trim(), snapshotText: source.slice(start, end), pieces });
      continue;
    }

    // Code concatenation. Leading operand: `name + "x"`.
    let composedStart = start;
    const before = source.slice(Math.max(0, start - 200), start);
    const lead = LEADING_EXPR.exec(before);
    if (lead) {
      composedStart = start - lead[0].length;
      const name = placeholderName(lead[1], taken);
      value += `{{${name}}}`;
      pieces.push({ kind: "placeholder", text: lead[1], name, ...toLineCol(o, composedStart) });
    }
    for (const [k, hit] of cluster.entries()) {
      if (k > 0) {
        const gapFrom = endOf(cluster[k - 1]);
        const gap = source.slice(gapFrom, startOf(hit));
        const m = GAP_CONCAT.exec(gap);
        if (m?.[2]) {
          const name = placeholderName(m[2], taken);
          value += `{{${name}}}`;
          pieces.push({ kind: "placeholder", text: m[2], name, ...toLineCol(o, gapFrom + gap.indexOf(m[2])) });
        }
      }
      const lit = literalContent(hit.snapshotText);
      value += lit;
      pieces.push({ kind: "literal", text: lit, ...hit.location });
    }
    // Trailing operand: `"x" + name;`
    const after = source.slice(end, end + 200);
    const trail = TRAILING_EXPR.exec(after);
    if (trail) {
      const name = placeholderName(trail[2], taken);
      value += `{{${name}}}`;
      pieces.push({ kind: "placeholder", text: trail[2], name, ...toLineCol(o, end + after.indexOf(trail[2])) });
      end += trail[0].length;
    }
    if (cluster.length === 1 && !lead && !trail) {
      out.push(first);
      continue;
    }
    out.push({ ...first, value, snapshotText: source.slice(composedStart, end), location: toLineCol(o, composedStart), pieces });
  }
  return out.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
}

/** The decoded content of one quoted literal, delimiters and prefix removed. */
function literalContent(raw: string): string {
  const m = /^[A-Za-z@$]{0,2}(["'`])([\s\S]*)\1$/.exec(raw);
  if (!m) return raw;
  return /^(?:"""|#+"|@"|[rR]["'])/.test(raw) ? m[2] : decodeEscapes(m[2]);
}
