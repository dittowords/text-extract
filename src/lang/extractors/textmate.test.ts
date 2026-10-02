import { extractWithGrammar } from "./textmate";

const values = (hits: { value: string }[]) => hits.map((h) => h.value);

describe("textmate extractor", () => {
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
    expect(hits[2].context).toMatchObject({ callee: "print", methodName: "print" });
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
    expect(hits[2].context.parentTag).toBe("b");
    expect(hits[3].context).toMatchObject({ callee: "t" });
  });

  test("kotlin: grammar without quote punctuation still yields clean values and callee", async () => {
    const hits = await extractWithGrammar(`fun f() { Log.d("tag", "msg $name") }\n`, "kotlin");
    expect(values(hits)).toEqual(['"tag"', '"msg $name"']);
    expect(hits[0].context).toMatchObject({ callee: "Log", calleeMember: "d", methodName: "d" });
  });

  test("blade: text node spans echo holes; the literal inside the hole is its own hit", async () => {
    const hits = await extractWithGrammar(`<p>{{ __('Hello') }}, {{ $user->name }}</p>\n<!-- "c" -->\n`, "blade");
    expect(values(hits)).toEqual(["{{ __('Hello') }}, {{ $user->name }}", "'Hello'"]);
    expect(hits[0].context).toMatchObject({ parentRole: "markup_text", parentTag: "p" });
  });

  test("svelte: text nodes with holes, script strings as other", async () => {
    const hits = await extractWithGrammar(`<p>Hello {name}</p>\n<script>let s = "str";</script>\n`, "svelte");
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ["Hello {name}", "markup_text"],
      ['"str"', "other"],
    ]);
  });

  test("django template as .html: block tags split text, variables are holes, trans strings are literals", async () => {
    const src = `{% block content %}\n<p>Hello {{ user.name }}, you have {% if n %}{{ n }} checks{% else %}none{% endif %}.</p>\n{% trans "Save changes" %}\n{% endblock %}\n`;
    const hits = await extractWithGrammar(src, "html");
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ["Hello {{ user.name }}, you have ", "markup_text"],
      ["{{ n }} checks", "markup_text"],
      ["none", "markup_text"],
      [".", "markup_text"],
      ['"Save changes"', "other"],
    ]);
  });
});
