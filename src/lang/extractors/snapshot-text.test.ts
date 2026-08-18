// Side-effect import: registers the dynamic Kotlin and Swift grammars.
import "../registry";

import { Lang } from "@ast-grep/napi";

import { androidResourceExtractor } from "./android-resources";
import { arbExtractor } from "./arb";
import { fallbackExtractor } from "./fallback";
import { htmlMarkupExtractor } from "./html-markup";
import { javascriptExtractor } from "./javascript";
import { jsonI18nExtractor } from "./json-i18n";
import { kotlinExtractor } from "./kotlin";
import { poExtractor } from "./po";
import { propertiesExtractor } from "./properties";
import { resxExtractor } from "./resx";
import { stringsExtractor } from "./strings";
import { stringsdictExtractor } from "./stringsdict";
import { swiftExtractor } from "./swift";
import { vueExtractor } from "./vue";
import { xcstringsExtractor } from "./xcstrings";
import { xliffExtractor } from "./xliff";
import { yamlI18nExtractor } from "./yaml-i18n";
import type { LanguageExtractor } from "../types";

const cases: {
  name: string;
  extractor: LanguageExtractor;
  kind: string;
  source: string;
}[] = [
  {
    name: "javascript",
    extractor: javascriptExtractor(Lang.Tsx),
    kind: "tsx",
    source: `
      const re = "^foo$";
      const apostrophe = 'Don\\'t stop';
      const tabbed = "Line one\\nLine two";
      const tpl = \`Hi \${name}, welcome back\`;
      export const View = () => (
        <div title="Save changes">
          Read the <a href="/docs">docs</a> first
        </div>
      );
    `,
  },
  {
    name: "html-markup",
    extractor: htmlMarkupExtractor,
    kind: "html",
    source: `
      <p>Welcome home</p>
      <img alt="A cat wearing a hat" src="/cat.png" />
      <span>{{ isFollowing ? 'Unfollow' : 'Follow' }}</span>
    `,
  },
  {
    name: "vue",
    extractor: vueExtractor,
    kind: "vue",
    source: `
      <template>
        <p>Welcome home</p>
      </template>
      <script>
      export default { data: () => ({ label: "Save changes" }) };
      </script>
    `,
  },
  {
    name: "kotlin",
    extractor: kotlinExtractor,
    kind: "kotlin",
    source: `
      val greeting = "Don't stop\\nnow"
      val raw = """Multi
      line"""
    `,
  },
  {
    name: "swift",
    extractor: swiftExtractor,
    kind: "swift",
    source: `
      let greeting = "Don't stop\\nnow"
      let raw = #"Keep \\n literal"#
    `,
  },
  {
    name: "fallback",
    extractor: fallbackExtractor,
    kind: "python",
    source: `
      greeting = "Don't stop"
      other = 'Save changes'
    `,
  },
  {
    name: "json-i18n",
    extractor: jsonI18nExtractor,
    kind: "json",
    source: `{
      "home": { "title": "Welcome back" },
      "errors.tooBig": "File is too big",
      "item_one": "1 item",
      "multiline": "Line one\\nLine two"
    }`,
  },
  {
    name: "arb",
    extractor: arbExtractor,
    kind: "json",
    source: `{
      "@@locale": "en",
      "hello": "Hello there",
      "@hello": { "description": "a greeting" }
    }`,
  },
  {
    name: "xcstrings",
    extractor: xcstringsExtractor,
    kind: "json",
    source: `{
      "sourceLanguage": "en",
      "strings": {
        "hello": {
          "localizations": {
            "en": { "stringUnit": { "value": "Hello" } },
            "es": { "stringUnit": { "value": "Hola" } }
          }
        },
        "items": {
          "localizations": {
            "en": {
              "variations": {
                "plural": {
                  "one": { "stringUnit": { "value": "%d item" } },
                  "other": { "stringUnit": { "value": "%d items" } }
                }
              }
            }
          }
        }
      }
    }`,
  },
  {
    name: "strings",
    extractor: stringsExtractor,
    kind: "strings",
    source: `
      /* A comment */
      "greeting" = "Don't stop";
      // another comment
      "escaped" = "Say \\"hi\\" now";
      "multiline" = "Line one\\nLine two";
    `,
  },
  {
    name: "stringsdict",
    extractor: stringsdictExtractor,
    kind: "stringsdict",
    source: `<?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0">
      <dict>
        <key>%d items</key>
        <dict>
          <key>NSStringLocalizedFormatKey</key>
          <string>%#@items@</string>
          <key>items</key>
          <dict>
            <key>NSStringFormatSpecTypeKey</key>
            <string>NSStringPluralRuleType</string>
            <key>one</key>
            <string>%d item</string>
            <key>other</key>
            <string>%d items</string>
          </dict>
        </dict>
      </dict>
    </plist>`,
  },
  {
    name: "android-resources",
    extractor: androidResourceExtractor,
    kind: "xml",
    source: `<resources>
      <string name="hello">Hello, world!</string>
      <string name="amp">Tom &amp; Jerry</string>
      <string name="wrapped"><![CDATA[Terms & <conditions>]]></string>
      <plurals name="items">
        <item quantity="one">%d item</item>
        <item quantity="other">%d items</item>
      </plurals>
      <string-array name="planets">
        <item>Mercury</item>
        <item>Venus</item>
      </string-array>
    </resources>`,
  },
  {
    name: "resx",
    extractor: resxExtractor,
    kind: "xml",
    source: `<root>
      <resheader name="version"><value>2.0</value></resheader>
      <data name="hello" xml:space="preserve">
        <value>Hello</value>
        <comment>greeting</comment>
      </data>
      <data name="wrapped"><value><![CDATA[Raw & <b>bold</b>]]></value></data>
    </root>`,
  },
  {
    name: "xliff",
    extractor: xliffExtractor,
    kind: "xml",
    source: `<xliff version="1.2">
      <file>
        <body>
          <trans-unit id="hello">
            <source>Hello</source>
            <target>Bonjour</target>
          </trans-unit>
          <trans-unit id="wrapped">
            <source><![CDATA[Raw & <b>bold</b>]]></source>
          </trans-unit>
        </body>
      </file>
    </xliff>`,
  },
  {
    name: "yaml-i18n",
    extractor: yamlI18nExtractor,
    kind: "yaml",
    source: `en:
  home:
    title: Welcome back
    quoted: "Don't stop"
  item_one: 1 item
  item_other: "%{count} items"
`,
  },
  {
    name: "po",
    extractor: poExtractor,
    kind: "po",
    source: `msgid ""
msgstr "Content-Type: text/plain\\n"

msgid "greeting"
msgstr "Hello, world"

msgid "wrapped"
msgstr ""
"Line one "
"line two"

msgid "one_item"
msgid_plural "n_items"
msgstr[0] "1 item"
msgstr[1] "%d items"
`,
  },
  {
    name: "properties",
    extractor: propertiesExtractor,
    kind: "properties",
    source: `# a comment
greeting = Hello, world
escaped: Say \\"hi\\" now
continued = First line \\
    second line
`,
  },
];

