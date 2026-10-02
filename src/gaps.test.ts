import { gapsToNext } from "./extract";

const hit = (line: number, column: number, snapshotText: string) => ({ location: { line, column }, snapshotText });

describe("gapsToNext", () => {
  test("the source between neighbouring hits, null when far apart or across a blank line", () => {
    const source = ['const a = "Hello " + name + ", welcome";', "", 'const b = "Bye";', 'const c = "x";'].join("\n");
    const hits = [hit(1, 11, '"Hello "'), hit(1, 29, '", welcome"'), hit(3, 11, '"Bye"'), hit(4, 11, '"x"')];
    expect(gapsToNext(hits, source)).toEqual([" + name + ", null, ';\nconst c = ', null]);
  });

  test("a gap longer than the limit is null", () => {
    const filler = "x".repeat(300);
    const source = `"a"; ${filler}; "b"`;
    expect(gapsToNext([hit(1, 1, '"a"'), hit(1, source.length - 2, '"b"')], source)).toEqual([null, null]);
  });
});
