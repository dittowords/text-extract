import { extractWithGrammar } from "./grammar";

const extract = (source: string) => extractWithGrammar(source, "kotlin");

describe("grammar extractor: kotlin", () => {

  test("captures callee/calleeMember/methodName for known call shapes", async () => {
    const source = [
      `fun f() {`,
      `  println("a")`,
      `  Log.d(TAG, "b")`,
      `  AlertDialog.Builder(ctx).setTitle("c")`,
      `}`,
      ``,
    ].join("\n");
    const hits = await extract(source);
    const a = hits.find((h) => h.value === '"a"');
    const b = hits.find((h) => h.value === '"b"');
    const c = hits.find((h) => h.value === '"c"');
    expect(a?.context).toMatchObject({ parentRole: "other", callee: "println" });
    expect(b?.context).toMatchObject({ parentRole: "other", callee: "Log", calleeMember: "d", methodName: "d" });
    expect(c?.context).toMatchObject({ parentRole: "other", methodName: "setTitle" });
    expect(c?.context.callee).toBeUndefined();
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