describe.each(cases)("$name snapshotText", ({ extractor, kind, source }) => {
  test("is present on every hit", async () => {
    const hits = await extractor.extract({ source, kind });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(typeof hit.snapshotText).toBe("string");
    }
  });

  test("can be found verbatim in the source", async () => {
    const hits = await extractor.extract({ source, kind });

    for (const hit of hits) {
      expect(source).toContain(hit.snapshotText);
    }
  });
});

describe("snapshotText keeps what the value drops", () => {
  const tsx = javascriptExtractor(Lang.Tsx);

  test("keeps escape sequences the value decodes", async () => {
    const source = `const message = "Line one\\nLine two";`;
    const hits = await tsx.extract({ source, kind: "tsx" });
    const hit = hits.find((h) => h.value.includes("Line one"));

    expect(hit?.value).toContain("\n");
    expect(hit?.snapshotText).toBe('"Line one\\nLine two"');
  });

  test("keeps the original quote style", async () => {
    const source = `const a = 'Save changes';`;
    const hits = await tsx.extract({ source, kind: "tsx" });

    expect(hits[0]?.snapshotText).toBe("'Save changes'");
  });

  test("keeps the interpolation expression in a template literal", async () => {
    const source = "const a = `Hi ${firstName}, welcome`;";
    const hits = await tsx.extract({ source, kind: "tsx" });

    expect(hits[0]?.snapshotText).toBe("`Hi ${firstName}, welcome`");
  });

  test("keeps inline markup inside a JSX text run", async () => {
    const source = `const a = <p>Read the <b>docs</b> first</p>;`;
    const hits = await tsx.extract({ source, kind: "tsx" });
    const run = hits.find((h) => h.value.includes("Read the"));

    expect(run?.snapshotText).toBe("Read the ");
  });
});

