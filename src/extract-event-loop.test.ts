import fs from "fs/promises";
import os from "os";
import path from "path";
import { runExtract } from "./extract";
import { grammarExtractor } from "./lang/extractors/grammar";

it("gives the event loop a turn between files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "extract-event-loop-"));
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(root, `f${i}.tsx`), `export const s = "Save changes ${i}";\n`);
  }
  // The first call loads the grammar from disk, and that I/O would let timers run on its own.
  await grammarExtractor.extract({ source: `const s = "warm";\n`, kind: "tsx" });
  let ticks = 0;
  const ticksAtExtract: number[] = [];
  const extract = grammarExtractor.extract.bind(grammarExtractor);
  const spy = jest.spyOn(grammarExtractor, "extract").mockImplementation((args) => {
    ticksAtExtract.push(ticks);
    return extract(args);
  });
  const timer = setInterval(() => ticks++, 0);
  try {
    await runExtract({ inputPath: root });
  } finally {
    clearInterval(timer);
    spy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
  expect(ticksAtExtract).toHaveLength(5);
  expect(ticksAtExtract[4]).toBeGreaterThan(ticksAtExtract[0]);
});
