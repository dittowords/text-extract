import { extractWithGrammar } from "./grammar";


const extract = (source: string) => extractWithGrammar(source, "vue");

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
    const hits = await extract(source);

    const hello = hits.find((h) => h.value.trim() === "Hello world");
    expect(hello?.context).toEqual({ parentRole: "markup_text", identifiers: [] });

    const fromScript = hits.find((h) => h.value === '"Hi from script"');
    expect(fromScript?.context.parentRole).toBe("other");
  });

  test("script positions are reported against the original .vue file", async () => {
    const source = [`<template><p>Hi</p></template>`, `<script>`, `const s = "row2";`, `</script>`, ``].join("\n");
    const hits = await extract(source);
    const fromScript = hits.find((h) => h.value === '"row2"');
    expect(fromScript?.location.line).toBe(3);
  });

  test("<style> literals are hits; CSS `content` can be copy", async () => {
    const source = [`<template><p>Visible</p></template>`, `<style>.x::after { content: "hidden"; }</style>`, ``].join(
      "\n"
    );
    const hits = await extract(source);
    expect(hits.map((h) => h.value)).toEqual(["Visible", '"hidden"']);
  });

  test("a literal inside a bound attribute is an attribute hit", async () => {
    const hits = await extract(`<template><Btn :label="'Save now'" @click="go('x')">Hi</Btn></template>\n`);
    expect(hits.map((h) => [h.value, h.context.parentRole, h.context.identifiers])).toEqual([
      ["'Save now'", "markup_attr", ["label"]],
      ["x", "markup_attr", ["click"]],
      ["Hi", "markup_text", []],
    ]);
  });

  test("returns empty array for an empty SFC", async () => {
    const hits = await extract(`<template></template>\n<script></script>\n`);
    expect(hits).toEqual([]);
  });
});
