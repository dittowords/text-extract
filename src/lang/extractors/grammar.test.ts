import { extractWithGrammar } from "./grammar";

const values = (hits: { value: string }[]) => hits.map((h) => h.value);

describe("grammar extractor", () => {
  test("python: skips comments, keeps f-string holes and multi-line strings", async () => {
    const hits = await extractWithGrammar(
      ['# "not a string"', 'msg = f"Hello {name}, you have {n} items"', 'x = """multi', 'line "quoted" text"""', "print('done')", ""].join(
        "\n"
      ),
      "python"
    );
    expect(values(hits)).toEqual(['f"Hello {name}, you have {n} items"', '"""multi\nline "quoted" text"""', "'done'"]);
    expect(hits[0].location).toEqual({ line: 2, column: 7 });
    expect(hits[1].location).toEqual({ line: 3, column: 5 });
    expect(hits[2].context).toEqual({ parentRole: "other", identifiers: [] });
  });

  test("tsx: jsx text keeps its holes, hole-only nodes are dropped, strings in holes are emitted", async () => {
    const src = `return <p className="c">Save your {count} changes <b>now</b> {t("k")}</p>;\n`;
    const hits = await extractWithGrammar(src, "tsx");
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ['"c"', "markup_attr"],
      ["Save your {count} changes ", "markup_text"],
      ["now", "markup_text"],
      ['"k"', "other"],
    ]);
    expect(hits[0].context.identifiers).toEqual(["classname"]);
    expect(hits[3].context).toEqual({ parentRole: "other", identifiers: [] });
  });

  test("kotlin: grammar without quote punctuation still yields clean values", async () => {
    const hits = await extractWithGrammar(`fun f() { Log.d("tag", "msg $name") }\n`, "kotlin");
    expect(values(hits)).toEqual(['"tag"', '"msg $name"']);
  });

  test("blade: text node spans echo holes; the literal inside the hole is its own hit", async () => {
    const hits = await extractWithGrammar(`<p>{{ __('Hello') }}, {{ $user->name }}</p>\n<!-- "c" -->\n`, "blade");
    expect(values(hits)).toEqual(["{{ __('Hello') }}, {{ $user->name }}", "'Hello'"]);
    expect(hits[0].context).toEqual({ parentRole: "markup_text", identifiers: [] });
  });

  test("svelte: text nodes with holes, script strings as other", async () => {
    const hits = await extractWithGrammar(`<p>Hello {name}</p>\n<script>let s = "str";</script>\n`, "svelte");
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ["Hello {name}", "markup_text"],
      ['"str"', "other"],
    ]);
  });

  test("django template as .html: a text node runs from tag to tag, block tags included; trans strings are literals", async () => {
    const src = `{% block content %}\n<p>Hello {{ user.name }}, you have {% if n %}{{ n }} checks{% else %}none{% endif %}.</p>\n{% trans "Save changes" %}\n{% endblock %}\n`;
    const hits = await extractWithGrammar(src, "html");
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ["Hello {{ user.name }}, you have {% if n %}{{ n }} checks{% else %}none{% endif %}.", "markup_text"],
      ['"Save changes"', "other"],
    ]);
  });
});

const html = (source: string) => extractWithGrammar(source, "html");

