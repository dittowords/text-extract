import { yamlI18nExtractor } from "./yaml-i18n";

const extract = (source: string) => yamlI18nExtractor.extract({ source, kind: "yaml_i18n" });

describe("yamlI18nExtractor", () => {
  test("walks nested maps and emits each leaf string", async () => {
    const source = [`en:`, `  greetings:`, `    hello: Hello`, `    bye: Goodbye`, ``].join("\n");
    const hits = await extract(source);
    expect(hits.map((h) => ({ v: h.value, ids: h.context.identifiers }))).toEqual([
      { v: "Hello", ids: ["en", "greetings", "hello"] },
      { v: "Goodbye", ids: ["en", "greetings", "bye"] },
    ]);
    expect(hits.every((h) => h.context.parentRole === "resource_value")).toBe(true);
  });

  test("indexes sequence items numerically", async () => {
    const source = [`en:`, `  planets:`, `    - Mercury`, `    - Venus`, ``].join("\n");
    const hits = await extract(source);
    expect(hits.map((h) => h.context.identifiers)).toEqual([
      ["en", "planets", "0"],
      ["en", "planets", "1"],
    ]);
  });

  test("splits `_one` / `_other` plural suffix in the trailing key", async () => {
    const source = [`en:`, `  item_one: "1 item"`, `  item_other: "{count} items"`, ``].join("\n");
    const hits = await extract(source);
    expect(hits.map((h) => h.context.identifiers)).toEqual([
      ["en", "item", "one"],
      ["en", "item", "other"],
    ]);
  });

  test("skips empty and non-string scalars", async () => {
    const source = [`en:`, `  count: 5`, `  ok: true`, `  blank: " "`, `  msg: real`, ``].join("\n");
    const hits = await extract(source);
    expect(hits.map((h) => h.value)).toEqual(["real"]);
  });

  test("returns empty array on a YAML parse error", async () => {
    const source = `: this is\n  : invalid\n  :: yaml`;
    const hits = await extract(source);
    expect(hits).toEqual([]);
  });
});

describe("yamlI18nExtractor aliases", () => {
  const summarize = (hits: Awaited<ReturnType<typeof extract>>) =>
    hits.map((h) => ({ k: h.i18nKey, v: h.value, s: h.snapshotText }));

  test("an alias emits the anchored value with the reference as its span", async () => {
    const source = [`en:`, `  greeting: &hello Hello there`, `  farewell: *hello`, ``].join("\n");
    const hits = await extract(source);

    expect(summarize(hits)).toEqual([
      { k: "en.greeting", v: "Hello there", s: "Hello there" },
      { k: "en.farewell", v: "Hello there", s: "*hello" },
    ]);
    expect(hits.every((h) => source.includes(h.snapshotText))).toBe(true);
  });

  test("an alias reports the line it is written on, not the anchor's", async () => {
    const source = [`en:`, `  greeting: &hello Hello there`, `  farewell: *hello`, ``].join("\n");
    const hits = await extract(source);

    expect(hits.map((h) => h.location.line)).toEqual([2, 3]);
  });

  test("a merge key folds the anchored map into the merging path", async () => {
    const source = [
      `en:`,
      `  defaults: &d`,
      `    title: Welcome`,
      `  page:`,
      `    <<: *d`,
      `    body: Some body`,
      ``,
    ].join("\n");
    const hits = await extract(source);

    expect(summarize(hits)).toEqual([
      { k: "en.defaults.title", v: "Welcome", s: "Welcome" },
      { k: "en.page.title", v: "Welcome", s: "*d" },
      { k: "en.page.body", v: "Some body", s: "Some body" },
    ]);
  });

  test("a merge key takes a list of anchors", async () => {
    const source = [
      `en:`,
      `  d1: &a`,
      `    x: One`,
      `  d2: &b`,
      `    y: Two`,
      `  p:`,
      `    <<: [*a, *b]`,
      ``,
    ].join("\n");
    const hits = await extract(source);

    expect(summarize(hits).slice(2)).toEqual([
      { k: "en.p.x", v: "One", s: "*a" },
      { k: "en.p.y", v: "Two", s: "*b" },
    ]);
  });

  test("an aliased sequence item is indexed like any other", async () => {
    const source = [`en:`, `  a: &h Hi`, `  list:`, `    - *h`, `    - Plain`, ``].join("\n");
    const hits = await extract(source);

    expect(summarize(hits).slice(1)).toEqual([
      { k: "en.list.0", v: "Hi", s: "*h" },
      { k: "en.list.1", v: "Plain", s: "Plain" },
    ]);
  });

  test("an alias to a missing anchor is skipped", async () => {
    const hits = await extract([`en:`, `  a: *missing`, `  b: Text`, ``].join("\n"));

    expect(summarize(hits)).toEqual([{ k: "en.b", v: "Text", s: "Text" }]);
  });

  test("a self-referential anchor terminates", async () => {
    const hits = await extract([`en: &r`, `  self: *r`, `  t: Text`, ``].join("\n"));

    expect(summarize(hits)).toEqual([
      { k: "en.self.t", v: "Text", s: "*r" },
      { k: "en.t", v: "Text", s: "Text" },
    ]);
  });
});
