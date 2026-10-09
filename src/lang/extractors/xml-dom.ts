import { INITIAL, type IToken, type StateStack } from "vscode-textmate";

import { loadGrammar } from "./grammar";
import { computeLineOffsets } from "./util";

/**
 * XML tree for the resource-file extractors. The tree is built from the
 * tokens of the TextMate XML grammar, so every format in this package goes
 * through the same tokenizer. The node shape is the one the walkers read:
 *
 *   element
 *     start_tag | self_closing_tag
 *       tag_name
 *       attribute
 *         attribute_name
 *         quoted_attribute_value
 *           attribute_value
 *     text | cdata | comment | element ...
 *     end_tag
 *
 * A CDATA section is its own node. The raw span of an element with CDATA
 * has the `<![CDATA[` marker, and `innerText` leaves that element to the
 * CDATA sweep.
 *
 * The parser is tolerant. A stray `</x>` with no open `<x>` is ignored. The
 * end of input closes every open node. Resource files are machine written,
 * so this is a floor, not a validator.
 */

type Kind =
  | "document"
  | "element"
  | "start_tag"
  | "self_closing_tag"
  | "end_tag"
  | "tag_name"
  | "attribute"
  | "attribute_name"
  | "quoted_attribute_value"
  | "attribute_value"
  | "text"
  | "cdata"
  | "comment";

interface Pos {
  index: number;
  line: number; // 0-based
  column: number; // 0-based
}

export class XmlNode {
  private readonly _children: XmlNode[] = [];
  private _parent: XmlNode | null = null;
  private _end = -1;

  constructor(
    private _kind: Kind,
    private readonly _source: string,
    private readonly _start: number,
    private readonly _lineStarts: number[],
  ) {}

  kind(): string {
    return this._kind;
  }
  children(): XmlNode[] {
    return this._children;
  }
  parent(): XmlNode | null {
    return this._parent;
  }
  text(): string {
    return this._source.slice(this._start, this._end);
  }
  range(): { start: Pos; end: Pos } {
    return { start: this.pos(this._start), end: this.pos(this._end) };
  }
  findAll(query: { rule: { kind: string } }): XmlNode[] {
    const out: XmlNode[] = [];
    const walk = (n: XmlNode) => {
      for (const c of n._children) {
        if (c._kind === query.rule.kind) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** @internal */
  add(child: XmlNode): XmlNode {
    child._parent = this;
    this._children.push(child);
    return child;
  }
  /** @internal */
  close(end: number): void {
    this._end = end;
  }
  /** @internal */
  rekind(kind: Kind): void {
    this._kind = kind;
  }

  private pos(index: number): Pos {
    let lo = 0;
    let hi = this._lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { index, line: lo, column: index - this._lineStarts[lo] };
  }
}

const has = (scopes: string[], prefix: string) => scopes.some((s) => s.startsWith(prefix));

export async function parseXml(source: string): Promise<XmlNode> {
  const grammar = await loadGrammar("xml");
  const lineStarts = computeLineOffsets(source);

  const node = (kind: Kind, start: number) => new XmlNode(kind, source, start, lineStarts);
  const root = node("document", 0);
  const open: XmlNode[] = [root];
  const top = () => open[open.length - 1];

  // Builder state.
  let tag: XmlNode | null = null; // the open start_tag or end_tag
  let element: XmlNode | null = null; // the element of `tag`
  let closing = false;
  let attr: XmlNode | null = null;
  let quoted: XmlNode | null = null;
  let skipping = false; // inside `<?xml ...?>` or `<!DOCTYPE ...>`
  let text: XmlNode | null = null;
  let span: XmlNode | null = null; // open comment or cdata node

  const endText = () => {
    text = null;
  };
  const closeOpenElementsTo = (name: string, at: number): XmlNode | null => {
    let depth = open.length - 1;
    while (depth > 0 && elementName(open[depth]) !== name) depth--;
    if (depth === 0) return null;
    while (open.length - 1 > depth) open.pop()!.close(at);
    return open.pop()!;
  };

  let stack: StateStack | null = INITIAL;
  let lineOffset = 0;
  const lines = source.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const res = grammar.tokenizeLine(line, stack);
    stack = res.ruleStack;
    for (const t of res.tokens as IToken[]) {
      const s = t.scopes;
      const start = lineOffset + t.startIndex;
      const end = lineOffset + t.endIndex;
      const txt = line.slice(t.startIndex, t.endIndex);

      // A comment or CDATA section is one node, from opener to closer.
      const spanKind: Kind | null = has(s, "comment.") ? "comment" : has(s, "string.unquoted.cdata") ? "cdata" : null;
      if (spanKind) {
        endText();
        if (!span) span = top().add(node(spanKind, start));
        span.close(end);
        continue;
      }
      span = null;

      if (skipping) {
        if (has(s, "punctuation.definition.tag") && (txt === "?>" || txt === ">")) skipping = false;
        continue;
      }
      if (has(s, "meta.tag.preprocessor") || has(s, "meta.tag.sgml")) {
        endText();
        skipping = !has(s, "punctuation.definition.tag") || !(txt === "?>" || txt === ">");
        continue;
      }

      if (has(s, "punctuation.definition.tag")) {
        endText();
        if (txt === "<" || txt === "</") {
          closing = txt === "</";
          if (closing) {
            tag = node("end_tag", start);
            element = null;
          } else {
            element = top().add(node("element", start));
            tag = element.add(node("start_tag", start));
          }
        } else if (tag) {
          // `>` or `/>`
          if (attr) attr.close(start);
          attr = null;
          quoted = null;
          tag.close(end);
          if (closing) {
            const name = elementName(tag);
            const el = name ? closeOpenElementsTo(name, start) : null;
            if (el) {
              el.add(tag);
              el.close(end);
            }
          } else if (element) {
            if (txt === "/>") {
              tag.rekind("self_closing_tag");
              element.close(end);
            } else {
              open.push(element);
            }
          }
          tag = null;
          element = null;
        }
        continue;
      }

      if (tag) {
        if (has(s, "entity.name.tag")) {
          tag.add(node("tag_name", start)).close(end);
        } else if (has(s, "entity.other.attribute-name")) {
          if (attr) attr.close(start);
          // The name token includes the leading whitespace.
          const lead = txt.length - txt.trimStart().length;
          attr = tag.add(node("attribute", start + lead));
          attr.add(node("attribute_name", start + lead)).close(end);
        } else if (attr && has(s, "string.")) {
          if (has(s, "punctuation.definition.string.begin")) {
            quoted = attr.add(node("quoted_attribute_value", start));
            quoted.add(node("attribute_value", end));
          } else if (has(s, "punctuation.definition.string.end")) {
            if (quoted) {
              quoted.children()[0]?.close(start);
              quoted.close(end);
              attr.close(end);
            }
            quoted = null;
            attr = null;
          } else if (quoted) {
            quoted.children()[0]?.close(end);
          }
        }
        continue;
      }

      // Text, entities and whitespace between tags.
      if (!text) text = top().add(node("text", start));
      text.close(end);
    }
    // The newline is part of the open text or span node.
    lineOffset += line.length + 1;
    if (li < lines.length - 1) {
      if (text) text.close(lineOffset);
      if (span) span.close(lineOffset);
    }
  }
  if (tag) tag.close(source.length);
  while (open.length > 1) open.pop()!.close(source.length);
  root.close(source.length);
  return root;
}

function elementName(el: XmlNode): string | null {
  const start = el.kind() === "element" ? el.children()[0] : el;
  return start?.children().find((c) => c.kind() === "tag_name")?.text() ?? null;
}
