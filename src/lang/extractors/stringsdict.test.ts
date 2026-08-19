import { stringsdictExtractor } from "./stringsdict";

const extract = (source: string) =>
  stringsdictExtractor.extract({ source, kind: "ios_stringsdict" });

const sample = `<?xml version="1.0" encoding="UTF-8"?>
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
      <key>NSStringFormatValueTypeKey</key>
      <string>d</string>
      <key>one</key>
      <string>%d item</string>
      <key>other</key>
      <string>%d items</string>
    </dict>
  </dict>
</dict>
</plist>
`;

describe("stringsdictExtractor", () => {
  test("emits format key + each plural variant", async () => {
    const hits = await extract(sample);
    const values = hits.map((h) => h.value).sort();
    expect(values).toEqual(["%#@items@", "%d item", "%d items"]);
  });

  test("skips NSStringFormatSpecTypeKey and NSStringFormatValueTypeKey metadata", async () => {
    const hits = await extract(sample);
    const values = hits.map((h) => h.value);
    expect(values).not.toContain("NSStringPluralRuleType");
    expect(values).not.toContain("d");
  });

  test("includes plural variant in identifiers under the top-level key", async () => {
    const hits = await extract(sample);
    const one = hits.find((h) => h.value === "%d item");
    const other = hits.find((h) => h.value === "%d items");
    expect(one?.context.identifiers).toEqual(["%d items", "items", "one"]);
    expect(other?.context.identifiers).toEqual(["%d items", "items", "other"]);
    expect(one?.context.parentRole).toBe("resource_value");
  });

  test("keeps the whole value when it contains an xml entity", async () => {
    const source = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>greet</key>
  <dict>
    <key>NSStringLocalizedFormatKey</key>
    <string>Tom &amp; Jerry</string>
  </dict>
</dict></plist>`;
    const hits = await extract(source);

    expect(hits[0]?.value).toBe("Tom & Jerry");
    expect(hits[0]?.snapshotText).toBe("Tom &amp; Jerry");
  });

  test("keeps the whole value when it contains nested markup", async () => {
    const source = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>greet</key>
  <dict>
    <key>NSStringLocalizedFormatKey</key>
    <string>Hi <b>there</b></string>
  </dict>
</dict></plist>`;
    const hits = await extract(source);

    expect(hits[0]?.value).toBe("Hi there");
    expect(hits[0]?.snapshotText).toBe("Hi <b>there</b>");
  });

  test("returns empty for an empty plist", async () => {
    const hits = await extract(
      `<?xml version="1.0"?>\n<plist version="1.0"><dict></dict></plist>\n`,
    );
    expect(hits).toEqual([]);
  });
});