describe("snapshotText spans regions that aren't replaceable as-is", () => {
  test("XML element wrapping a nested child element keeps the tags", async () => {
    const source = `<resources><string name="x">Hi <b>there</b></string></resources>`;
    const hits = await androidResourceExtractor.extract({ source, kind: "xml" });

    expect(hits[0]?.value).toBe("Hi there");
    expect(hits[0]?.snapshotText).toBe("Hi <b>there</b>");
  });

  // `<source>` is a void element in HTML, so the grammar refuses to nest a
  // child inside it: the tree comes back with no end_tag and `</source>`
  // demoted to an erroneous_end_tag, which drops the hit before any snapshot
  // is taken. An XLIFF unit with an inline placeholder therefore yields no
  // candidate at all today — not a candidate with a missing span.
  test("XLIFF source wrapping a placeholder element yields no hit at all", async () => {
    const source = `<xliff><file><body><trans-unit id="k">
      <source>Hello <xliff:g id="n">%s</xliff:g></source>
    </trans-unit></body></file></xliff>`;
    const hits = await xliffExtractor.extract({ source, kind: "xml" });

    expect(hits).toEqual([]);
  });

  test("XML entities and surrounding whitespace stay in the span", async () => {
    const source = `<resources><string name="x"> Tom &amp; Jerry </string></resources>`;
    const hits = await androidResourceExtractor.extract({ source, kind: "xml" });

    expect(hits[0]?.value).toBe("Tom & Jerry");
    expect(hits[0]?.snapshotText).toBe(" Tom &amp; Jerry ");
  });

  test("YAML block scalar spans the header and the indented lines", async () => {
    const source = `en:\n  legal: |\n    First line\n    Second line\n  short: Plain value\n`;
    const hits = await yamlI18nExtractor.extract({ source, kind: "yaml" });
    const block = hits.find((h) => h.i18nKey === "en.legal");
    const plain = hits.find((h) => h.i18nKey === "en.short");

    expect(block?.snapshotText).toContain("First line");
    expect(block?.snapshotText).toContain("    Second line");
    expect(source).toContain(block?.snapshotText);
    expect(plain?.snapshotText).toBe("Plain value");
  });

  test("PO multi-chunk string spans the first quote through the last", async () => {
    const source = ['msgid "greeting"', 'msgstr ""', '"Hello, "', '"world"', ""].join("\n");
    const hits = await poExtractor.extract({ source, kind: "po" });

    expect(hits[0]?.value).toBe("Hello, world");
    expect(hits[0]?.snapshotText).toBe('""\n"Hello, "\n"world"');
  });

  test("properties span covers only the value when the key is continued too", async () => {
    const source = "long\\\nkey = Value here\n";
    const hits = await propertiesExtractor.extract({ source, kind: "properties" });

    expect(hits[0]?.value).toBe("Value here");
    expect(hits[0]?.snapshotText).toBe("Value here");
  });

  test("properties continuation spans the backslash-continued lines", async () => {
    const source = ["legal = First line \\", "    second line", ""].join("\n");
    const hits = await propertiesExtractor.extract({ source, kind: "properties" });

    expect(hits[0]?.value).toBe("First line second line");
    expect(hits[0]?.snapshotText).toBe("First line \\\n    second line");
  });
});
