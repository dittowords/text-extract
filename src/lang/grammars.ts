// The code and markup languages the grammar extractor reads. `grammar` is
// the `tm-grammars` grammar name. A row is one line; the grammar package has
// no file-extension data of its own, so this table is the only mapping.
//
// Before a row is added, scan one real file in that language and confirm
// that string literals and interpolation holes come out whole. Scope names
// are a convention, and a grammar that labels them differently needs an
// entry in the scope tables in `extractors/grammar.ts`.
export interface GrammarLanguage {
  grammar: string;
  extensions: string[];
  // Narrows an ambiguous extension; see `Language.pathMatches`.
  pathMatches?: (relPath: string) => boolean;
}

export const GRAMMAR_LANGUAGES: readonly GrammarLanguage[] = [
  { grammar: "typescript", extensions: [".ts", ".cts", ".mts"] },
  { grammar: "tsx", extensions: [".tsx"] },
  { grammar: "javascript", extensions: [".js", ".cjs", ".mjs"] },
  { grammar: "jsx", extensions: [".jsx"] },
  { grammar: "html", extensions: [".html", ".htm"] },
  { grammar: "vue", extensions: [".vue"] },
  // Kotlin grammar also handles .kts (Gradle scripts) and .ktm (Kotlin modules).
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
  // Laravel templates share the `.php` extension, so they go first.
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
  { grammar: "erb", extensions: [".erb"] },
  { grammar: "jinja-html", extensions: [".jinja", ".jinja2", ".j2", ".njk"] },
  { grammar: "twig", extensions: [".twig"] },
];
