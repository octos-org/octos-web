import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SlidePreview from "./slide-preview";
import type { Slide } from "../types";

const SLIDES: Slide[] = [
  { index: 0, title: "Intro", notes: "Hello", layout: "title" },
  { index: 1, title: "Details", notes: "More", layout: "content" },
];

afterEach(cleanup);

describe("SlidePreview manual editing (#320)", () => {
  it("stays read-only when no edit callbacks are provided", () => {
    render(
      <SlidePreview slides={SLIDES} currentIndex={0} onIndexChange={() => {}} />,
    );
    expect(screen.queryByTitle("Edit this slide")).toBeNull();
  });

  it("opens the edit panel and saves title/notes/layout changes", () => {
    const onUpdate = vi.fn();
    render(
      <SlidePreview
        slides={SLIDES}
        currentIndex={0}
        onIndexChange={() => {}}
        onUpdate={onUpdate}
        onRemove={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle("Edit this slide"));
    const titleInput = screen.getByDisplayValue("Intro");
    fireEvent.change(titleInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Save slide"));

    expect(onUpdate).toHaveBeenCalledWith(0, {
      title: "Renamed",
      notes: "Hello",
      layout: "title",
    });
  });

  it("requires a second click to delete a slide", () => {
    const onRemove = vi.fn();
    render(
      <SlidePreview
        slides={SLIDES}
        currentIndex={0}
        onIndexChange={() => {}}
        onUpdate={vi.fn()}
        onRemove={onRemove}
        onMove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle("Edit this slide"));
    fireEvent.click(screen.getByText("Delete"));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this slide?")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Confirm delete"));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("moves the slide with the reorder buttons", () => {
    const onMove = vi.fn();
    render(
      <SlidePreview
        slides={SLIDES}
        currentIndex={0}
        onIndexChange={() => {}}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onMove={onMove}
      />,
    );

    fireEvent.click(screen.getByTitle("Edit this slide"));
    fireEvent.click(screen.getByText("Later"));
    expect(onMove).toHaveBeenCalledWith(0, 1);
  });
});
