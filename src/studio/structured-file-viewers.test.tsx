import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { parseCsv } from "./csv-parser";
import { CsvTableViewer, JsonViewer } from "./structured-file-viewers";

afterEach(cleanup);

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

  it("stops parsing as soon as a CSV row limit is exceeded", () => {
    const result = parseCsv("value\n1\n2\n3", { maxRows: 3, maxCells: 10 });

    expect(result).toEqual({
      rows: [["value"], ["1"], ["2"]],
      overflow: true,
    });
  });

  it("refuses to render an excessive number of CSV rows", () => {
    const text = ["value", ...Array.from({ length: 5_001 }, (_, index) => String(index))]
      .join("\n");

    render(<CsvTableViewer text={text} filename="many-rows.csv" />);

    expect(screen.getByRole("alert").textContent).toContain(
      "too large for the interactive table",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("JsonViewer", () => {
  it("refuses to render an excessive number of JSON nodes", () => {
    render(<JsonViewer text={JSON.stringify(Array.from({ length: 5_001 }, (_, index) => index))} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "too large for the interactive JSON viewer",
    );
  });
});
