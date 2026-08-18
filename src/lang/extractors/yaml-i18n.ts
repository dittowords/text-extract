import { parseDocument } from "yaml";

import type { ExtractedHit, LanguageExtractor } from "../types";

// YAML i18n files — vue-i18n YAML mode, Rails `config/locales`, etc.
// Same conventions as the JSON i18n extractor: descend into maps, emit
// each leaf string keyed by its path. `item_one` / `item_other` style
// plural suffixes are split into `[base, variant]`. parseDocument is
// used (over yaml.parse) for source positions on each scalar.
//
// No content-shape gate — the walker only dispatches this on files the
// LLM has already confirmed.
export const yamlI18nExtractor: LanguageExtractor = {
  async extract({ source }) {
    let doc: ReturnType<typeof parseDocument>;
    try {
      doc = parseDocument(source);
    } catch {
      return [];
    }
    if (doc.errors && doc.errors.length > 0) return [];

    const contents = doc.contents as YamlNode | null;
    const out: ExtractedHit[] = [];
    walk(
      contents,
      [],
      { source, anchors: collectAnchors(contents, new Map()), resolving: new Set() },
      out,
    );
    return out;
  },
};

const PLURAL_SUFFIX_RE = /^(.+)_(zero|one|two|few|many|other)$/;

// Minimal shape of the `yaml` v1 nodes we touch — the package's own
// types pull in more than we need.
interface YamlScalar {
  value: unknown;
  // [start, value-end, node-end]. value-end stops before trailing comments
  // and blank lines; node-end includes them.
  range?: [number, number, number] | null;
}
interface YamlPair {
  key?: YamlScalar;
  value?: YamlNode;
}
interface YamlMap {
  items: YamlPair[];
}
interface YamlSeq {
  items: YamlNode[];
}
// `farewell: *hello` — carries the anchor name and a range, and no `value`
// at all. Merge keys (`<<: *defaults`) parse to the same node.
interface YamlAlias {
  source: string;
  range?: [number, number, number] | null;
}
type YamlNode = YamlScalar | YamlMap | YamlSeq | YamlAlias | null | undefined;

// The source region a hit reports when it was reached through an alias: the
// `*hello` reference itself, not the anchored text somewhere else in the file.
interface Region {
  start: number;
  end: number;
}

function isMap(node: YamlNode): node is YamlMap {
  return !!node && Array.isArray((node as YamlMap).items) && hasPairItems(node as YamlMap);
}

function isSeq(node: YamlNode): node is YamlSeq {
  if (!node || !Array.isArray((node as YamlSeq).items)) return false;
  const items = (node as YamlSeq).items;
  if (items.length === 0) return !hasPairItems(node as unknown as YamlMap);
  const first = items[0];
  return !(first !== null && typeof first === "object" && "key" in first);
}

function hasPairItems(node: YamlMap): boolean {
  // A YAMLSeq also has `.items`, but its items aren't pair-shaped.
  return (
    node.items.length === 0 ||
    (node.items[0] !== null && typeof node.items[0] === "object" && "key" in node.items[0])
  );
}

function isScalar(node: YamlNode): node is YamlScalar {
  return (
    !!node && typeof (node as YamlScalar).value !== "undefined" && !("items" in (node as object))
  );
}

/**
 * True for an alias node (`*hello`). A `Scalar` also carries a `source`
 * property — its raw text — so the absence of `value` is what separates the
 * two, and `items` rules out a map or sequence.
 */
function isAlias(node: YamlNode): node is YamlAlias {
  return (
    !!node &&
    typeof (node as YamlAlias).source === "string" &&
    typeof (node as YamlScalar).value === "undefined" &&
    !("items" in (node as object))
  );
}

/**
 * Every anchor in the document, keyed by name, so an alias can be resolved
 * without re-walking the tree for each one. Runs once before the main walk;
 * an anchor may be declared after the alias that uses it, so a single pass
 * that resolved lazily would miss those.
 */
function collectAnchors(node: YamlNode, into: Map<string, YamlNode>): Map<string, YamlNode> {
  if (!node || typeof node !== "object") return into;
  const anchor = (node as { anchor?: unknown }).anchor;
  if (typeof anchor === "string") into.set(anchor, node);
  if (isMap(node)) {
    for (const pair of node.items) {
      collectAnchors(pair.key as YamlNode, into);
      collectAnchors(pair.value, into);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) collectAnchors(item, into);
  }
  return into;
}

