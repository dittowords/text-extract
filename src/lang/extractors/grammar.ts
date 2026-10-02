import fs from "fs";
import path from "path";

import { loadWASM, createOnigScanner, createOnigString } from "vscode-oniguruma";
import { INITIAL, Registry, type IGrammar, type IToken, type StateStack } from "vscode-textmate";

import type { DittoScanEnclosingContext } from "../../types";
import type { ExtractedHit, LanguageExtractor } from "../types";
import { composeHits } from "./compose";
import { decodeEscapes } from "./util";

/**
 * Grammar-driven string finder. One extractor covers every language that
 * `tm-grammars` ships a grammar for (the grammars VS Code and shiki use), so
 * a new client language is a row in the registry, not a new file.
 *
 * A grammar labels spans with scopes such as `string.quoted.double`,
 * `comment.line`, `meta.embedded` or `meta.jsx.children`. It does not say
 * where a string ends, which tag a text node is in, or which call an
 * argument belongs to. This file is that structure layer:
 *   - a run of string-scoped tokens is one literal, interpolation holes included
 *   - a run of text-scoped tokens between tags is one markup text node, holes included
 *   - a string under an attribute scope is `markup_attr`
 *   - the identifier tokens before the enclosing `(` give `callee`/`calleeMember`/`methodName`
 *
 * Scope names are a convention, not a spec, so the per-grammar variations
 * live in the tables under "Scope tables". Everything the grammar cannot
 * state (is this `===` operand a tag? is this a dictionary key?) is left to
 * the classifier.
 *
 * Value convention: a code literal keeps its delimiters with escapes
 * decoded, a raw string is left alone, an HTML attribute value is bare, and
 * markup text is composed by `compose.ts`.
 */

// ---------------------------------------------------------------------------
// Grammar loading
// ---------------------------------------------------------------------------

const GRAMMAR_DIR = path.dirname(require.resolve("tm-grammars/grammars/python.json"));

let scopeIndex: Map<string, string> | null = null;
function grammarFileForScope(scopeName: string): string | null {
  if (!scopeIndex) {
    scopeIndex = new Map();
    for (const f of fs.readdirSync(GRAMMAR_DIR)) {
      const j = JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, f), "utf8"));
      scopeIndex.set(j.scopeName, f);
    }
  }
  return scopeIndex.get(scopeName) ?? null;
}

let registry: Registry | null = null;
function getRegistry(): Registry {
  if (registry) return registry;
  const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
  const onigLib = loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)).then(() => ({
    createOnigScanner,
    createOnigString,
  }));
  registry = new Registry({
    onigLib,
    async loadGrammar(scopeName) {
      const f = grammarFileForScope(scopeName);
      if (!f) return null;
      return JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, f), "utf8"));
    },
  });
  return registry;
}

