import { extractWithGrammar } from "./grammar";

const extract = (source: string) => extractWithGrammar(source, "html");

describe("grammar extractor: html", () => {
  test("emits element text as markup_text with its span", async () => {
    const hits = await extract(`<p>Welcome home</p>\n`);
    expect(hits).toEqual([
      { value: "Welcome home", snapshotText: "Welcome home", location: { line: 1, column: 4 }, context: { parentRole: "markup_text", identifiers: [] } },
    ]);
  });

  test("emits plain attribute values as markup_attr with attribute name", async () => {
    const hits = await extract(`<input placeholder="Email" type="text" />\n`);
    expect(hits.map((h) => [h.value, h.context.identifiers])).toEqual([
      ["Email", ["placeholder"]],
      ["text", ["type"]],
    ]);
  });

  test("<script> and <style> literals are hits too; the classifier decides", async () => {
    const hits = await extract(`<style>body { color: "red"; }</style>\n<script>const msg = "Hi";</script>\n<p>Real copy</p>\n`);
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ['"red"', "other"],
      ['"Hi"', "other"],
      ["Real copy", "markup_text"],
    ]);
  });

  test("directive attribute values are attribute hits under the directive's name", async () => {
    const hits = await extract(`<button @click="onClick" :class="cls">Go</button>\n`);
    expect(hits.map((h) => [h.value, h.context.parentRole, h.context.identifiers])).toEqual([
      ["onClick", "markup_attr", ["@click"]],
      ["cls", "markup_attr", [":class"]],
      ["Go", "markup_text", []],
    ]);
  });

  test("a template hole in plain .html is tokenized by the template grammar, so its literals are hits", async () => {
    const hits = await extract(`<p>{{ isFollowing ? 'Unfollow' : 'Follow' }}</p>\n`);
    // The text node is holes only, so it carries no copy of its own.
    expect(hits.map((h) => [h.value, h.context.parentRole])).toEqual([
      ["'Unfollow'", "other"],
      ["'Follow'", "other"],
    ]);
  });
});
