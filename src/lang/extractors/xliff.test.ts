import { xliffExtractor } from "./xliff";

const extract = (source: string) => xliffExtractor.extract({ source, kind: "xml" });

const unit12 = (body: string) =>
  `<xliff version="1.2"><file><body><trans-unit id="k">\n${body}\n</trans-unit></body></file></xliff>`;

const unit20 = (body: string) =>
  `<xliff version="2.0"><file><unit id="k"><segment>\n${body}\n</segment></unit></file></xliff>`;

describe("xliffExtractor inline placeholders", () => {
  test.each([
    ["g", `<source>Hello <g id="n">%s</g></source>`, "Hello %s", `Hello <g id="n">%s</g>`],
    ["ph", `<source>Hello <ph id="n">%s</ph></source>`, "Hello %s", `Hello <ph id="n">%s</ph>`],
    ["x", `<source>Hello <x id="n"/> there</source>`, "Hello  there", `Hello <x id="n"/> there`],
    [
      "xliff:g",
      `<source>Hello <xliff:g id="n">%s</xliff:g></source>`,
      "Hello %s",
      `Hello <xliff:g id="n">%s</xliff:g>`,
    ],
  ])("1.2 source keeps a <%s> placeholder in the span", async (_name, body, value, snapshot) => {
    const source = unit12(body);
    const hits = await extract(source);

    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe(value);
    expect(hits[0].snapshotText).toBe(snapshot);
    expect(source.includes(hits[0].snapshotText)).toBe(true);
    expect(hits[0].context.identifiers).toEqual(["k", "source"]);
  });

  test("2.0 source keeps a placeholder in the span", async () => {
    const source = unit20(`<source>Hello <g id="n">%s</g></source>`);
    const hits = await extract(source);

    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("Hello %s");
    expect(hits[0].snapshotText).toBe(`Hello <g id="n">%s</g>`);
  });

  test("emits source and target once each, not twice", async () => {
    const hits = await extract(
      unit12(
        [
          `<source>Hello <g id="n">%s</g></source>`,
          `<target>Bonjour <g id="n">%s</g></target>`,
        ].join("\n"),
      ),
    );

    expect(hits.map((h) => h.value)).toEqual(["Hello %s", "Bonjour %s"]);
    expect(hits.map((h) => h.context.identifiers[1])).toEqual(["source", "target"]);
  });

  test("a CDATA source is recovered once by the CDATA sweep", async () => {
    const hits = await extract(unit12(`<source><![CDATA[Raw & <b>bold</b>]]></source>`));

    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe("Raw & <b>bold</b>");
  });

  test("a plain source is unaffected", async () => {
    const hits = await extract(unit12(`<source>Hello</source><target>Bonjour</target>`));

    expect(hits.map((h) => h.value)).toEqual(["Hello", "Bonjour"]);
    expect(hits[0].snapshotText).toBe("Hello");
  });

  test("an unclosed source is still dropped", async () => {
    const hits = await extract(unit12(`<source>Hello <g id="n">%s</g>`));

    expect(hits).toEqual([]);
  });
});
