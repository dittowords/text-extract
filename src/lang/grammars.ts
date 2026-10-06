// The code and markup languages the grammar extractor reads. `grammar` is
// the `tm-grammars` grammar name. The grammar package has no file extension
// data, so this table is the only mapping.
//
// A new row needs a sample in `grammars.test.ts`. A literal with a value in
// it must come out as one hit. A grammar that fails that is left out.
export interface GrammarLanguage {
  grammar: string;
  extensions: string[];
  // Narrows an ambiguous extension. See `Language.pathMatches`.
  pathMatches?: (relPath: string) => boolean;
}

export const GRAMMAR_LANGUAGES: readonly GrammarLanguage[] = [
  { grammar: "typescript", extensions: [".ts", ".cts", ".mts"] },
  { grammar: "tsx", extensions: [".tsx"] },
  { grammar: "javascript", extensions: [".js", ".cjs", ".mjs"] },
  { grammar: "jsx", extensions: [".jsx"] },
  { grammar: "html", extensions: [".html", ".htm"] },
  { grammar: "vue", extensions: [".vue"] },
  // The Kotlin grammar also covers .kts (Gradle scripts) and .ktm (Kotlin modules).
  { grammar: "kotlin", extensions: [".kt", ".kts", ".ktm"] },
  { grammar: "swift", extensions: [".swift"] },
  { grammar: "python", extensions: [".py"] },
  { grammar: "go", extensions: [".go"] },
  { grammar: "ruby", extensions: [".rb"] },
  { grammar: "java", extensions: [".java"] },
  { grammar: "rust", extensions: [".rs"] },
  { grammar: "c", extensions: [".c", ".h"] },
  { grammar: "cpp", extensions: [".cc", ".cpp", ".hpp"] },
  { grammar: "objective-c", extensions: [".m"] },
  { grammar: "objective-cpp", extensions: [".mm"] },
  { grammar: "csharp", extensions: [".cs"] },
  // Laravel templates share the `.php` extension, so this row is first.
  {
    grammar: "blade",
    extensions: [".php"],
    pathMatches: (p) => /\.blade\.php$/i.test(p),
  },
  { grammar: "php", extensions: [".php"] },
  { grammar: "lua", extensions: [".lua"] },
  { grammar: "dart", extensions: [".dart"] },
  { grammar: "svelte", extensions: [".svelte"] },
  { grammar: "astro", extensions: [".astro"] },
  { grammar: "handlebars", extensions: [".hbs"] },
  { grammar: "liquid", extensions: [".liquid"] },
  // EJS has the same `<% %>` delimiters.
  { grammar: "erb", extensions: [".erb", ".ejs"] },
  { grammar: "jinja-html", extensions: [".jinja", ".jinja2", ".j2", ".njk"] },
  { grammar: "twig", extensions: [".twig"] },
  { grammar: "haml", extensions: [".haml"] },
  { grammar: "edge", extensions: [".edge"] },
  { grammar: "elixir", extensions: [".ex", ".exs"] },
  { grammar: "erlang", extensions: [".erl", ".hrl"] },
  { grammar: "gleam", extensions: [".gleam"] },
  { grammar: "clojure", extensions: [".clj", ".cljs", ".cljc"] },
  { grammar: "haskell", extensions: [".hs"] },
  { grammar: "elm", extensions: [".elm"] },
  { grammar: "purescript", extensions: [".purs"] },
  { grammar: "fsharp", extensions: [".fs", ".fsx"] },
  { grammar: "vb", extensions: [".vb"] },
  { grammar: "groovy", extensions: [".groovy", ".gvy"] },
  { grammar: "crystal", extensions: [".cr"] },
  { grammar: "nim", extensions: [".nim"] },
  { grammar: "zig", extensions: [".zig"] },
  { grammar: "odin", extensions: [".odin"] },
  { grammar: "d", extensions: [".d"] },
  { grammar: "julia", extensions: [".jl"] },
  { grammar: "r", extensions: [".r"] },
  { grammar: "perl", extensions: [".pl", ".pm"] },
  { grammar: "powershell", extensions: [".ps1", ".psm1"] },
  { grammar: "pascal", extensions: [".pas", ".pp"] },
  { grammar: "hack", extensions: [".hack"] },
  { grammar: "coffee", extensions: [".coffee"] },
  { grammar: "imba", extensions: [".imba"] },
  { grammar: "actionscript-3", extensions: [".as"] },
  // Checked and left out. Scala, haxe and marko cut an interpolated string
  // at the hole. Ocaml emits nothing. Soy and pug emit template syntax as
  // text. Razor drops the text after an inline `@` expression. Matlab shares
  // `.m` with objective-c.
];
