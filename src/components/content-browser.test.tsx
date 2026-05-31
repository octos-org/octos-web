import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ContentEntry } from "@/api/content";
import type { FileEntry } from "@/store/file-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const fileStoreMock = vi.hoisted(() => ({
  files: [] as FileEntry[],
  removeFile: vi.fn(),
  renameFile: vi.fn(),
}));

const contentApiMock = vi.hoisted(() => ({
  downloadContent: vi.fn(async () => {}),
}));

vi.mock("@/store/file-store", () => ({
  useAllFiles: () => fileStoreMock.files,
  removeFile: fileStoreMock.removeFile,
  renameFile: fileStoreMock.renameFile,
}));

vi.mock("@/api/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/content")>();
  return {
    ...actual,
    downloadContent: contentApiMock.downloadContent,
  };
});

vi.mock("@/api/files", () => ({
  buildAuthenticatedFileUrl: (path: string) => `/auth-file/${encodeURIComponent(path)}`,
}));

import { ContentBrowser } from "./content-browser";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  openViewer: ReturnType<typeof vi.fn>;
  unmount: () => void;
}

function makeFile(overrides: Partial<FileEntry>): FileEntry {
  return {
    id: "file-default",
    sessionId: "web-current",
    filename: "report.md",
    filePath: "/workspace/report.md",
    size: 2048,
    status: "ready",
    timestamp: Date.now(),
    caption: "",
    ...overrides,
  };
}

function mountBrowser(): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const openViewer = vi.fn();

  act(() => {
    root.render(
      <ContentBrowser
        open
        onClose={() => {}}
        isMaximized={false}
        onToggleMaximize={() => {}}
        onOpenViewer={openViewer}
        sessionId="web-current"
        sessionTitle="Current Sprint"
        sessionLabels={{ "web-research": "Research Archive" }}
      />,
    );
  });

  return {
    container,
    root,
    openViewer,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label ||
      candidate.getAttribute("title") === label,
  ) as HTMLButtonElement | undefined;
  expect(button).toBeTruthy();
  act(() => button!.click());
}

beforeEach(() => {
  fileStoreMock.files = [
    makeFile({
      id: "file-report",
      filename: "weekly-report.md",
      filePath: "/profiles/ada/data/users/web-current/workspace/weekly-report.md",
      timestamp: Date.now(),
      caption: "summary",
    }),
    makeFile({
      id: "file-audio",
      sessionId: "web-research",
      filename: "briefing.mp3",
      filePath: "/profiles/ada/data/users/web-research/skill-output/briefing.mp3",
      timestamp: Date.now() - 24 * 60 * 60 * 1000,
      caption: "voice brief",
    }),
    makeFile({
      id: "file-image",
      filename: "slide-01.png",
      filePath: "/profiles/ada/data/users/web-current/slides/slide-01.png",
      timestamp: Date.now(),
      caption: "cover",
    }),
  ];
  fileStoreMock.removeFile.mockReset();
  fileStoreMock.renameFile.mockReset();
  contentApiMock.downloadContent.mockClear();
});

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
});

describe("ContentBrowser CMS controls", () => {
  it("renders a profile-wide timeline and filters by type, date, and search", () => {
    const harness = mountBrowser();
    try {
      expect(harness.container.textContent).toContain("weekly-report.md");
      expect(harness.container.textContent).toContain("briefing.mp3");
      expect(harness.container.textContent).toContain("Research Archive");
      expect(harness.container.textContent).toContain("Today");
      expect(harness.container.textContent).toContain("Yesterday");

      const selects = harness.container.querySelectorAll("select");
      setSelectValue(selects[0] as HTMLSelectElement, "audio");
      expect(harness.container.textContent).toContain("briefing.mp3");
      expect(harness.container.textContent).not.toContain("weekly-report.md");

      setSelectValue(selects[0] as HTMLSelectElement, "all");
      setSelectValue(selects[1] as HTMLSelectElement, "today");
      expect(harness.container.textContent).toContain("weekly-report.md");
      expect(harness.container.textContent).not.toContain("briefing.mp3");

      const search = harness.container.querySelector("input") as HTMLInputElement;
      setInputValue(search, "slide");
      expect(harness.container.textContent).toContain("slide-01.png");
      expect(harness.container.textContent).not.toContain("weekly-report.md");
    } finally {
      harness.unmount();
    }
  });

  it("renames, downloads, and deletes selected files", () => {
    const harness = mountBrowser();
    try {
      clickButton(harness.container, "Rename weekly-report.md");
      const renameInput = [...harness.container.querySelectorAll("input")].find(
        (input) => input.value === "weekly-report.md",
      ) as HTMLInputElement | undefined;
      expect(renameInput).toBeTruthy();
      setInputValue(renameInput!, "weekly-final.md");
      clickButton(harness.container, "Save rename");
      expect(fileStoreMock.renameFile).toHaveBeenCalledWith(
        "file-report",
        "weekly-final.md",
      );

      clickButton(harness.container, "Select visible");
      expect(harness.container.textContent).toContain("3 selected");

      const batchDownload = [...harness.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Download",
      ) as HTMLButtonElement | undefined;
      expect(batchDownload).toBeTruthy();
      act(() => batchDownload!.click());
      expect(contentApiMock.downloadContent).toHaveBeenCalledTimes(3);

      const batchDelete = [...harness.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Delete",
      ) as HTMLButtonElement | undefined;
      expect(batchDelete).toBeTruthy();
      act(() => batchDelete!.click());
      expect(fileStoreMock.removeFile).toHaveBeenCalledWith("file-report");
      expect(fileStoreMock.removeFile).toHaveBeenCalledWith("file-audio");
      expect(fileStoreMock.removeFile).toHaveBeenCalledWith("file-image");
    } finally {
      harness.unmount();
    }
  });

  it("switches grid/list modes and opens media with the expected viewer behavior", () => {
    const harness = mountBrowser();
    try {
      clickButton(harness.container, "Grid");
      expect(harness.container.querySelectorAll("[data-testid='content-file-card']").length)
        .toBe(3);

      const imageCard = [...harness.container.querySelectorAll("[data-testid='content-file-card']")]
        .find((card) => card.textContent?.includes("slide-01.png")) as HTMLElement;
      act(() => imageCard.click());
      expect(harness.openViewer).toHaveBeenCalledWith(
        expect.objectContaining({ filename: "slide-01.png" }),
        expect.arrayContaining([
          expect.objectContaining({ filename: "slide-01.png" }) as ContentEntry,
        ]),
      );

      clickButton(harness.container, "List");
      const audioRow = [...harness.container.querySelectorAll("[data-testid='content-file-row']")]
        .find((row) => row.textContent?.includes("briefing.mp3")) as HTMLElement;
      act(() => audioRow.click());
      expect(harness.container.textContent).toContain("1.25x");
    } finally {
      harness.unmount();
    }
  });
});
