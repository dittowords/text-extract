import { grammarExtractor } from "./extractors/grammar";
import { GRAMMAR_LANGUAGES } from "./grammars";

// One sample per grammar row: a plain literal and a literal with a value in
// it, written the way that language formats values. The plain literal must
// come out. The second must come out as one hit, hole included. This is the
// only check a new row needs. A grammar that splits at the hole fails here.
const SAMPLES: Record<string, string> = {
  typescript: 'const a = "Hello world";\nconst b = `Welcome back, ${name}!`;\n',
  tsx: 'const a = "Hello world";\nconst b = <p>Welcome back, {name}!</p>;\n',
  javascript: 'const a = "Hello world";\nconst b = `Welcome back, ${name}!`;\n',
  jsx: 'const a = "Hello world";\nconst b = <p>Welcome back, {name}!</p>;\n',
  html: "<p>Hello world</p>\n<p>Welcome back, {{ name }}!</p>\n",
  vue: "<template>\n  <p>Hello world</p>\n  <p>Welcome back, {{ name }}!</p>\n</template>\n",
  kotlin: 'val a = "Hello world"\nval b = "Welcome back, $name!"\n',
  swift: 'let a = "Hello world"\nlet b = "Welcome back, \\(name)!"\n',
  python: 'a = "Hello world"\nb = f"Welcome back, {name}!"\n',
  go: 'a := "Hello world"\nb := fmt.Sprintf("Welcome back, %s!", name)\n',
  ruby: 'a = "Hello world"\nb = "Welcome back, #{name}!"\n',
  java: 'String a = "Hello world";\nString b = String.format("Welcome back, %s!", name);\n',
  rust: 'let a = "Hello world";\nlet b = format!("Welcome back, {name}!");\n',
  c: 'const char *a = "Hello world";\nprintf("Welcome back, %s!", name);\n',
  cpp: 'std::string a = "Hello world";\nstd::format("Welcome back, {}!", name);\n',
  "objective-c": 'NSString *a = @"Hello world";\nNSString *b = [NSString stringWithFormat:@"Welcome back, %@!", name];\n',
  "objective-cpp": 'NSString *a = @"Hello world";\nNSString *b = [NSString stringWithFormat:@"Welcome back, %@!", name];\n',
  csharp: 'var a = "Hello world";\nvar b = $"Welcome back, {name}!";\n',
  blade: "<p>Hello world</p>\n<p>Welcome back, {{ $name }}!</p>\n",
  php: '$a = "Hello world";\n$b = "Welcome back, {$name}!";\n',
  lua: 'local a = "Hello world"\nlocal b = ("Welcome back, %s!"):format(name)\n',
  dart: 'var a = "Hello world";\nvar b = "Welcome back, $name!";\n',
  svelte: "<p>Hello world</p>\n<p>Welcome back, {name}!</p>\n",
  astro: "---\nconst x = 1;\n---\n<p>Hello world</p>\n<p>Welcome back, {name}!</p>\n",
  handlebars: "<p>Hello world</p>\n<p>Welcome back, {{name}}!</p>\n",
  liquid: "<p>Hello world</p>\n<p>Welcome back, {{ name }}!</p>\n",
  erb: "<p>Hello world</p>\n<p>Welcome back, <%= name %>!</p>\n",
  "jinja-html": "<p>Hello world</p>\n<p>Welcome back, {{ name }}!</p>\n",
  twig: "<p>Hello world</p>\n<p>Welcome back, {{ name }}!</p>\n",
  haml: "%p Hello world\n%p Welcome back, #{name}!\n",
  edge: "<p>Hello world</p>\n<p>Welcome back, {{ name }}!</p>\n",
  elixir: 'a = "Hello world"\nb = "Welcome back, #{name}!"\n',
  erlang: 'a() -> "Hello world".\nb(N) -> io_lib:format("Welcome back, ~s!", [N]).\n',
  gleam: 'fn a() { "Hello world" }\nfn b(name) { string.replace("Welcome back, NAME!", "NAME", name) }\n',
  clojure: '(def a "Hello world")\n(def b (format "Welcome back, %s!" name))\n',
  haskell: 'a = "Hello world"\nb = printf "Welcome back, %s!" name\n',
  elm: 'a = "Hello world"\nb = String.replace "NAME" name "Welcome back, NAME!"\n',
  purescript: 'a = "Hello world"\nb = replace (Pattern "NAME") (Replacement name) "Welcome back, NAME!"\n',
  fsharp: 'let a = "Hello world"\nlet b = $"Welcome back, {name}!"\n',
  vb: 'Dim a = "Hello world"\nDim b = $"Welcome back, {name}!"\n',
  groovy: 'def a = "Hello world"\ndef b = "Welcome back, ${name}!"\n',
  crystal: 'a = "Hello world"\nb = "Welcome back, #{name}!"\n',
  nim: 'let a = "Hello world"\nlet b = &"Welcome back, {name}!"\n',
  zig: 'const a = "Hello world";\nconst b = "Welcome back, {s}!";\n',
  odin: 'a := "Hello world"\nb := "Welcome back, %s!"\n',
  d: 'auto a = "Hello world";\nauto b = format("Welcome back, %s!", name);\n',
  julia: 'a = "Hello world"\nb = "Welcome back, $(name)!"\n',
  r: 'a <- "Hello world"\nb <- sprintf("Welcome back, %s!", name)\n',
  perl: 'my $a = "Hello world";\nmy $b = "Welcome back, $name!";\n',
  powershell: '$a = "Hello world"\n$b = "Welcome back, $name!"\n',
  pascal: "a := 'Hello world';\nb := Format('Welcome back, %s!', [name]);\n",
  hack: '$a = "Hello world";\n$b = "Welcome back, {$name}!";\n',
  coffee: 'a = "Hello world"\nb = "Welcome back, #{name}!"\n',
  imba: '<p> "Hello world"\n<p> "Welcome back, {name}!"\n',
  "actionscript-3": 'var a:String = "Hello world";\nvar b:String = StringUtil.substitute("Welcome back, {0}!", name);\n',
};

// Drop the delimiters and any string prefix (`f"`, `@"`, `&"`). Haml keeps
// the leading space of a text node.
const bare = (value: string) =>
  value
    .trim()
    .replace(/^[A-Za-z@$&#]{0,2}["'`]/, "")
    .replace(/["'`]$/, "");

describe("grammar table", () => {
  test("every row has a sample and every sample has a row", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(GRAMMAR_LANGUAGES.map((g) => g.grammar).sort());
  });

  test.each(Object.entries(SAMPLES))("%s: a literal with a value in it is one hit", async (kind, source) => {
    const values = (await grammarExtractor.extract({ source, kind })).map((h) => bare(h.value));
    expect(values).toContain("Hello world");
    expect(values.filter((v) => /^Welcome back, .+!$/.test(v))).toHaveLength(1);
  });
});