describe("grammar extractor: html", () => {
  test("emits element text as markup_text with its span", async () => {
    const hits = await html(`<p>Welcome home</p>\n`);
    expect(hits).toEqual([
      { value: "Welcome home", snapshotText: "Welcome home", location: { line: 1, column: 4 }, context: { parentRole: "markup_text", identifiers: [] } },
    ]);
  });

  test("emits plain attribute values as markup_attr with attribute name", async () => {
    const hits = await html(`<input placeholder="Email" type="text" />\n`);
    expect(hits.map((h) => [h.value, h.context.identifiers])).toEqual([
      ["Email", ["placeholder"]],
      ["text", ["type"]],
    ]);
  });

  test("<script> and <style> literals are hits too; the classifier decides", async () => {
    const hits = await html(`<style>body { color: "red"; }</style>\n<script>const msg = "Hi";</script>\n<p>Real copy</p>\n`);
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ['"red"', "other"],
      ['"Hi"', "other"],
      ["Real copy", "markup_text"],
    ]);
  });

  test("directive attribute values are attribute hits under the directive's name", async () => {
    const hits = await html(`<button @click="onClick" :class="cls">Go</button>\n`);
    expect(hits.map((h) => [h.value, h.context.parentRole, h.context.identifiers])).toEqual([
      ["onClick", "markup_attr", ["@click"]],
      ["cls", "markup_attr", [":class"]],
      ["Go", "markup_text", []],
    ]);
  });

  test("a template hole in plain .html is tokenized by the template grammar, so its literals are hits", async () => {
    const hits = await html(`<p>{{ isFollowing ? 'Unfollow' : 'Follow' }}</p>\n`);
    // The text node is holes only, so it has no copy.
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ["'Unfollow'", "other"],
      ["'Follow'", "other"],
    ]);
  });
});

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

  test("a JSX spacer hole opens the text node it belongs to; its literal is also its own hit", async () => {
    const hits = await tsx.extract({ source: `const e = <p><a>docs</a>{" "}and more</p>;\n`, kind: "tsx" });
    expect(hits.map((h) => [h.value, h.location.column, h.context.parentRole])).toEqual([
      ["docs", 17, "markup_text"],
      ['{" "}and more', 25, "markup_text"],
      ['" "', 26, "other"],
    ]);
  });

  test("text inside <pre> is still a hit; the classifier reads the tag from the source", async () => {
    const hits = await tsx.extract({ source: `const e = <pre><span>npm install</span></pre>;\n`, kind: "tsx" });
    expect(hits.map((h) => h.value)).toEqual(["npm install"]);
  });
});

// Escapes are decoded in JS literals only. A mistake here either shows a
// literal `\n` to users or corrupts JSX text. Each branch has a test.
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

const kotlin = (source: string) => extractWithGrammar(source, "kotlin");

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
    const hits = await kotlin(source);
    expect(hits.map((h) => [h.value, h.location.line, h.context.parentRole])).toEqual([
      ['"a"', 2, "other"],
      ['"b"', 3, "other"],
      ['"c"', 4, "other"],
    ]);
  });
});

// From a pilot bug report: users saw the literal text `\n`.
describe("grammar extractor: kotlin escape decoding", () => {
  const kotlin = (source: string) => extractWithGrammar(source, "kotlin");

  it("decodes escapes in a Compose string", async () => {
    const hits = await kotlin(
      'fun S() { Text(text = "We need your phone number to provide\\nstatus updates") }'
    );
    expect(hits[0].value).toBe('"We need your phone number to provide\nstatus updates"');
  });

  // A raw string has no escapes. A `\n` in one is two characters.
  it("leaves a raw string's escapes alone", async () => {
    const hits = await kotlin('val s = """a\\nb"""');
    expect(hits[0].value).toBe('"""a\\nb"""');
  });
});

const swift = (source: string) => extractWithGrammar(source, "swift");

describe("grammar extractor: swift", () => {

  test("emits every literal in call expressions", async () => {
    const source = [`func f() {`, `  print("a")`, `  button.setTitle("b", for: .normal)`, `}`, ``].join("\n");
    const hits = await swift(source);
    expect(hits.map((h) => [h.value, h.location.line])).toEqual([
      ['"a"', 2],
      ['"b"', 3],
    ]);
  });
});

describe("grammar extractor: swift escape decoding", () => {
  test("decodes escapes", async () => {
    const hits = await swift(`let a = "line one\\nline two"\n`);
    expect(hits[0].value).toBe('"line one\nline two"');
  });

  // A raw string (`#"..."#`) has no escapes.
  test("leaves a raw string's escapes alone", async () => {
    const hits = await swift(`let a = #"a\\nb"#\n`);
    expect(hits[0].value).toBe('#"a\\nb"#');
  });
});

const vue = (source: string) => extractWithGrammar(source, "vue");

