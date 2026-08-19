import { poExtractor } from "./po";

const extract = (source: string) => poExtractor.extract({ source, kind: "po" });

describe("poExtractor", () => {
  test("emits msgstr when present, falls back to msgid when empty", async () => {
    const source = [
      `msgid ""`,
      `msgstr ""`,
      ``,
      `msgid "Hello"`,
      `msgstr "Bonjour"`,
      ``,
      `msgid "Goodbye"`,
      `msgstr ""`,
      ``,
    ].join("\n");
    const hits = await extract(source);
    expect(hits).toHaveLength(2);
    expect(hits[0].value).toBe("Bonjour");
    expect(hits[0].context.identifiers).toEqual(["Hello"]);
    expect(hits[1].value).toBe("Goodbye");
    expect(hits[1].context.identifiers).toEqual(["Goodbye"]);
    expect(hits[0].context.parentRole).toBe("resource_value");
  });

  test("skips the empty header entry", async () => {
    const hits = await extract(`msgid ""\nmsgstr "Content-Type: text/plain"\n`);
    expect(hits).toEqual([]);
  });

  test("emits one hit per plural index, tagged plural:N", async () => {
    const source = [
      `msgid "%d item"`,
      `msgid_plural "%d items"`,
      `msgstr[0] "%d item"`,
      `msgstr[1] "%d items"`,
      ``,
    ].join("\n");
    const hits = await extract(source);
    expect(hits).toHaveLength(2);
    expect(hits[0].value).toBe("%d item");
    expect(hits[0].context.identifiers).toEqual(["%d item", "plural:0"]);
    expect(hits[1].value).toBe("%d items");
    expect(hits[1].context.identifiers).toEqual(["%d item", "plural:1"]);
  });

  test("includes msgctxt as the first identifier when present", async () => {
    const source = [`msgctxt "menu"`, `msgid "File"`, `msgstr "Fichier"`, ``].join("\n");
    const hits = await extract(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].context.identifiers).toEqual(["menu", "File"]);
  });

  test("concatenates continuation lines", async () => {
    const source = [`msgid "Hello, "`, `"world"`, `msgstr "Bonjour, "`, `"le monde"`, ``].join(
      "\n",
    );
    const hits = await extract(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("Bonjour, le monde");
    expect(hits[0].context.identifiers).toEqual(["Hello, world"]);
  });

  test("locates a hit on the line its value is written on", async () => {
    const source = [
      `msgid "unread_one"`,
      `msgid_plural "unread_many"`,
      `msgstr[0] "1 unread message"`,
      `msgstr[1] "%d unread messages"`,
      ``,
    ].join("\n");
    const hits = await extract(source);

    expect(hits.map((h) => [h.value, h.location.line])).toEqual([
      ["1 unread message", 3],
      ["%d unread messages", 4],
    ]);
    for (const hit of hits) {
      expect(source.split("\n")[hit.location.line - 1]).toContain(hit.snapshotText);
    }
  });

  test("locates a stitched value on the line its chunk group starts", async () => {
    const source = [`msgid "greeting"`, `msgstr ""`, `"Welcome back, "`, `"friend"`, ``].join("\n");
    const hits = await extract(source);

    expect(hits[0].value).toBe("Welcome back, friend");
    expect(hits[0].location.line).toBe(2);
  });

  test("ignores PO comments", async () => {
    const source = [
      `# translator comment`,
      `#. extracted`,
      `msgid "Save"`,
      `msgstr "Save"`,
      ``,
    ].join("\n");
    const hits = await extract(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("Save");
  });
});

describe("poExtractor locations", () => {
  const textAt = (source: string, line: number, column: number) =>
    source.split("\n")[line - 1].slice(column - 1);

  test("points at the opening quote of the value, not the keyword", async () => {
    const source = [`msgid "greeting"`, `msgstr "Bonjour"`, ``].join("\n");
    const hits = await extract(source);

    expect(hits[0].location).toEqual({ line: 2, column: 8 });
    expect(textAt(source, 2, 8)).toBe(hits[0].snapshotText);
  });

  test("gives each plural form the column of its own msgstr line", async () => {
    const source = [
      `msgid "unread_one"`,
      `msgid_plural "unread_many"`,
      `msgstr[0] "1 unread message"`,
      `msgstr[1] "%d unread messages"`,
      ``,
    ].join("\n");
    const hits = await extract(source);

    expect(hits.map((h) => h.location)).toEqual([
      { line: 3, column: 11 },
      { line: 4, column: 11 },
    ]);
    for (const hit of hits) {
      expect(textAt(source, hit.location.line, hit.location.column)).toBe(hit.snapshotText);
    }
  });

  test("points at the first quote of a stitched multi-line value", async () => {
    const source = [`msgid "multi"`, `msgstr ""`, `"Hello, "`, `"world"`, ``].join("\n");
    const hits = await extract(source);

    expect(hits[0].location).toEqual({ line: 2, column: 8 });
    expect(hits[0].snapshotText.startsWith(textAt(source, 2, 8))).toBe(true);
  });
});
