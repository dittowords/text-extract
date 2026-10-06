import { gapsToNext } from "./extract";

const hit = (line: number, column: number, snapshotText: string) => ({ location: { line, column }, snapshotText });

describe("gapsToNext", () => {
  test("the source after each hit: to the next hit, or to a blank line, or to the end", () => {
    const source = ['const a = "Hello " + name + ", welcome";', "", 'const b = "Bye";', 'const c = "x";'].join("\n");
    const hits = [hit(1, 11, '"Hello "'), hit(1, 29, '", welcome"'), hit(3, 11, '"Bye"'), hit(4, 11, '"x"')];
    expect(gapsToNext(hits, source)).toEqual([" + name + ", ";", ';\nconst c = ', ";"]);
  });

  test("a lone literal keeps the code after it", () => {
    const source = '<% content_for :title, "Edit " + @agent.name -%>\n\n<div>';
    expect(gapsToNext([hit(1, 24, '"Edit "')], source)).toEqual([" + @agent.name -%>"]);
  });

  test("a hit nested in the previous span is skipped over", () => {
    const source = `<p>Read the terms on{" "}<a>GitHub</a>.</p>`;
    const hits = [hit(1, 4, 'Read the terms on{" "}'), hit(1, 22, '" "'), hit(1, 29, "GitHub"), hit(1, 39, ".")];
    expect(gapsToNext(hits, source)).toEqual(["<a>", "}<a>", "</a>", "</p>"]);
  });

  test("a gap is cut at the limit, so it stops short of a far hit", () => {
    const filler = "x".repeat(600);
    const source = `"a"; ${filler}; "b"`;
    const [first, last] = gapsToNext([hit(1, 1, '"a"'), hit(1, source.length - 2, '"b"')], source);
    expect(first).toHaveLength(500);
    expect(last).toBeNull();
  });
});
