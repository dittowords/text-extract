import fs from "fs";
import path from "path";

import { loadWASM, createOnigScanner, createOnigString } from "vscode-oniguruma";
import { INITIAL, Registry, type IGrammar, type IToken, type StateStack } from "vscode-textmate";

import type { DittoScanEnclosingContext } from "../../types";
import type { ExtractedHit, LanguageExtractor } from "../types";
import { decodeEscapes } from "./util";

/**
 * String finder for every language with a grammar in `tm-grammars`. These
 * are the grammars of VS Code and shiki. A new language is a row in
 * `grammars.ts`, not a new file.
 *
 * A grammar gives each token a list of scopes, such as
 * `string.quoted.double` or `entity.name.tag`. This file turns scopes into hits:
 *   - a run of string tokens is one literal, with its interpolation holes
 *   - the tokens between two tags are one markup text node, with its holes
 *   - a string inside an attribute is `markup_attr`, with the attribute name
 *
 * Every hit has its exact span. The server decides which hits are copy,
 * which hits join into one sentence, and what a placeholder is named.
 * Nothing is filtered, joined, or named here.
 *
 * Two scope conventions are the same in every grammar. A string literal
 * keeps a `string.` scope through its holes. A tag has
 * `punctuation.definition.tag` and `entity.name.tag`. Template holes are
 * not uniform: each template grammar has its own scope for `{{ }}`. So a
 * text node is bounded by tags, not by holes. A hole is the span between
 * two pieces of text.
 *
 * Values: a code literal keeps its delimiters, with escapes decoded. A raw
 * string is kept as is. An HTML attribute value has no quotes. Markup text
 * is the exact source slice.
 */

// ---------------------------------------------------------------------------
// Grammar loading
// ---------------------------------------------------------------------------

const GRAMMAR_DIR = path.dirname(require.resolve("tm-grammars/grammars/python.json"));

