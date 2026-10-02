import fs from "fs";
import path from "path";

import { loadWASM, createOnigScanner, createOnigString } from "vscode-oniguruma";
import { INITIAL, Registry, type IGrammar, type IToken, type StateStack } from "vscode-textmate";

import type { DittoScanEnclosingContext } from "../../types";
import type { ExtractedHit, LanguageExtractor } from "../types";
import { decodeEscapes } from "./util";

/**
 * Grammar-driven string finder built on TextMate grammars (the ones VS Code
 * and shiki use). One implementation covers every language `tm-grammars`
 * ships a grammar for, so a new client language is a table entry, not a new
 * extractor.
 *
 * The grammar labels each span with scopes such as `string.quoted.double`,
 * `comment.line`, `meta.embedded` or `meta.jsx.children`. This extractor
 * reads the scopes and emits:
 *   - one hit per string literal, with interpolation holes kept in the raw
 *     text (`"Hello ${name}"` stays one hit)
 *   - one hit per markup text node (JSX children, HTML/Vue/Svelte/Blade text),
 *     holes included, so `{count} items` is one node
 *   - `markup_attr` for strings inside a tag's attribute list
 *   - `callee`/`calleeMember`/`methodName` recovered from the identifier
 *     tokens that precede the enclosing `(`
 *   - the excluded roles (`import`, `type_tag`, `object_key`, `regex_pattern`)
 *     where the grammar or the surrounding tokens make them certain
 *
 * Value convention matches the AST extractors this replaces: a code literal
 * keeps its delimiters and has its escapes decoded; a raw string is left
 * alone; an HTML attribute value is the bare inner text; markup text is raw.
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
      if (!g) throw new Error(`textmate: no grammar for ${lang}`);
      return g;
    })();
    grammarCache.set(lang, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Scope predicates
// ---------------------------------------------------------------------------

const has = (scopes: string[], prefix: string) => scopes.some((s) => s.startsWith(prefix));
const indexOf = (scopes: string[], test: (s: string) => boolean) => scopes.findIndex(test);
const lastIndexOf = (scopes: string[], test: (s: string) => boolean) => {
  for (let i = scopes.length - 1; i >= 0; i--) if (test(scopes[i])) return i;
  return -1;
};

const isComment = (s: string[]) => has(s, "comment.");
const isRegexp = (s: string[]) => has(s, "string.regexp");
// Quote characters, string prefixes (`f`, `$`, `@`) and template delimiters.
const isStringPunct = (s: string[]) =>
  has(s, "punctuation.definition.string") || has(s, "punctuation.definition.template") || has(s, "storage.type.string");
// Python marks the whole f-string `meta.fstring` and drops `string.` on the
// tokens inside its `{}` holes, so `meta.fstring` counts as string body.
const stringScope = (s: string) => (s.startsWith("string.") && !s.startsWith("string.regexp")) || s.startsWith("meta.fstring");
const isStringBody = (s: string[]) => s.some(stringScope);
// Expression holes inside a string or a markup text node.
const embeddedScope = (s: string) =>
  s.startsWith("meta.embedded") ||
  s.startsWith("meta.template.expression") ||
  s.startsWith("meta.interpolation") ||
  s.startsWith("punctuation.section.embedded") ||
  s.startsWith("punctuation.definition.template-expression") ||
  s.startsWith("constant.character.format.placeholder") ||
  s.startsWith("meta.function.echo") ||
  s.startsWith("variable.meta.scope.jinja");
const isEmbedded = (s: string[]) => s.some(embeddedScope);
// `<script>` bodies and the like are embedded *blocks*, not holes in text.
const isEmbeddedBlock = (s: string[]) => has(s, "meta.embedded.block");
// A hole is part of the string only when the grammar nests it inside the
// string scope. `)` after a Blade `{{ __('x') }}` carries an echo scope but
// no string scope, so it closes the literal.
const embeddedInsideString = (s: string[]) => {
  const si = indexOf(s, stringScope);
  const ei = indexOf(s, embeddedScope);
  return si !== -1 && ei !== -1 && si < ei;
};
const stringInsideEmbedded = (s: string[]) => {
  const si = indexOf(s, stringScope);
  const ei = indexOf(s, embeddedScope);
  return si !== -1 && ei !== -1 && ei < si;
};
// Jinja/Django `{{ var }}` is a hole; `{% tag %}` is a block boundary.
const jinjaVarDelimiter = (s: string[]) => has(s, "variable.entity.other.jinja.delimiter");
const isHoleOpen = (s: string[], text: string) =>
  has(s, "punctuation.section.embedded.begin") ||
  has(s, "punctuation.definition.template-expression.begin") ||
  has(s, "support.function.construct.begin") ||
  (jinjaVarDelimiter(s) && text.trim().startsWith("{{"));
const isHoleClose = (s: string[], text: string) =>
  has(s, "punctuation.section.embedded.end") ||
  has(s, "punctuation.definition.template-expression.end") ||
  has(s, "support.function.construct.end") ||
  (jinjaVarDelimiter(s) && text.trim().endsWith("}}"));
const isTagPunct = (s: string[]) => has(s, "punctuation.definition.tag");
const isTagName = (s: string[]) => has(s, "entity.name.tag");
const isAttrName = (s: string[]) => has(s, "entity.other.attribute-name");
const isComparison = (s: string[]) => has(s, "keyword.operator.comparison") || has(s, "keyword.operator.relational");
const isAttributeDecorator = (s: string[]) => has(s, "storage.modifier.attribute") || has(s, "meta.attribute.swift");
// A string is an attribute value when the innermost attribute scope is
// deeper than the innermost hole. `<input type="x" />` inside a `{cond && (...)}`
// hole is still an attribute; `style={{ margin: "4px" }}` is code.
// `meta.tag` alone is not enough: TSX scopes JSX children under `meta.tag` too.
const attrScope = (s: string) => s.startsWith("meta.tag.attributes") || s.startsWith("meta.attribute");
const inAttrValue = (s: string[]) => lastIndexOf(s, attrScope) > lastIndexOf(s, embeddedScope);
// Raw strings do not process escapes: Kotlin/Python `"""`, Swift `#"`, C# `@"`,
// Go backticks, Python `r"`.
const isRawString = (s: string[], text: string) => has(s, "string.quoted.raw") || /^(?:"""|#+"|@"|[rR]["'])/.test(text);

// Text between tags. HTML-family grammars leave it with only `text.*`
// scopes; TSX marks it `meta.jsx.children`; Svelte marks it `text.svelte`.
// `&amp;` is part of the text node, not a boundary.
function isMarkupText(scopes: string[]): boolean {
  const last = scopes[scopes.length - 1];
  return last.startsWith("meta.jsx.children") || last.startsWith("text.") || has(scopes, "constant.character.entity");
}

// Roles `shouldEmit` drops, when the grammar exposes them. `meta.export`
// wraps whole exported function bodies, so only `meta.import` is trusted.
function excludedRole(s: string[]): DittoScanEnclosingContext["parentRole"] | null {
  if (has(s, "meta.import")) return "import";
  if (has(s, "meta.type") || has(s, "meta.interface")) return "type_tag";
  if (has(s, "meta.object-literal.key") || has(s, "meta.objectliteral.key")) return "object_key";
  return null;
}

// Constructors whose string argument is a pattern, by name, like the AST
// extractors did.
const REGEX_CONSTRUCTORS = new Set(["RegExp", "Regex", "NSRegularExpression", "Pattern"]);
const COMPARISONS = new Set(["==", "===", "!=", "!==", "<>"]);
// Markup elements whose text is code, so `parentTag` is withheld and the
// classifier sees no element hint.
const CODE_LIKE_TAGS = new Set(["pre", "code", "kbd", "samp", "var", "script", "style"]);
// Vue/Alpine/Angular bindings: the value is an expression, not copy.
const DIRECTIVE_ATTR = /^[:@#]|^v-|^\*|^\[|^\(|^bind-|^on-|^x-/;
const QUOTED_LITERAL = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
// Grammars whose root is a document, where text nodes carry copy and
// attribute values are bare.
const MARKUP_GRAMMARS = new Set(["html", "vue", "svelte", "astro", "blade", "erb", "liquid", "handlebars", "jinja-html", "twig"]);
// A Django or Jinja template usually arrives as `.html`. The Jinja grammar
// knows `{% %}` and `{{ }}`; the plain HTML grammar reads them as text.
const DJANGO_TAG = /\{%[\s\S]*?%\}/;
function grammarFor(lang: string, source: string): string {
  return lang === "html" && DJANGO_TAG.test(source) ? "jinja-html" : lang;
}
// Component formats keep their `<script>` code; plain templates do not.
const KEEPS_SCRIPT = new Set(["vue", "svelte", "astro"]);

// ---------------------------------------------------------------------------
// Tokenizer walk
// ---------------------------------------------------------------------------

type Tok = { text: string; scopes: string[]; line: number; column: number; literal?: boolean };

type CallContext = Pick<DittoScanEnclosingContext, "callee" | "calleeMember" | "methodName">;
// `@objc("x")`, `@Component({...})`: an annotation's argument is a tag.
type CallFrame = CallContext & { annotation?: boolean };

type Run = {
  kind: "string" | "text";
  tokens: Tok[];
  context: DittoScanEnclosingContext;
  // The string follows `{`, `[`, `,` or a line start, so a `:` after it makes
  // it an object key rather than the middle of a ternary.
  keyCandidate?: boolean;
  // HTML attribute values are emitted without their quotes; a directive's
  // value is scanned for literals instead of being emitted.
  bareAttr?: boolean;
  directive?: boolean;
  // Bare JSX attribute values keep their backslashes.
  jsxAttr?: boolean;
  // A text run whose holes held tokenized string literals.
  hadNested?: boolean;
};

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const WORD_OR_PUNCT_RE = /[A-Za-z_$][\w$]*|===|!==|==|!=|<>|->|[().{}[\],?:=@]/g;

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
  // A string literal inside a hole of a markup text run (`{t("x")}`). It is
  // emitted on its own as well, so key references are not lost.
  let nested: Run | null = null;
  let pendingNewline = false;
  // Index into `run.tokens` where the current `{...}` hole began, so a hole
  // that turns out to be nested markup or spans lines can be cut off.
  let holeStart = -1;
  // Rolling buffer of identifier/operator/punct words from non-string tokens,
  // used to recover `receiver.method(` and `x == ` before a string.
  const words: string[] = [];
  const callStack: CallFrame[] = [];
  // Last non-whitespace code token, for scope-based checks like `===`.
  let lastCode: Tok | null = null;
  const tagStack: string[] = [];
  let closingTag = false;
  let selfClosing = false;
  let lastAttr: string | null = null;

  const inCodeLikeTag = () => tagStack.some((t) => CODE_LIKE_TAGS.has(t));
  const parentTagContext = (): Pick<DittoScanEnclosingContext, "parentTag"> => {
    const parentTag = tagStack[tagStack.length - 1];
    return parentTag && !inCodeLikeTag() ? { parentTag } : {};
  };

  const pushHit = (value: string, raw: string, first: Tok, context: DittoScanEnclosingContext) => {
    out.push({ value, snapshotText: raw, location: { line: first.line, column: first.column }, context });
  };

  // Literals the grammar does not tokenize: inside a `{{ ... }}` hole of an
  // HTML-family text node, or inside a directive attribute's expression. A
  // regex pulls `'Unfollow'` and `'Follow'` out of `{{ a ? 'Unfollow' : 'Follow' }}`.
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
    if (!holesOnly) {
      scan(raw, 0);
      return;
    }
    const HOLE = /\{\{([\s\S]*?)\}\}/g;
    let h: RegExpExecArray | null;
    while ((h = HOLE.exec(raw)) !== null) scan(h[1], h.index + 2);
  };

  const emit = (r: Run) => {
    if (r.kind === "text") {
      if (r.tokens.length === 0) return;
      // Verbatim slice, indentation included: the value is the key that
      // matches the node back to its place in code. Trimming happens downstream.
      const raw = r.tokens.map((t) => t.text).join("");
      // A node that is only holes (`{count}`) carries no copy of its own,
      // but the literals inside its holes still do.
      if (r.tokens.some((t) => t.literal)) pushHit(raw, raw, r.tokens[0], r.context);
      // Only when the grammar did not tokenize the hole itself (plain HTML,
      // Vue). Jinja holes are tokenized, so their literals arrive as nested.
      if (markupGrammar && !r.hadNested && raw.includes("{{")) emitInnerLiterals(raw, r.tokens[0], r.context, true);
      return;
    }
    const raw = r.tokens.map((t) => t.text).join("");
    const first = r.tokens[0];
    const last = r.tokens[r.tokens.length - 1];
    const after = lines[last.line - 1].slice(last.column - 1 + last.text.length);
    if (r.directive) {
      emitInnerLiterals(stripDelimiters(raw), { ...first, column: first.column + 1 }, r.context, false);
      return;
    }
    if (r.bareAttr) {
      pushHit(stripDelimiters(raw), raw, first, r.context);
      return;
    }
    if (r.context.parentRole === "other") {
      // `"k": v`, `"k" to v` (Kotlin mapOf). A `"k" -> v` arm of a Kotlin
      // `when` is a tag, not copy.
      if (r.keyCandidate && (/^\s*:(?!:)/.test(after) || /^\s+to\s/.test(after))) {
        r.context = { parentRole: "object_key", identifiers: [] };
      } else if (/^\s*->/.test(after)) {
        r.context = { parentRole: "type_tag", identifiers: [] };
      }
    }
    const value = r.jsxAttr || isRawString(first.scopes, raw) ? raw : decodeEscapes(raw);
    pushHit(value, raw, first, r.context);
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

  const callContext = (): CallFrame => {
    const frame = callStack[callStack.length - 1];
    return frame ? { ...frame } : {};
  };

  const noteWords = (text: string) => {
    for (const m of text.matchAll(WORD_OR_PUNCT_RE)) {
      const w = m[0];
      if (w === "(") {
        const a = words[words.length - 1];
        const b = words[words.length - 2];
        const c = words[words.length - 3];
        const frame: CallFrame = {};
        if (a && IDENT_RE.test(a)) {
          frame.methodName = a;
          if (b === ".") {
            // `Log.d(` has a bare receiver; `Builder(ctx).setTitle(` does not.
            if (c && IDENT_RE.test(c)) {
              frame.callee = c;
              frame.calleeMember = a;
            }
          } else if (b === "@") {
            frame.annotation = true;
          } else {
            frame.callee = a;
          }
        }
        callStack.push(frame);
      } else if (w === ")") {
        callStack.pop();
      }
      words.push(w);
      if (words.length > 8) words.shift();
    }
  };

  const startString = (tok: Tok): Run => {
    const s = tok.scopes;
    const call = callContext();
    const prevWord = words[words.length - 1];
    const attrValue = inAttrValue(s);
    // `attr={"x"}` and `attr={`x`}` are attribute values too; deeper
    // expressions inside the braces are code.
    const directHoleValue = prevWord === "{" && lastIndexOf(s, attrScope) !== -1;
    if (attrValue || directHoleValue) {
      if (lastAttr && DIRECTIVE_ATTR.test(lastAttr)) {
        return { kind: "string", tokens: [tok], context: { parentRole: "other", identifiers: [] }, directive: true };
      }
      return {
        kind: "string",
        tokens: [tok],
        context: { parentRole: "markup_attr", identifiers: lastAttr ? [lastAttr.toLowerCase()] : [] },
        bareAttr: markupGrammar,
        jsxAttr: !markupGrammar && attrValue,
      };
    }
    const { annotation, ...callCtx } = call;
    const roleFromCode =
      prevWord === "from" || call.callee === "require" || call.callee === "import"
        ? "import"
        : call.methodName && REGEX_CONSTRUCTORS.has(call.methodName)
        ? "regex_pattern"
        : annotation ||
          prevWord === "case" ||
          (prevWord !== undefined && COMPARISONS.has(prevWord)) ||
          (lastCode !== null && (isComparison(lastCode.scopes) || isAttributeDecorator(lastCode.scopes))) ||
          // Swift `enum E: String { case a = "alpha" }`.
          (prevWord === "=" && words[words.length - 3] === "case")
        ? "type_tag"
        : excludedRole(s);
    const context: DittoScanEnclosingContext = roleFromCode
      ? { parentRole: roleFromCode, identifiers: [] }
      : { parentRole: "other", identifiers: [], ...callCtx };
    const keyCandidate =
      prevWord === undefined ||
      prevWord === "{" ||
      prevWord === "[" ||
      prevWord === "," ||
      prevWord === "(" ||
      lines[tok.line - 1].slice(0, tok.column - 1).trim() === "";
    return { kind: "string", tokens: [tok], context, keyCandidate };
  };

  // `<style>` bodies never hold copy. `<script>` bodies in plain HTML-like
  // templates are skipped too; component formats keep theirs.
  const skipsEmbeddedCode = (s: string[]) =>
    has(s, "source.css") || (markupGrammar && !KEEPS_SCRIPT.has(lang) && (has(s, "source.js") || has(s, "source.ts")));

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const res = grammar.tokenizeLine(line, stack);
    stack = res.ruleStack;
    pendingNewline = li > 0;

    for (const t of res.tokens as IToken[]) {
      const tok: Tok = {
        text: line.slice(t.startIndex, t.endIndex),
        scopes: t.scopes,
        line: li + 1,
        column: t.startIndex + 1,
      };
      const s = tok.scopes;
      const consumed = () => {
        pendingNewline = false;
      };

      if (isComment(s) || isRegexp(s) || skipsEmbeddedCode(s)) {
        flush();
        consumed();
        continue;
      }

      if (run?.kind === "string") {
        if (isStringBody(s) || isStringPunct(s) || (isEmbedded(s) && embeddedInsideString(s))) {
          append(run, tok);
          consumed();
          continue;
        }
        flush();
      }

      if (run?.kind === "text" && (isTagPunct(s) || isTagName(s) || isAttrName(s))) {
        // Markup structure ends a text node even inside a hole.
        if (holeStart >= 0) abortHole();
        else flush();
      }
      if (run?.kind === "text") {
        const hole = isEmbedded(s) && !isEmbeddedBlock(s) && !isMarkupText(s);
        // A hole that spans lines is structure rather than a placeholder.
        if (hole && holeStart >= 0 && pendingNewline) {
          abortHole();
        } else if (hole && stringInsideEmbedded(s) && (isStringBody(s) || isStringPunct(s))) {
          if (nested) append(nested, tok);
          else nested = startString(tok);
          run.hadNested = true;
          append(run, tok);
          consumed();
          continue;
        }
        if (run) {
          flushNested();
          if (hole || tok.text.trim().length === 0) {
            if (hole && isHoleOpen(s, tok.text) && holeStart < 0) holeStart = run.tokens.length;
            noteWords(tok.text);
            if (tok.text.trim() !== "") lastCode = tok;
            append(run, tok);
            if (hole && isHoleClose(s, tok.text)) holeStart = -1;
            consumed();
            continue;
          }
          if (!isMarkupText(s)) flush();
        }
      }

      if (isStringBody(s) || isStringPunct(s)) {
        flush();
        run = startString(tok);
        consumed();
        continue;
      }

      // Markup structure.
      if (isTagPunct(s)) {
        flush();
        if (tok.text.startsWith("<")) {
          closingTag = tok.text.startsWith("</");
          lastAttr = null;
          selfClosing = false;
        } else if (tok.text === "/>" || selfClosing) {
          tagStack.pop();
          selfClosing = false;
        }
        consumed();
        continue;
      }
      if (isTagName(s)) {
        if (closingTag) tagStack.pop();
        else tagStack.push(tok.text.toLowerCase());
        consumed();
        continue;
      }
      if (isAttrName(s)) {
        lastAttr = tok.text;
        consumed();
        continue;
      }
      // Grammars that split `/>` into `/` and `>`.
      if (tok.text.trim() === "/" && tagStack.length > 0 && !closingTag && lastIndexOf(s, attrScope) !== -1) {
        selfClosing = true;
        consumed();
        continue;
      }

      // Text node, or a hole that opens one (`<p>{{ __('x') }} more</p>`).
      const opensText =
        isMarkupText(s) ||
        (tagStack.length > 0 && isHoleOpen(s, tok.text) && !isEmbeddedBlock(s) && lastIndexOf(s, attrScope) === -1);
      if (opensText) {
        if (!run) {
          run = { kind: "text", tokens: [], context: { parentRole: "markup_text", identifiers: [], ...parentTagContext() } };
        }
        if (isHoleOpen(s, tok.text)) holeStart = run.tokens.length;
        if (isMarkupText(s) && tok.text.trim() !== "") tok.literal = true;
        append(run, tok);
        consumed();
        continue;
      }

      // Plain code token.
      flush();
      noteWords(tok.text);
      if (tok.text.trim() !== "") lastCode = tok;
      consumed();
    }
  }
  flush();
  out.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
  return out;
}

/**
 * The registry passes the language id as `kind`, which doubles as the
 * `tm-grammars` grammar name, so one extractor instance serves every
 * grammar-backed language.
 */
export const textmateExtractor: LanguageExtractor = {
  extract: ({ source, kind }) => extractWithGrammar(source, kind),
};
