import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceRow } from "./source-media";

vi.mock("./studio-source-preview", () => ({
  StudioSourcePreview: ({
    row,
    onBack,
  }: {
    row: SourceRow;
    onBack: () => void;
  }) => (
    <button type="button" onClick={onBack}>
      Back from {row.filename}
    </button>
  ),
}));

import { StudioSourcesPane } from "./studio-sources-pane";

const ROWS: SourceRow[] = [
  {
    sourceId: "source-a",
    filename: "Source A.pdf",
    path: "notebook-sources/source-a/source.md",
    sourcePath: "notebook-sources/source-a/source.md",
    status: "ready",
    timestamp: 2,
  },
  {
    sourceId: "source-b",
    filename: "Source B.pdf",
    path: "notebook-sources/source-b/source.md",
    sourcePath: "notebook-sources/source-b/source.md",
    status: "ready",
    timestamp: 1,
  },
];

function pane(
  previewKey: string | null,
  onPreviewKeyChange: (key: string | null) => void,
) {
  return (
    <StudioSourcesPane
      sessionId="web-abc"
      previewKey={previewKey}
      onPreviewKeyChange={onPreviewKeyChange}
      selected={[]}
      onToggle={vi.fn()}
      uploaded={ROWS}
      onUploaded={vi.fn()}
      onRenamed={vi.fn()}
      onRemoved={vi.fn()}
      onCatalogChanged={vi.fn()}
      loading={false}
      query=""
      onQueryChange={vi.fn()}
      listScrollTop={0}
      onListScrollTopChange={vi.fn()}
      citationTarget={previewKey === "source-b"
        ? { chunkId: "chunk-b", sourceId: "source-b" }
        : null}
    />
  );
}

afterEach(cleanup);

describe("StudioSourcesPane", () => {
  it("restores focus to the citation source instead of a stale manual preview", async () => {
    const onPreviewKeyChange = vi.fn();
    const view = render(pane(null, onPreviewKeyChange));

    fireEvent.click(screen.getByRole("button", { name: "Preview Source A.pdf" }));
    expect(onPreviewKeyChange).toHaveBeenLastCalledWith("source-a");
    view.rerender(pane("source-a", onPreviewKeyChange));

    fireEvent.click(screen.getByRole("button", { name: "Back from Source A.pdf" }));
    view.rerender(pane(null, onPreviewKeyChange));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Preview Source A.pdf" }),
      );
    });

    view.rerender(pane("source-b", onPreviewKeyChange));
    fireEvent.click(screen.getByRole("button", { name: "Back from Source B.pdf" }));
    view.rerender(pane(null, onPreviewKeyChange));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Preview Source B.pdf" }),
      );
    });
  });
});