const grammarJsonCache = new Map<string, { scopeName: string }>();
function grammarJson(lang: string): { scopeName: string } {
  let j = grammarJsonCache.get(lang);
  if (!j) {
    j = JSON.parse(fs.readFileSync(path.join(GRAMMAR_DIR, `${lang}.json`), "utf8"));
    grammarJsonCache.set(lang, j!);
  }
  return j!;
}

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
    // The Angular template grammars (`@if` blocks, `{{ }}`, `@let`) are injected
    // into the Angular HTML grammar. Other injections stay off, so the other
    // languages tokenize as before.
    getInjections: (scopeName) => (scopeName === "text.html.derivative.ng" ? ["template.blocks.ng", "template.ng", "template.let.ng"] : undefined),
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
      const g = await getRegistry().loadGrammar(grammarJson(lang).scopeName);
      if (!g) throw new Error(`no grammar for ${lang}`);
      return g;
    })();
    grammarCache.set(lang, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Scope tables. Each entry is a scope prefix. A token matches when one of
// its scopes starts with the prefix.
// ---------------------------------------------------------------------------

const STRING_BODY = [
  "string.",
  "meta.fstring", // python: the holes of an f-string lose `string.`
];
const STRING_PUNCT = ["punctuation.definition.string"];
const NOT_STRING = ["string.regexp"];
const TAG_PUNCT = ["punctuation.definition.tag"];
const TAG_NAME = ["entity.name.tag"];
const ATTR_NAME = ["entity.other.attribute-name"];
const ATTR_LIST = ["meta.tag.attributes", "meta.attribute"];
const IN_TAG = ["meta.tag"];
const EMBEDDED = ["meta.embedded"]; // a `{ }` expression in an attribute
// The innermost scope of a markup text token. In a grammar with a `text.`
// root, text has only the root scope. In JSX and in a nested Vue
// `<template>`, text has a container scope.
const TEXT_CONTAINER = ["text.", "meta.jsx.children", "meta.template-tag.", "control.block.body.ng"];
const TEXT_ANY = ["constant.character.entity"]; // `&amp;` belongs to the text node
const RAW_STRING = ["string.quoted.raw"];
const RAW_STRING_PREFIX = /^(?:"""|#+"|@")/; // kotlin, swift, c#
// Markup grammars with a `source.` root scope.
const SOURCE_ROOTED_MARKUP = new Set(["svelte", "astro"]);
// A template file often has the `.html` extension. The Jinja grammar has
// tokens for `{{ }}` and `{% %}`. In the plain HTML grammar they are text.
const TEMPLATE_SYNTAX = /\{[{%]/;
const grammarFor = (lang: string, source: string) => (lang === "html" && TEMPLATE_SYNTAX.test(source) ? "jinja-html" : lang);
const isMarkupGrammar = (lang: string) => grammarJson(lang).scopeName.startsWith("text.") || SOURCE_ROOTED_MARKUP.has(lang);

const anyOf = (scopes: string[], prefixes: string[]) => scopes.some((s) => prefixes.some((p) => s.startsWith(p)));
const lastIndex = (scopes: string[], prefixes: string[]) => {
  for (let i = scopes.length - 1; i >= 0; i--) if (prefixes.some((p) => scopes[i].startsWith(p))) return i;
  return -1;
};

const isString = (s: string[]) => (anyOf(s, STRING_BODY) || anyOf(s, STRING_PUNCT)) && !anyOf(s, NOT_STRING);
const isTagOpen = (s: string[], text: string) => anyOf(s, TAG_NAME) || (anyOf(s, TAG_PUNCT) && text.startsWith("<"));
// A string is an attribute value when the innermost attribute scope is
// deeper than the innermost embedded expression. `<input type="x" />` inside
// `{cond && (...)}` is an attribute value. `style={{ margin: "4px" }}` is code.
const inAttrValue = (s: string[]) => lastIndex(s, ATTR_LIST) > lastIndex(s, EMBEDDED);
const isMarkupText = (s: string[]) =>
  TEXT_CONTAINER.some((p) => s[s.length - 1].startsWith(p)) || anyOf(s, TEXT_ANY);
const isRawString = (s: string[], text: string) => anyOf(s, RAW_STRING) || RAW_STRING_PREFIX.test(text);
// ponytail: hole delimiters are counted as braces, not read from the
// grammar. Covers `{ }`, `{{ }}`, `{% %}`, `${ }`, `#{ }`, `<% %>` and
// `<? ?>`. A brace inside a string literal in a hole is not counted: a
// string token is never passed to `holeDelta`. Upgrade path: read
// `punctuation.section.embedded` where a grammar has it.
const holeBalance = (text: string) => (text.match(/\{|<[%?]/g)?.length ?? 0) - (text.match(/\}|[%?]>/g)?.length ?? 0);
// The balance change of one token. `prev` is the last character of the
// previous hole token: a grammar can split `<%` or `%>` into two tokens.
const holeDelta = (prev: string, text: string) => holeBalance(prev + text) - holeBalance(prev);

// ---------------------------------------------------------------------------
// Tokenizer walk
// ---------------------------------------------------------------------------

type Tok = { text: string; scopes: string[]; line: number; column: number; literal?: boolean };
type Run = {
  kind: "string" | "text";
  tokens: Tok[];
  context: DittoScanEnclosingContext;
  // An HTML attribute value has no quotes. A JSX attribute keeps its backslashes.
  bareAttr?: boolean;
  jsxAttr?: boolean;
};

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
  const name = grammarFor(lang, source);
  const grammar = await loadGrammar(name);
  const markup = isMarkupGrammar(name);
  const out: ExtractedHit[] = [];
  const lines = source.split(/\r?\n/);
  // ponytail: one line ending per file. A mixed file gets the first one.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";

  let stack: StateStack | null = INITIAL;
  let run: Run | null = null;
  // A string literal inside a hole of a text run, as in `{t("x")}`, is one
  // hit on its own and is also part of the text node's span.
  let nested: Run | null = null;
  let pendingNewline = false;
  // Index into `run.tokens` where the open hole began, the brace balance of
  // that hole, and the last character of the previous hole token.
  let holeStart = -1;
  let balance = 0;
  let holePrev = "";
  // True after a tag name until the `>`. A token with a `meta.tag` scope is
  // then tag content, not text.
  let inTag = false;
  let lastAttr: string | null = null;
  let prevText = "";
  let lineHasText = false;

  const pushHit = (value: string, raw: string, first: Tok, context: DittoScanEnclosingContext) => {
    out.push({ value, snapshotText: raw, location: { line: first.line, column: first.column }, context });
  };

  const emit = (r: Run) => {
    // A run of delimiters alone holds no literal. Examples: `""`, the outer
    // quotes of a Vue directive.
    if (!r.tokens.some((t) => (r.kind === "text" ? t.literal : anyOf(t.scopes, STRING_BODY)))) return;
    const raw = r.tokens.map((t) => t.text).join("");
    const first = r.tokens[0];
    if (r.kind === "text") return pushHit(raw, raw, first, r.context);
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
    balance = 0;
    holePrev = "";
  };
  // Cut an unfinished hole off a text run. Emit the text before it.
  const abortHole = () => {
    if (run && holeStart >= 0) run.tokens.length = holeStart;
    flush();
  };
  const append = (r: Run, tok: Tok) => {
    if (pendingNewline && (r.tokens.length > 0 || r.kind === "text")) {
      // A text node that starts on the line after its tag begins at the end
      // of the tag's line. The source slice has the same start.
      const prevLine = tok.line - 1;
      r.tokens.push({ text: eol, scopes: [], line: prevLine, column: (lines[prevLine - 1]?.length ?? 0) + 1 });
    }
    r.tokens.push(tok);
  };

  const startString = (tok: Tok): Run => {
    const s = tok.scopes;
    // `attr={"x"}` is an attribute value. A deeper expression in the braces is code.
    if (inAttrValue(s) || (prevText === "{" && lastIndex(s, ATTR_LIST) !== -1)) {
      return {
        kind: "string",
        tokens: [tok],
        context: { parentRole: "markup_attr", identifiers: lastAttr ? [lastAttr.toLowerCase()] : [] },
        bareAttr: markup,
        jsxAttr: !markup && inAttrValue(s),
      };
    }
    return { kind: "string", tokens: [tok], context: { parentRole: "other", identifiers: [] } };
  };

  // Add a token to the open text run, as text or as part of a hole.
  const addToText = (tok: Tok) => {
    const text = isMarkupText(tok.scopes);
    if (text) {
      if (tok.text.trim() !== "") {
        tok.literal = true;
        lineHasText = true;
      }
    } else {
      if (balance === 0) {
        holeStart = run!.tokens.length;
        holePrev = "";
      }
      append(run!, tok);
      balance = Math.max(0, balance + holeDelta(holePrev, tok.text));
      holePrev = tok.text.slice(-1);
      if (balance === 0) holeStart = -1;
      return;
    }
    append(run!, tok);
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const res = grammar.tokenizeLine(line, stack);
    stack = res.ruleStack;
    pendingNewline = li > 0;
    lineHasText = false;
    // A text run with no text yet ends at a line break.
    if (run?.kind === "text" && !run.tokens.some((t) => t.literal)) flush();

    for (const t of res.tokens as IToken[]) {
      const tok: Tok = { text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes, line: li + 1, column: t.startIndex + 1 };
      const s = tok.scopes;
      const done = () => {
        pendingNewline = false;
        if (tok.text.trim() !== "") prevText = tok.text.trim();
      };

      if (anyOf(s, ["comment."]) || anyOf(s, NOT_STRING)) {
        // A comment inside a hole, as in `{/* c */}`, ends the text node
        // before the hole.
        abortHole();
        done();
        continue;
      }

      if (run?.kind === "string") {
        if (isString(s)) {
          append(run, tok);
          done();
          continue;
        }
        flush();
      }

      if (run?.kind === "text") {
        if (isTagOpen(s, tok.text)) {
          // A tag ends a text node, also inside a hole.
          if (holeStart >= 0) abortHole();
          else flush();
        } else if (isString(s)) {
          if (nested) append(nested, tok);
          else nested = startString(tok);
          append(run, tok);
          done();
          continue;
        } else if (!isMarkupText(s) && !lineHasText && balance === 0) {
          // A hole that opens at the start of a line is structure, not a placeholder.
          flush();
        } else {
          flushNested();
          addToText(tok);
          done();
          continue;
        }
      }

      if (isString(s)) {
        run = startString(tok);
        done();
        continue;
      }

      // Markup structure.
      if (anyOf(s, TAG_PUNCT) && (tok.text.startsWith("<") || tok.text.endsWith(">"))) {
        if (tok.text.startsWith("<")) lastAttr = null;
        if (tok.text.endsWith(">")) inTag = false;
        done();
        continue;
      }
      if (anyOf(s, TAG_NAME)) {
        inTag = true;
        done();
        continue;
      }
      if (anyOf(s, ATTR_NAME)) {
        lastAttr = tok.text;
        done();
        continue;
      }

      // A text token or a hole opener between tags opens a text node, as in
      // `<p>{{ __('x') }} more</p>` or `<p>{" "}more</p>`. A hole closer such
      // as the `}` after `{cond && <b>x</b>}` does not.
      const insideTag = inTag && anyOf(s, IN_TAG);
      const opens = isMarkupText(s) || holeBalance(tok.text) > 0;
      if (!insideTag && opens && (markup || anyOf(s, TEXT_CONTAINER))) {
        run = { kind: "text", tokens: [], context: { parentRole: "markup_text", identifiers: [] } };
        addToText(tok);
        done();
        continue;
      }

      done();
    }
  }
  flush();
  return out.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
}

/**
 * The registry passes the language id as `kind`. The id is also the
 * `tm-grammars` grammar name. One extractor instance serves every grammar
 * language.
 */
export const grammarExtractor: LanguageExtractor = {
  extract: ({ source, kind }) => extractWithGrammar(source, kind),
};
