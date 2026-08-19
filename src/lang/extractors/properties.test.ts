import { propertiesExtractor } from "./properties";

const extract = (source: string) => propertiesExtractor.extract({ source, kind: "properties" });

const textAt = (source: string, line: number, column: number) =>
  source.split("\n")[line - 1].slice(column - 1);

describe("propertiesExtractor locations", () => {
  test("points at the value, not the key", async () => {
    const source = "plain = Hi\n";
    const hits = await extract(source);

    expect(hits[0].location).toEqual({ line: 1, column: 9 });
    expect(textAt(source, 1, 9)).toBe(hits[0].snapshotText);
  });

  test("skips the separator's flanking whitespace", async () => {
    const source = "  spaced   :   Padded\n";
    const hits = await extract(source);

    expect(textAt(source, hits[0].location.line, hits[0].location.column)).toBe("Padded");
  });

  test("follows the value onto a later line when the key is continued", async () => {
    const source = "long\\\nkey = Value here\n";
    const hits = await extract(source);

    expect(hits[0].value).toBe("Value here");
    expect(hits[0].location).toEqual({ line: 2, column: 7 });
    expect(textAt(source, 2, 7)).toBe(hits[0].snapshotText);
  });

  test("starts at the value when the value itself is continued", async () => {
    const source = ["legal = First \\", "    second", ""].join("\n");
    const hits = await extract(source);

    expect(textAt(source, hits[0].location.line, hits[0].location.column)).toBe("First \\");
    expect(hits[0].snapshotText.startsWith("First \\")).toBe(true);
  });
});
