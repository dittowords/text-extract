import { grammarExtractor } from "./extractors/grammar";
import { GRAMMAR_LANGUAGES } from "./grammars";

// One sample per grammar added after the first batch: a plain literal and
// one with a value in it. The plain literal must come out, and the second
// must come out whole or as literals split only at the value.
const SAMPLES: Record<string, string> = {
  haml: `%p Hello world\n%p Welcome back, #{name}!\n`,
  edge: `<p>Hello world</p>\n<p>Welcome back, {{ name }}!</p>\n`,
  elixir: `a = "Hello world"\nb = "Welcome back, #{name}!"\n`,
  erlang: `a() -> "Hello world".\nb(N) -> io_lib:format("Welcome back, ~s!", [N]).\n`,
  gleam: `fn b(name) { "Welcome back, " <> name <> "!" }\nfn a() { "Hello world" }\n`,
  clojure: `(def a "Hello world")\n(def b (str "Welcome back, " name "!"))\n`,
  haskell: `a = "Hello world"\nb = "Welcome back, " ++ name ++ "!"\n`,
  elm: `a = "Hello world"\nb = "Welcome back, " ++ name ++ "!"\n`,
  purescript: `a = "Hello world"\nb = "Welcome back, " <> name <> "!"\n`,
  fsharp: `let a = "Hello world"\nlet b = $"Welcome back, {name}!"\n`,
  vb: `Dim a = "Hello world"\nDim b = $"Welcome back, {name}!"\n`,
  groovy: `def a = "Hello world"\ndef b = "Welcome back, \${name}!"\n`,
  crystal: `a = "Hello world"\nb = "Welcome back, #{name}!"\n`,
  nim: `let a = "Hello world"\nlet b = &"Welcome back, {name}!"\n`,
  zig: `const a = "Hello world";\nconst b = "Welcome back, {s}!";\n`,
  odin: `a := "Hello world"\nb := "Welcome back, %s!"\n`,
  d: `auto a = "Hello world";\nauto b = format("Welcome back, %s!", name);\n`,
  julia: `a = "Hello world"\nb = "Welcome back, $(name)!"\n`,
  r: `a <- "Hello world"\nb <- sprintf("Welcome back, %s!", name)\n`,
  perl: `my $a = "Hello world";\nmy $b = "Welcome back, $name!";\n`,
  powershell: `$a = "Hello world"\n$b = "Welcome back, $name!"\n`,
  pascal: `a := 'Hello world';\nb := Format('Welcome back, %s!', [name]);\n`,
  hack: `$a = "Hello world";\n$b = "Welcome back, {$name}!";\n`,
  coffee: `a = "Hello world"\nb = "Welcome back, #{name}!"\n`,
  imba: `<p> "Hello world"\n<p> "Welcome back, {name}!"\n`,
  "actionscript-3": `var a:String = "Hello world";\nvar b:String = "Welcome back, " + name + "!";\n`,
};

describe("grammar table", () => {
  test("every sampled grammar is in the table", () => {
    const ids = new Set(GRAMMAR_LANGUAGES.map((g) => g.grammar));
    for (const kind of Object.keys(SAMPLES)) expect(ids.has(kind)).toBe(true);
  });

  test.each(Object.entries(SAMPLES))(
    "%s: strings come out whole",
    async (kind, source) => {
      // Drop quotes and any string prefix (`&"` in nim); haml keeps the leading space of a text node.
      const values = (await grammarExtractor.extract({ source, kind })).map(
        (h) => h.value.replace(/^[^A-Za-z!]+|["']$/g, "").trim()
      );
      expect(values).toContain("Hello world");
      const greeting = values.filter((v) => v.startsWith("Welcome back"));
      expect(greeting).toHaveLength(1);
      const whole = /^Welcome back, .+!$/.test(greeting[0]);
      const split = greeting[0] === "Welcome back," && values.includes("!");
      expect(whole || split).toBe(true);
    }
  );
});
