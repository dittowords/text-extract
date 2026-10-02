
import { extractWithGrammar } from "./grammar";

const extract = (source: string) => extractWithGrammar(source, "swift");

describe("grammar extractor: swift", () => {

  test("emits every literal in call expressions", async () => {
    const source = [`func f() {`, `  print("a")`, `  button.setTitle("b", for: .normal)`, `}`, ``].join("\n");
    const hits = await extract(source);
    expect(hits.map((h) => [h.value, h.location.line])).toEqual([
      ['"a"', 2],
      ['"b"', 3],
    ]);
  });
});

describe("grammar extractor: swift escape decoding", () => {
  test("decodes escapes", async () => {
    const hits = await extract(`let a = "line one\\nline two"\n`);
    expect(hits[0].value).toBe('"line one\nline two"');
  });

  // Raw strings (`#"..."#`) don't process escapes.
  test("leaves a raw string's escapes alone", async () => {
    const hits = await extract(`let a = #"a\\nb"#\n`);
    expect(hits[0].value).toBe('#"a\\nb"#');
  });
});
