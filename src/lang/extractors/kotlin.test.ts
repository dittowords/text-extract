import { extractWithGrammar } from "./grammar";

const extract = (source: string) => extractWithGrammar(source, "kotlin");

describe("grammar extractor: kotlin", () => {

  test("emits every literal with its position, whatever call it sits in", async () => {
    const source = [
      `fun f() {`,
      `  println("a")`,
      `  Log.d(TAG, "b")`,
      `  AlertDialog.Builder(ctx).setTitle("c")`,
      `}`,
      ``,
    ].join("\n");
    const hits = await extract(source);
    expect(hits.map((h) => [h.value, h.location.line, h.context.parentRole])).toEqual([
      ['"a"', 2, "other"],
      ['"b"', 3, "other"],
      ['"c"', 4, "other"],
    ]);
  });
});

// From a pilot bug report: the escape shipped to users as the literal text `\n`.
describe("grammar extractor: kotlin escape decoding", () => {
  const extract = (source: string) => extractWithGrammar(source, "kotlin");

  it("decodes escapes in a Compose string", async () => {
    const hits = await extract(
      'fun S() { Text(text = "We need your phone number to provide\\nstatus updates") }'
    );
    expect(hits[0].value).toBe('"We need your phone number to provide\nstatus updates"');
  });

  // Raw strings don't process escapes, so a `\n` in one is two real characters.
  it("leaves a raw string's escapes alone", async () => {
    const hits = await extract('val s = """a\\nb"""');
    expect(hits[0].value).toBe('"""a\\nb"""');
  });
});
