import { extractFromResolvedFile } from "./extract";
import { findLanguageForFile } from "./lang/registry";

const extract = (relPath: string, source: string) => {
  const language = findLanguageForFile({
    ext: relPath.slice(relPath.lastIndexOf(".")),
    relPath,
  });
  if (!language) throw new Error(`no language for ${relPath}`);
  return extractFromResolvedFile({
    relPath,
    source,
    language,
    languageLabel: language.id,
    localeKey: null,
    framework: [],
  });
};

describe("candidate ids", () => {
  test("two PO plural forms with identical text get distinct ids", async () => {
    const source = [
      `msgid "%d thing"`,
      `msgid_plural "%d things"`,
      `msgstr[0] "%d rzecz"`,
      `msgstr[1] "%d rzeczy"`,
      `msgstr[2] "%d rzeczy"`,
      ``,
    ].join("\n");

    const candidates = await extract("locales/pl.po", source);
    const repeats = candidates.filter((c) => c.value_raw === "%d rzeczy");

    expect(repeats).toHaveLength(2);
    expect(repeats.map((c) => c.occurrence_index).sort()).toEqual([0, 1]);
    expect(repeats[0].id).not.toBe(repeats[1].id);
  });

  test("an id is unchanged when unrelated lines are inserted above it", async () => {
    const before = [
      `msgid "Save"`,
      `msgstr "Zapisz"`,
      ``,
    ].join("\n");
    const after = [
      `msgid "Cancel"`,
      `msgstr "Anuluj"`,
      ``,
      before,
    ].join("\n");

    const [savedBefore] = await extract("locales/pl.po", before);
    const savedAfter = (await extract("locales/pl.po", after)).find(
      (c) => c.value_raw === "Zapisz"
    );

    expect(savedAfter!.location.line).not.toBe(savedBefore.location.line);
    expect(savedAfter!.id).toBe(savedBefore.id);
  });
});
