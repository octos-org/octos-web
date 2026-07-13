import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv-parser";

describe("parseCsv", () => {
  it("handles BOM, quoted commas, escaped quotes, and embedded newlines", () => {
    expect(parseCsv('\ufeffname,notes\r\nAda,"hello, world"\r\nLin,"said ""hi""\nand left"'))
      .toEqual([
        ["name", "notes"],
        ["Ada", "hello, world"],
        ["Lin", 'said "hi"\nand left'],
      ]);
  });

  it("keeps empty trailing cells", () => {
    expect(parseCsv("a,b,c\n1,2,")).toEqual([
      ["a", "b", "c"],
      ["1", "2", ""],
    ]);
  });
});
