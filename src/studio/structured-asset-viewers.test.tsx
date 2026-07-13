import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTableViewer, MindMapViewer, VideoScenesViewer } from "./structured-asset-viewers";

afterEach(cleanup);

const CITATION = {
  chunk_id: "chunk-1",
  source_id: "source-1",
  title: "Climate report",
  source_path: "notebook-sources/climate/source.md",
  start_line: 10,
  end_line: 14,
};

describe("MindMapViewer", () => {
  it("renders a collapsible grounded hierarchy with zoom and node details", () => {
    render(<MindMapViewer text={JSON.stringify({
      title: "Climate",
      root: "Climate change",
      nodes: [
        { id: "causes", label: "Causes", summary: "Human activity", citations: [CITATION] },
        { id: "energy", label: "Energy", summary: "Fossil fuels", parent_id: "causes", citations: [CITATION] },
      ],
      edges: [],
    })} />);

    expect(screen.getByRole("tree", { name: "Climate mind map" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open node Energy" }));
    expect(screen.getByText("Fossil fuels")).toBeTruthy();
    expect(screen.getByText(/Climate report/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Causes" }));
    expect(screen.queryByRole("button", { name: "Open node Energy" })).toBeNull();
  });

  it.each([
    ["duplicate node ids", [
      { id: "root", label: "Root", summary: "Root summary" },
      { id: "root", label: "Child", summary: "Child summary", parent_id: "root" },
    ]],
    ["cyclic parent links", [
      { id: "a", label: "A", summary: "A summary", parent_id: "b" },
      { id: "b", label: "B", summary: "B summary", parent_id: "a" },
    ]],
  ])("rejects %s instead of rendering an unsafe tree", (_label, nodes) => {
    render(<MindMapViewer text={JSON.stringify({ title: "Unsafe", root: "Unsafe", nodes })} />);

    expect(screen.getByText(/mind-map JSON is invalid/)).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });
});

describe("DataTableViewer", () => {
  it("renders canonical cells, filtering, sorting, and citation details", () => {
    const onCitationOpen = vi.fn();
    render(<DataTableViewer text={JSON.stringify({
      title: "Emissions",
      columns: [{ id: "country", label: "Country" }, { id: "value", label: "Value" }],
      rows: [
        { cells: [
          { column_id: "country", value: "France", citations: [CITATION] },
          { column_id: "value", value: "5", citations: [CITATION] },
        ] },
        { cells: [
          { column_id: "country", value: "Brazil", citations: [CITATION] },
          { column_id: "value", value: "9", citations: [CITATION] },
        ] },
      ],
    })} onCitationOpen={onCitationOpen} />);

    expect(screen.getByRole("table", { name: "Emissions" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search table" }), { target: { value: "Brazil" } });
    expect(screen.queryByText("France")).toBeNull();
    expect(screen.getByText("Brazil")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /View citations/ })[0]);
    expect(screen.getByText(/Climate report · lines 10–14/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open cited source" }));
    expect(onCitationOpen).toHaveBeenCalledWith(expect.objectContaining({ chunkId: "chunk-1" }));
  });

  it("rejects a canonical table with too many columns before expanding rows", () => {
    render(<DataTableViewer text={JSON.stringify({
      title: "Too wide",
      columns: Array.from({ length: 101 }, (_, index) => ({
        id: `column-${index}`,
        label: `Column ${index}`,
      })),
      rows: [{ cells: [] }],
    })} />);

    expect(screen.getByText(/table is too large for the interactive viewer/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("VideoScenesViewer", () => {
  it("renders scene plan JSON as production cards", () => {
    render(<VideoScenesViewer text={JSON.stringify({
      title: "Market overview",
      style: "documentary",
      duration_minutes: 3,
      scenes: [{ scene: 1, type: "chart", visual: "A rising line", narration: "Growth accelerated.", citations: [CITATION] }],
    })} />);
    expect(screen.getByRole("heading", { name: "Scene 1" })).toBeTruthy();
    expect(screen.getByText("A rising line")).toBeTruthy();
    expect(screen.getByText("Growth accelerated.")).toBeTruthy();
    expect(screen.getByText(/documentary · 3 min/)).toBeTruthy();
  });
});