/**
 * The source region of the `*hello` reference itself. `null` when the parser
 * gave the node no range, in which case hits under it fall back to their own.
 */
function aliasRegion(node: YamlAlias): Region | null {
  return node.range ? { start: node.range[0], end: node.range[1] } : null;
}

interface WalkContext {
  source: string;
  anchors: Map<string, YamlNode>;
  // Anchor names currently being resolved, so `&a [*a]` can't recurse forever.
  resolving: Set<string>;
}

// `region` is set when this subtree was reached through an alias: every hit
// under it reports the alias reference as its source region and location.
function walk(
  node: YamlNode,
  path: string[],
  ctx: WalkContext,
  out: ExtractedHit[],
  region?: Region,
): void {
  if (!node) return;
  if (isAlias(node)) {
    walkAlias(node, path, ctx, out, region);
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (pair.key?.value === "<<") {
        // A merge key folds the anchored map's keys into this one, so its
        // leaves belong to the merging path — `page`, not `page.<<`.
        walkMerge(pair.value, path, ctx, out, region);
        continue;
      }
      if (!pair.key || typeof pair.key.value !== "string") continue;
      walk(pair.value, [...path, pair.key.value], ctx, out, region);
    }
    return;
  }
  if (isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      walk(node.items[i], [...path, String(i)], ctx, out, region);
    }
    return;
  }
  if (isScalar(node) && typeof node.value === "string") emitScalar(node, path, ctx, out, region);
  // Non-string scalars: not the leaf shape we emit on.
}

/**
 * Resolves an alias and walks the anchored node in its place, so the value
 * lands at the alias's key path rather than the anchor's. Returns without
 * emitting when the anchor is missing, or when it is already being resolved
 * further up the chain — `&r` containing `*r` would otherwise recurse forever.
 */
function walkAlias(
  node: YamlAlias,
  path: string[],
  ctx: WalkContext,
  out: ExtractedHit[],
  region?: Region,
): void {
  const target = ctx.anchors.get(node.source);
  if (!target || ctx.resolving.has(node.source)) return;
  ctx.resolving.add(node.source);
  // An alias nested under another alias keeps the outermost reference as its
  // region — that's the span actually written at this key path.
  walk(target, path, ctx, out, region ?? aliasRegion(node) ?? undefined);
  ctx.resolving.delete(node.source);
}

/**
 * Handles a merge key's value: `<<: *defaults`, or `<<: [*a, *b]` for several
 * maps merged at once. Each anchored map's leaves are walked under the merging
 * path, so `<<: *d` inside `page` yields `en.page.title`, not `en.page.<<`.
 */
function walkMerge(
  value: YamlNode,
  path: string[],
  ctx: WalkContext,
  out: ExtractedHit[],
  region?: Region,
): void {
  if (isSeq(value)) {
    for (const item of value.items) walkMerge(item, path, ctx, out, region);
    return;
  }
  if (isAlias(value)) walkAlias(value, path, ctx, out, region);
}

/**
 * Emits one `resource_value` hit for a string scalar. `region` overrides the
 * scalar's own range when it was reached through an alias, so the hit points
 * at the reference that produced it rather than at the shared anchor text.
 * Whitespace-only values are skipped.
 */
function emitScalar(
  node: YamlScalar,
  path: string[],
  ctx: WalkContext,
  out: ExtractedHit[],
  region?: Region,
): void {
  const value = node.value as string;
  if (value.trim().length === 0) return;
  let identifiers = path;
  if (path.length > 0) {
    const m = PLURAL_SUFFIX_RE.exec(path[path.length - 1]);
    if (m) identifiers = [...path.slice(0, -1), m[1], m[2]];
  }
  const start = region ? region.start : node.range ? node.range[0] : 0;
  const end = region ? region.end : node.range ? node.range[1] : null;
  const raw = end === null ? null : ctx.source.slice(start, end);
  out.push({
    value,
    location: offsetToLineCol(ctx.source, start),
    // The contiguous source region, block-scalar `|` header and per-line
    // indentation included. For a value reached through an alias that region
    // is the `*anchor` reference, which shares no text with the value.
    // Rewriting such a region safely is a write-path concern (DIT-13481),
    // not a reason to drop the span.
    snapshotText: raw ?? value,
    context: { parentRole: "resource_value", identifiers },
    // The literal key path — keeps the plural suffix ("item_one") that
    // `identifiers` splits into [base, variant].
    i18nKey: path.length > 0 ? path.join(".") : undefined,
  });
}

function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: Math.max(1, offset - lastNewline) };
}