describe("grammar extractor: vue", () => {
  test("emits template text as markup_text and script literals as other", async () => {
    const source = [
      `<template>`,
      `  <p>Hello world</p>`,
      `</template>`,
      `<script lang="ts">`,
      `  const greeting = "Hi from script";`,
      `</script>`,
      ``,
    ].join("\n");
    const hits = await vue(source);

    const hello = hits.find((h) => h.value.trim() === "Hello world");
    expect(hello?.context).toEqual({ parentRole: "markup_text", identifiers: [] });

    const fromScript = hits.find((h) => h.value === '"Hi from script"');
    expect(fromScript?.context.parentRole).toBe("other");
  });

  test("script positions are reported against the original .vue file", async () => {
    const source = [`<template><p>Hi</p></template>`, `<script>`, `const s = "row2";`, `</script>`, ``].join("\n");
    const hits = await vue(source);
    const fromScript = hits.find((h) => h.value === '"row2"');
    expect(fromScript?.location.line).toBe(3);
  });

  test("<style> literals are hits; CSS `content` can be copy", async () => {
    const source = [`<template><p>Visible</p></template>`, `<style>.x::after { content: "hidden"; }</style>`, ``].join(
      "\n"
    );
    const hits = await vue(source);
    expect(hits.map((h) => h.value)).toEqual(["Visible", '"hidden"']);
  });

  test("a literal inside a bound attribute is an attribute hit", async () => {
    const hits = await vue(`<template><Btn :label="'Save now'" @click="go('x')">Hi</Btn></template>\n`);
    expect(hits.map((h) => [h.value, h.context.parentRole, h.context.identifiers])).toEqual([
      ["'Save now'", "markup_attr", ["label"]],
      ["x", "markup_attr", ["click"]],
      ["Hi", "markup_text", []],
    ]);
  });

  test("returns empty array for an empty SFC", async () => {
    const hits = await vue(`<template></template>\n<script></script>\n`);
    expect(hits).toEqual([]);
  });
});

// Hole edges in a text node. Each case was a wrong span before the fix.
describe("grammar extractor: text node holes", () => {
  test("a hole closer after a nested element does not open a text node", async () => {
    const hits = await extractWithGrammar(`<div>Hi <Btn icon={<Icon />} /> there</div>;\n`, "tsx");
    expect(values(hits)).toEqual(["Hi ", " there"]);
    const cond = await extractWithGrammar(`<p>Hi {cond && <b>x</b>} there</p>;\n`, "tsx");
    expect(values(cond)).toEqual(["Hi ", "x", " there"]);
  });

  test("a brace inside a literal in a hole does not count toward the hole", async () => {
    const hits = await extractWithGrammar(`<p>{cond ? "{" : "x"} more</p>;\n`, "tsx");
    expect(values(hits)).toEqual([`{cond ? "{" : "x"} more`, `"{"`, `"x"`]);
  });

  test("a comment in a hole ends the text node before the hole", async () => {
    const hits = await extractWithGrammar(`<p>Hello {/* c */} world</p>;\n`, "tsx");
    expect(values(hits)).toEqual(["Hello ", " world"]);
  });

  test("an unbalanced one-line hole is linear in its length", async () => {
    const src = `<script>function f() {${"a();".repeat(20000)}}</script>\n`;
    const started = Date.now();
    await extractWithGrammar(src, "html");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("grammar extractor: line endings", () => {
  test("a multi-line hit in a CRLF file has a snapshot that matches the source", async () => {
    const src = `const b = <p>\r\n  Two\r\n</p>;\r\nconst s = "a\\\r\nb";\r\n`;
    const hits = await extractWithGrammar(src, "tsx");
    const lineStarts = [0, ...[...src.matchAll(/\n/g)].map((m) => m.index! + 1)];
    for (const h of hits) {
      const at = lineStarts[h.location.line - 1] + h.location.column - 1;
      expect(src.slice(at, at + h.snapshotText.length)).toBe(h.snapshotText);
    }
    expect(hits.map((h) => h.snapshotText)).toEqual(["\r\n  Two", '"a\\\r\nb"']);
  });
});