const grammarCache = new Map<string, Promise<IGrammar>>();
export function loadGrammar(lang: string): Promise<IGrammar> {
  let p = grammarCache.get(lang);
  if (!p) {
    p = (async () => {
      const raw = JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, `${lang}.json`), "utf8"));
      const g = await getRegistry().loadGrammar(raw.scopeName);
      if (!g) throw new Error(`no grammar for ${lang}`);
      return g;
    })();
    grammarCache.set(lang, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Scope tables. Each entry is a scope prefix; a token matches when any of its
// scopes starts with one. Grammar-specific names are marked.
// ---------------------------------------------------------------------------

const STRING_BODY = [
  "string.",
  "meta.fstring", // python: holes inside an f-string lose `string.`
];
const STRING_PUNCT = [
  "punctuation.definition.string",
  "punctuation.definition.template",
  "storage.type.string", // python `f` / `r` prefix
];
const NOT_STRING = ["string.regexp"];
const HOLE = [
  "meta.embedded",
  "meta.template.expression",
  "meta.interpolation",
  "punctuation.section.embedded",
  "punctuation.definition.template-expression",
  "constant.character.format.placeholder", // python `{}`
  "meta.function.echo", // blade `{{ }}`
  "variable.meta.scope.jinja", // jinja `{{ }}`
];
const HOLE_OPEN = [
  "punctuation.section.embedded.begin",
  "punctuation.definition.template-expression.begin",
  "support.function.construct.begin", // blade
];
const HOLE_CLOSE = [
  "punctuation.section.embedded.end",
  "punctuation.definition.template-expression.end",
  "support.function.construct.end", // blade
];
const HOLE_DELIMITER_BOTH = ["variable.entity.other.jinja.delimiter"]; // jinja: same scope for `{{` and `}}`
const EMBEDDED_BLOCK = ["meta.embedded.block"]; // `<script>` bodies and the like, not holes
const TAG_PUNCT = ["punctuation.definition.tag"];
const TAG_NAME = ["entity.name.tag"];
const ATTR_NAME = ["entity.other.attribute-name"];
const ATTR_LIST = ["meta.tag.attributes", "meta.attribute"]; // `meta.tag` alone also wraps JSX children
const MARKUP_TEXT_LAST = ["meta.jsx.children", "text."]; // the token's innermost scope
const MARKUP_TEXT_ANY = ["constant.character.entity"]; // `&amp;` belongs to the text node
const RAW_STRING = ["string.quoted.raw"];
const RAW_STRING_PREFIX = /^(?:"""|#+"|@"|[rR]["'])/; // kotlin/python, swift, c#, python
const EXCLUDED_ROLE: Array<[string, DittoScanEnclosingContext["parentRole"]]> = [
  ["meta.import", "import"],
  ["meta.type", "type_tag"],
  ["meta.interface", "type_tag"],
];
// Markup elements whose text is code; `parentTag` is withheld inside them.
const CODE_LIKE_TAGS = new Set(["pre", "code", "kbd", "samp", "var", "script", "style"]);
// Vue/Alpine/Angular bindings: the value is an expression, not copy.
const DIRECTIVE_ATTR = /^[:@#]|^v-|^\*|^\[|^\(|^bind-|^on-|^x-/;
// Grammars whose root is a document: text nodes carry copy, attribute values are bare.
const MARKUP_GRAMMARS = new Set(["html", "vue", "svelte", "astro", "blade", "erb", "liquid", "handlebars", "jinja-html", "twig"]);
// Component formats keep their `<script>` code; plain templates do not.
const KEEPS_SCRIPT = new Set(["vue", "svelte", "astro"]);
// A Django or Jinja template usually arrives as `.html`. The Jinja grammar
// knows `{% %}` and `{{ }}`; the plain HTML grammar reads them as text.
const DJANGO_TAG = /\{%[\s\S]*?%\}/;
const grammarFor = (lang: string, source: string) => (lang === "html" && DJANGO_TAG.test(source) ? "jinja-html" : lang);

const anyOf = (scopes: string[], prefixes: string[]) => scopes.some((s) => prefixes.some((p) => s.startsWith(p)));
const firstIndex = (scopes: string[], prefixes: string[]) => scopes.findIndex((s) => prefixes.some((p) => s.startsWith(p)));
const lastIndex = (scopes: string[], prefixes: string[]) => {
  for (let i = scopes.length - 1; i >= 0; i--) if (prefixes.some((p) => scopes[i].startsWith(p))) return i;
  return -1;
};

const isStringBody = (s: string[]) => anyOf(s, STRING_BODY) && !anyOf(s, NOT_STRING);
const isStringPunct = (s: string[]) => anyOf(s, STRING_PUNCT);
const isHole = (s: string[]) => anyOf(s, HOLE);
const isHoleOpen = (s: string[], text: string) =>
  anyOf(s, HOLE_OPEN) || (anyOf(s, HOLE_DELIMITER_BOTH) && text.trim().startsWith("{{"));
const isHoleClose = (s: string[], text: string) =>
  anyOf(s, HOLE_CLOSE) || (anyOf(s, HOLE_DELIMITER_BOTH) && text.trim().endsWith("}}"));
// A hole continues a string only when the grammar nests it inside the string
// scope; a string sits inside a hole when the order is reversed.
const holeInsideString = (s: string[]) => {
  const si = firstIndex(s, STRING_BODY);
  const hi = firstIndex(s, HOLE);
  return si !== -1 && hi !== -1 && si < hi;
};
const stringInsideHole = (s: string[]) => {
  const si = firstIndex(s, STRING_BODY);
  const hi = firstIndex(s, HOLE);
  return si !== -1 && hi !== -1 && hi < si;
};
// An attribute value when the innermost attribute scope is deeper than the
// innermost hole: `<input type="x" />` inside `{cond && (...)}` is still an
// attribute, `style={{ margin: "4px" }}` is code.
const inAttrValue = (s: string[]) => lastIndex(s, ATTR_LIST) > lastIndex(s, HOLE);
const isMarkupText = (s: string[]) =>
  MARKUP_TEXT_LAST.some((p) => s[s.length - 1].startsWith(p)) || anyOf(s, MARKUP_TEXT_ANY);
const isRawString = (s: string[], text: string) => anyOf(s, RAW_STRING) || RAW_STRING_PREFIX.test(text);
const excludedRole = (s: string[]) => EXCLUDED_ROLE.find(([p]) => anyOf(s, [p]))?.[1] ?? null;

// ---------------------------------------------------------------------------
// Tokenizer walk
// ---------------------------------------------------------------------------

type Tok = { text: string; scopes: string[]; line: number; column: number; literal?: boolean };
type CallContext = Pick<DittoScanEnclosingContext, "callee" | "calleeMember" | "methodName">;
type Run = {
  kind: "string" | "text";
  tokens: Tok[];
  context: DittoScanEnclosingContext;
  // HTML attribute values are emitted without quotes; a directive's value is
  // scanned for literals; a bare JSX attribute keeps its backslashes.
  bareAttr?: boolean;
  directive?: boolean;
  jsxAttr?: boolean;
  // A text run whose holes held tokenized string literals.
  hadNested?: boolean;
};

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const WORD_RE = /[A-Za-z_$][\w$]*|[().{]/g;
const QUOTED_LITERAL = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

function stripDelimiters(raw: string): string {
  // `f"..."`, `$"..."`, `@"..."`, `r'...'`, `"""..."""`, `` `...` ``
  const m = /^[A-Za-z@$]{0,2}(["'`])/.exec(raw);
  if (!m) return raw;
  const q = m[1];
  const start = m[0].length - 1;
  const n = raw.startsWith(q.repeat(3), start) && raw.endsWith(q.repeat(3)) && raw.length >= start + 6 ? 3 : 1;
  if (!raw.endsWith(q.repeat(n)) || raw.length < start + 2 * n) return raw;
  return raw.slice(start + n, raw.length - n);
}

export async function extractWithGrammar(source: string, lang: string): Promise<ExtractedHit[]> {
  const grammar = await loadGrammar(grammarFor(lang, source));
  const out: ExtractedHit[] = [];
  const lines = source.split(/\r?\n/);
  const markupGrammar = MARKUP_GRAMMARS.has(lang);

  let stack: StateStack | null = INITIAL;
  let run: Run | null = null;
  // A string literal inside a hole of a markup text run (`{t("x")}`) is
  // emitted on its own as well, so key references are not lost.
  let nested: Run | null = null;
  let pendingNewline = false;
  // Index into `run.tokens` where the current hole began, so a hole that
  // turns out to be nested markup or spans lines can be cut off.
  let holeStart = -1;
  // Rolling buffer of identifiers and `.`/`(`/`{` from code tokens, to
  // recover `receiver.method(` before a string.
  const words: string[] = [];
  const callStack: CallContext[] = [];
  const tagStack: string[] = [];
  let closingTag = false;
  let selfClosing = false;
  let lastAttr: string | null = null;

  const parentTagContext = (): Pick<DittoScanEnclosingContext, "parentTag"> => {
    const parentTag = tagStack[tagStack.length - 1];
    return parentTag && !tagStack.some((t) => CODE_LIKE_TAGS.has(t)) ? { parentTag } : {};
  };
  const pushHit = (value: string, raw: string, first: Tok, context: DittoScanEnclosingContext) => {
    out.push({ value, snapshotText: raw, location: { line: first.line, column: first.column }, context });
  };

  // Literals the grammar does not tokenize: inside a `{{ ... }}` hole of a
  // plain HTML or Vue text node, or inside a directive attribute's expression.
  const emitInnerLiterals = (raw: string, first: Tok, context: DittoScanEnclosingContext, holesOnly: boolean) => {
    const scan = (text: string, offset: number) => {
      QUOTED_LITERAL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = QUOTED_LITERAL.exec(text)) !== null) {
        const at = offset + m.index;
        const before = raw.slice(0, at);
        const nl = before.lastIndexOf("\n");
        const line = first.line + (before.match(/\n/g)?.length ?? 0);
        const column = nl === -1 ? first.column + at : at - nl;
        pushHit(m[2], m[0], { text: m[0], scopes: [], line, column }, { ...context });
      }
    };
    if (!holesOnly) return scan(raw, 0);
    const MUSTACHE = /\{\{([\s\S]*?)\}\}/g;
    let h: RegExpExecArray | null;
    while ((h = MUSTACHE.exec(raw)) !== null) scan(h[1], h.index + 2);
  };

  const emit = (r: Run) => {
    if (r.tokens.length === 0) return;
    const raw = r.tokens.map((t) => t.text).join("");
    const first = r.tokens[0];
    if (r.kind === "text") {
      // Verbatim slice; `compose.ts` renders holes and collapses layout.
      // A node that is only holes (`{count}`) carries no copy of its own,
      // but the literals inside its holes still do.
      if (r.tokens.some((t) => t.literal)) pushHit(raw, raw, first, r.context);
      if (markupGrammar && !r.hadNested && raw.includes("{{")) emitInnerLiterals(raw, first, r.context, true);
      return;
    }
    if (r.directive) return emitInnerLiterals(stripDelimiters(raw), { ...first, column: first.column + 1 }, r.context, false);
    if (r.bareAttr) return pushHit(stripDelimiters(raw), raw, first, r.context);
    pushHit(r.jsxAttr || isRawString(first.scopes, raw) ? raw : decodeEscapes(raw), raw, first, r.context);
  };
  const flushNested = () => {
    if (nested) emit(nested);
    nested = null;
  };
  const flush = () => {
    flushNested();
    if (run) emit(run);
    run = null;
    holeStart = -1;
  };
  // Cut an unfinished hole off a text run and emit the text before it.
  const abortHole = () => {
    if (run && holeStart >= 0) run.tokens.length = holeStart;
    flush();
  };
  const append = (r: Run, tok: Tok) => {
    if (pendingNewline && (r.tokens.length > 0 || r.kind === "text")) {
      // A text node that starts on the line after its tag begins at that
      // tag's line end, like the source slice does.
      const prevLine = tok.line - 1;
      r.tokens.push({ text: "\n", scopes: [], line: prevLine, column: (lines[prevLine - 1]?.length ?? 0) + 1 });
    }
    r.tokens.push(tok);
  };

  const noteWords = (text: string) => {
    for (const m of text.matchAll(WORD_RE)) {
      const w = m[0];
      if (w === "(") {
        const [c, b, a] = words.slice(-3);
        const frame: CallContext = {};
        if (a && IDENT_RE.test(a)) {
          frame.methodName = a;
          // `Log.d(` has a bare receiver; `Builder(ctx).setTitle(` does not.
          if (b !== ".") frame.callee = a;
          else if (c && IDENT_RE.test(c)) Object.assign(frame, { callee: c, calleeMember: a });
        }
        callStack.push(frame);
      } else if (w === ")") {
        callStack.pop();
      }
      words.push(w);
      if (words.length > 4) words.shift();
    }
  };

  const startString = (tok: Tok): Run => {
    const s = tok.scopes;
    const prevWord = words[words.length - 1];
    // `attr={"x"}` is an attribute value too; deeper expressions in the braces are code.
    if (inAttrValue(s) || (prevWord === "{" && lastIndex(s, ATTR_LIST) !== -1)) {
      if (lastAttr && DIRECTIVE_ATTR.test(lastAttr)) {
        return { kind: "string", tokens: [tok], context: { parentRole: "other", identifiers: [] }, directive: true };
      }
      return {
        kind: "string",
        tokens: [tok],
        context: { parentRole: "markup_attr", identifiers: lastAttr ? [lastAttr.toLowerCase()] : [] },
        bareAttr: markupGrammar,
        jsxAttr: !markupGrammar && inAttrValue(s),
      };
    }
    const role = excludedRole(s);
    const context: DittoScanEnclosingContext = role
      ? { parentRole: role, identifiers: [] }
      : { parentRole: "other", identifiers: [], ...(callStack[callStack.length - 1] ?? {}) };
    return { kind: "string", tokens: [tok], context };
  };

  // `<style>` bodies never hold copy. `<script>` bodies in plain templates
  // are skipped too; component formats keep theirs.
  const skipsEmbeddedCode = (s: string[]) =>
    anyOf(s, ["source.css"]) || (markupGrammar && !KEEPS_SCRIPT.has(lang) && anyOf(s, ["source.js", "source.ts"]));

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const res = grammar.tokenizeLine(line, stack);
    stack = res.ruleStack;
    pendingNewline = li > 0;

    for (const t of res.tokens as IToken[]) {
      const tok: Tok = { text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes, line: li + 1, column: t.startIndex + 1 };
      const s = tok.scopes;
      const done = () => {
        pendingNewline = false;
      };

      if (anyOf(s, ["comment."]) || anyOf(s, NOT_STRING) || skipsEmbeddedCode(s)) {
        flush();
        done();
        continue;
      }

      if (run?.kind === "string") {
        if (isStringBody(s) || isStringPunct(s) || (isHole(s) && holeInsideString(s))) {
          append(run, tok);
          done();
          continue;
        }
        flush();
      }

      if (run?.kind === "text" && anyOf(s, [...TAG_PUNCT, ...TAG_NAME, ...ATTR_NAME])) {
        // Markup structure ends a text node even inside a hole.
        if (holeStart >= 0) abortHole();
        else flush();
      }
      if (run?.kind === "text") {
        const hole = isHole(s) && !anyOf(s, EMBEDDED_BLOCK) && !isMarkupText(s);
        if (hole && holeStart >= 0 && pendingNewline) {
          // A hole that spans lines is structure rather than a placeholder.
          abortHole();
        } else if (hole && stringInsideHole(s) && (isStringBody(s) || isStringPunct(s))) {
          if (nested) append(nested, tok);
          else nested = startString(tok);
          run.hadNested = true;
          append(run, tok);
          done();
          continue;
        }
        if (run) {
          flushNested();
          if (hole || tok.text.trim() === "") {
            if (hole && isHoleOpen(s, tok.text) && holeStart < 0) holeStart = run.tokens.length;
            noteWords(tok.text);
            append(run, tok);
            if (hole && isHoleClose(s, tok.text)) holeStart = -1;
            done();
            continue;
          }
          if (!isMarkupText(s)) flush();
        }
      }

      if (isStringBody(s) || isStringPunct(s)) {
        flush();
        run = startString(tok);
        done();
        continue;
      }

      // Markup structure.
      if (anyOf(s, TAG_PUNCT)) {
        flush();
        if (tok.text.startsWith("<")) {
          closingTag = tok.text.startsWith("</");
          lastAttr = null;
          selfClosing = false;
        } else if (tok.text === "/>" || selfClosing) {
          tagStack.pop();
          selfClosing = false;
        }
        done();
        continue;
      }
      if (anyOf(s, TAG_NAME)) {
        if (closingTag) tagStack.pop();
        else tagStack.push(tok.text.toLowerCase());
        done();
        continue;
      }
      if (anyOf(s, ATTR_NAME)) {
        lastAttr = tok.text;
        done();
        continue;
      }
      // Grammars that split `/>` into `/` and `>`.
      if (tok.text.trim() === "/" && tagStack.length > 0 && !closingTag && lastIndex(s, ATTR_LIST) !== -1) {
        selfClosing = true;
        done();
        continue;
      }

      // Text node, or a hole that opens one (`<p>{{ __('x') }} more</p>`).
      const opensText =
        isMarkupText(s) ||
        (tagStack.length > 0 && isHoleOpen(s, tok.text) && !anyOf(s, EMBEDDED_BLOCK) && lastIndex(s, ATTR_LIST) === -1);
      if (opensText) {
        if (!run) run = { kind: "text", tokens: [], context: { parentRole: "markup_text", identifiers: [], ...parentTagContext() } };
        if (isHoleOpen(s, tok.text)) holeStart = run.tokens.length;
        if (isMarkupText(s) && tok.text.trim() !== "") tok.literal = true;
        append(run, tok);
        done();
        continue;
      }

      // Plain code token.
      flush();
      noteWords(tok.text);
      done();
    }
  }
  flush();
  return out.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
}

/**
 * The registry passes the language id as `kind`, which doubles as the
 * `tm-grammars` grammar name, so one extractor instance serves every
 * grammar-backed language.
 */
export const grammarExtractor: LanguageExtractor = {
  extract: async ({ source, kind }) => composeHits(await extractWithGrammar(source, kind), source),
};
