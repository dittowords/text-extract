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
    walk(contents, [], { source, doc, resolving: new Set() }, out);
    return out;
  },
};

const MERGE_KEY = "<<";

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
interface YamlAlias {
  source: string;
  range?: [number, number, number] | null;
  // Asks the parser which anchor this points at. The same anchor name can be
  // declared more than once, and an alias uses whichever came last before it,
  // so we can't just look the name up in a map.
  resolve(doc: unknown): YamlNode;
}
type YamlNode = YamlScalar | YamlMap | YamlSeq | YamlAlias | null | undefined;

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

// A plain scalar has a `source` property too, so what sets an alias apart is
// that it has no `value`.
function isAlias(node: YamlNode): node is YamlAlias {
  return (
    !!node &&
    typeof (node as YamlAlias).source === "string" &&
    typeof (node as YamlScalar).value === "undefined" &&
    !("items" in (node as object))
  );
}

function aliasRegion(node: YamlAlias): Region | null {
  return node.range ? { start: node.range[0], end: node.range[1] } : null;
}

interface WalkContext {
  source: string;
  doc: unknown;
  // Anchor names currently being resolved, so `&a [*a]` can't recurse forever.
  resolving: Set<string>;
}

/**
 * Descends one node, appending a hit for every string leaf under it. `path` is
 * the key path so far, which becomes the hit's `i18n_key`: map keys by name,
 * sequence items by index. Non-string scalars are not a shape we emit on.
 *
 * `region` is set when this subtree was reached through an alias, and makes
 * every hit under it report that reference as its span and location instead of
 * its own.
 */
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
    // When the same key arrives twice, YAML keeps one of them: a key written
    // out here beats one pulled in by `<<`, and an earlier `<<` beats a later
    // one. The winner replaces the other outright, it doesn't merge with it.
    const taken = new Set<string>();
    for (const pair of node.items) {
      const key = pair.key?.value;
      if (typeof key === "string" && key !== MERGE_KEY) taken.add(key);
    }
    for (const pair of node.items) {
      if (pair.key?.value === MERGE_KEY) {
        walkMerge(pair.value, path, ctx, out, taken, region);
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
 *
 * The parser picks the anchor, which matters when a name is declared twice:
 * an alias reads the last declaration above it, not the last in the file.
 *
 * Values under the anchor report the alias as their region, since that's what
 * is written at this key. An alias reached through another keeps the outer
 * one's region.
 */
function walkAlias(
  node: YamlAlias,
  path: string[],
  ctx: WalkContext,
  out: ExtractedHit[],
  region?: Region,
): void {
  const target = node.resolve(ctx.doc);
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
 *
 * `taken` is every key the merging map has already got — the ones written out
 * in it, plus whatever an earlier anchor in a `<<` list supplied. Keys already
 * in there are skipped, and the ones taken here are added to it, so a list is
 * resolved left to right and the same winner YAML would pick is the one that
 * survives. It's mutated, and shared across the whole map's merges.
 *
 * Does nothing for an anchor that's missing, doesn't point at a map, or is
 * already being walked further up. A merged map may itself merge another.
 */
function walkMerge(
  value: YamlNode,
  path: string[],
  ctx: WalkContext,
  out: ExtractedHit[],
  taken: Set<string>,
  region?: Region,
): void {
  if (isSeq(value)) {
    for (const item of value.items) walkMerge(item, path, ctx, out, taken, region);
    return;
  }
  if (!isAlias(value)) return;
  const target = value.resolve(ctx.doc);
  if (!isMap(target) || ctx.resolving.has(value.source)) return;
  ctx.resolving.add(value.source);
  const mergeRegion = region ?? aliasRegion(value) ?? undefined;
  for (const pair of target.items) {
    const key = pair.key?.value;
    if (typeof key !== "string") continue;
    if (key === MERGE_KEY) {
      walkMerge(pair.value, path, ctx, out, taken, mergeRegion);
      continue;
    }
    if (taken.has(key)) continue;
    taken.add(key);
    walk(pair.value, [...path, key], ctx, out, mergeRegion);
  }
  ctx.resolving.delete(value.source);
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
