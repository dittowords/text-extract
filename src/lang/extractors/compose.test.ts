import { extractWithGrammar } from "./textmate";
import { composeHits, placeholderName } from "./compose";

const run = async (src: string, lang: string) => composeHits(await extractWithGrammar(src, lang), src);
const values = (hits: { value: string }[]) => hits.map((h) => h.value);

describe("composer", () => {
  test("jsx text across inline elements and {\" \"} becomes one sentence", async () => {
    const src = `<p>\n  Read the full license terms on{" "}\n  <Anchor href="x">GitHub</Anchor>. Then{" "}\n  <b>relax</b>.\n</p>\n`;
    const hits = await run(src, "tsx");
    const text = hits.filter((h) => h.context.parentRole === "markup_text");
    expect(values(text)).toEqual(["Read the full license terms on GitHub. Then relax."]);
    expect(text[0].snapshotText.startsWith("\n  Read the full")).toBe(true);
    const literals = text[0].pieces?.filter((p) => p.kind === "literal").map((p) => p.text.trim()).filter(Boolean);
    expect(literals).toEqual(["Read the full license terms on", "GitHub", ". Then", "relax", "."]);
  });

  test("a sentence boundary stops the join", async () => {
    const src = `<p>First sentence.</p><p>Second one.</p>\n`;
    const hits = await run(src, "html");
    expect(values(hits)).toEqual(["First sentence.", "Second one."]);
  });

  test("jsx holes render as named placeholders; string holes inline", async () => {
    const hits = await run(`<p>Hello {user.firstName}, you have {count} {"items"}</p>\n`, "tsx");
    expect(values(hits.filter((h) => h.context.parentRole === "markup_text"))).toEqual([
      "Hello {{firstName}}, you have {{count}} items",
    ]);
  });

  test("concatenation with operands between and around", async () => {
    const hits = await run(`const a = "Hello " + name + ", you have " + items.length + " items";\nconst b = prefix + "!";\n`, "typescript");
    expect(values(hits)).toEqual(["Hello {{name}}, you have {{length}} items", "{{prefix}}!"]);
    expect(hits[0].snapshotText).toBe(`"Hello " + name + ", you have " + items.length + " items"`);
    expect(hits[0].pieces?.map((p) => p.kind)).toEqual(["literal", "placeholder", "literal", "placeholder", "literal"]);
  });

  test("plain literals and non-concat neighbours pass through untouched", async () => {
    const hits = await run(`f("a", "b");\nconst t = \`Hi \${name}\`;\n`, "typescript");
    expect(values(hits)).toEqual(['"a"', '"b"', "`Hi ${name}`"]);
    expect(hits.every((h) => !h.pieces)).toBe(true);
  });

  test("django: {% %} is a boundary, {{ }} is a hole", async () => {
    const hits = await run(`<p>Hello {{ user.name|title }}, {% if n %}{{ n }} checks{% endif %}</p>\n`, "html");
    expect(values(hits)).toEqual(["Hello {{name}},", "{{n}} checks"]);
  });

  test("placeholder names", () => {
    const taken = new Set<string>();
    expect(placeholderName("user.firstName", taken)).toBe("firstName");
    expect(placeholderName("items.length", taken)).toBe("length");
    expect(placeholderName("firstName", taken)).toBe("firstName2");
    expect(placeholderName("1 + 2", taken)).toBe("value");
  });
});
