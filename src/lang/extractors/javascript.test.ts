import { extractWithGrammar } from "./grammar";

const ts = { extract: ({ source }: { source: string; kind: string }) => extractWithGrammar(source, "typescript") };
const tsx = { extract: ({ source }: { source: string; kind: string }) => extractWithGrammar(source, "tsx") };

describe("grammar extractor: javascript", () => {
  test("every literal is a hit; import paths and call arguments are left to the classifier", async () => {
    const hits = await ts.extract({ source: `import x from "y";\nrequire("z");\nconsole.log("hi");\nt("welcome");\n`, kind: "typescript" });
    expect(hits.map((h) => [h.value, h.context])).toEqual([
      ['"y"', { parentRole: "other", identifiers: [] }],
      ['"z"', { parentRole: "other", identifiers: [] }],
      ['"hi"', { parentRole: "other", identifiers: [] }],
      ['"welcome"', { parentRole: "other", identifiers: [] }],
    ]);
  });

  test("emits jsx text as markup_text with its verbatim span", async () => {
    const hits = await tsx.extract({ source: `const e = <button>Save</button>;\n`, kind: "tsx" });
    expect(hits).toEqual([
      { value: "Save", snapshotText: "Save", location: { line: 1, column: 19 }, context: { parentRole: "markup_text", identifiers: [] } },
    ]);
  });

  test("emits JSX attribute string as markup_attr with attribute name in identifiers", async () => {
    const hits = await tsx.extract({ source: `const e = <input placeholder="Email" />;\n`, kind: "tsx" });
    const email = hits.find((h) => h.value === '"Email"');
    expect(email?.context.parentRole).toBe("markup_attr");
    expect(email?.context.identifiers).toEqual(["placeholder"]);
  });

  test("text inside <pre> is still a hit; the classifier reads the tag from the source", async () => {
    const hits = await tsx.extract({ source: `const e = <pre><span>npm install</span></pre>;\n`, kind: "tsx" });
    expect(hits.map((h) => h.value)).toEqual(["npm install"]);
  });
});

// Escapes are decoded for real JS literals only. Getting this wrong either ships
// a literal `\n` to users or mangles JSX text, so each branch is pinned.
describe("grammar extractor: javascript escape decoding", () => {
  test("decodes escapes in a plain string literal", async () => {
    const hits = await ts.extract({ source: `const m = "line one\\nline two";\n`, kind: "typescript" });
    expect(hits[0].value).toBe('"line one\nline two"');
  });

  test("decodes escapes in a template literal", async () => {
    const hits = await ts.extract({ source: "const m = `line one\\nline two`;\n", kind: "typescript" });
    expect(hits[0].value).toBe("`line one\nline two`");
  });

  test("leaves jsx text alone — a backslash there is two literal characters", async () => {
    const hits = await tsx.extract({ source: `const C = () => <p>line one\\nline two</p>;\n`, kind: "tsx" });
    expect(hits.find((h) => h.context.parentRole === "markup_text")?.value).toBe("line one\\nline two");
  });

  test("leaves a bare jsx attribute alone but decodes the braced form", async () => {
    const bare = await tsx.extract({ source: `const C = () => <input placeholder="a\\nb" />;\n`, kind: "tsx" });
    expect(bare[0].value).toBe('"a\\nb"');
    const braced = await tsx.extract({ source: `const C = () => <input placeholder={"a\\nb"} />;\n`, kind: "tsx" });
    expect(braced[0].value).toBe('"a\nb"');
  });

  test("does not convert format specifiers — a bare %s in JS is usually copy", async () => {
    const hits = await ts.extract({ source: `const m = "Battery at %s";\n`, kind: "typescript" });
    expect(hits[0].value).toBe('"Battery at %s"');
  });
});
