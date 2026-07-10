import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryTab } from "./memory-tab";

const apiMocks = vi.hoisted(() => ({
  getMyMemory: vi.fn(),
  getMyMemoryEntity: vi.fn(),
  formatSettingsError: vi.fn((err: unknown, fallback = "Request failed.") =>
    err instanceof Error ? err.message : fallback,
  ),
}));

vi.mock("./settings-api", () => apiMocks);

// MarkdownContent pulls in mermaid/katex — irrelevant to tab behavior.
vi.mock("@/components/markdown-renderer", () => ({
  MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));

const OVERVIEW = {
  ok: true,
  long_term: "# MEMORY\n\n- remembers things\n",
  long_term_updated_at: "2026-07-10T08:00:00Z",
  today: "did a thing today",
  recent: [{ date: "2026-07-09", content: "yesterday note" }],
  entities: [{ name: "fleet", summary: "five minis" }],
  staging_notes: 2,
  refresh_enabled: true,
};

describe("MemoryTab", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.getMyMemory.mockReset();
    apiMocks.getMyMemoryEntity.mockReset();
  });

  it("renders overview sections from /api/my/memory", async () => {
    apiMocks.getMyMemory.mockResolvedValue(OVERVIEW);
    render(<MemoryTab />);

    await waitFor(() =>
      expect(screen.getByText(/remembers things/)).toBeTruthy(),
    );
    expect(screen.getByText("Long-term memory")).toBeTruthy();
    expect(screen.getByText("did a thing today")).toBeTruthy();
    expect(screen.getByText("2026-07-09")).toBeTruthy();
    expect(screen.getByText("fleet")).toBeTruthy();
    expect(screen.getByText("five minis")).toBeTruthy();
    expect(screen.getByTestId("memory-refresh-state").textContent).toContain(
      "on",
    );
    expect(screen.getByTestId("memory-staging-count").textContent).toContain(
      "2 staged notes",
    );
  });

  it("renders the zero state for a fresh profile", async () => {
    apiMocks.getMyMemory.mockResolvedValue({
      ok: true,
      long_term: "",
      today: "",
      recent: [],
      entities: [],
      staging_notes: 0,
      refresh_enabled: true,
    });
    render(<MemoryTab />);

    await waitFor(() =>
      expect(screen.getByText(/Nothing here yet/)).toBeTruthy(),
    );
    expect(screen.queryByText("Long-term memory")).toBeNull();
    expect(screen.queryByTestId("memory-staging-count")).toBeNull();
  });

  it("shows refresh off when the pipeline is disabled", async () => {
    apiMocks.getMyMemory.mockResolvedValue({
      ...OVERVIEW,
      refresh_enabled: false,
    });
    render(<MemoryTab />);

    await waitFor(() =>
      expect(screen.getByTestId("memory-refresh-state").textContent).toContain(
        "off",
      ),
    );
  });

  it("lazily fetches an entity page on expand", async () => {
    apiMocks.getMyMemory.mockResolvedValue(OVERVIEW);
    apiMocks.getMyMemoryEntity.mockResolvedValue({
      ok: true,
      name: "fleet",
      content: "# fleet\n\nfive minis and a WireGuard hub\n",
    });
    render(<MemoryTab />);
    await waitFor(() => expect(screen.getByText("fleet")).toBeTruthy());

    expect(apiMocks.getMyMemoryEntity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("fleet"));
    await waitFor(() =>
      expect(screen.getByText(/WireGuard hub/)).toBeTruthy(),
    );
    expect(apiMocks.getMyMemoryEntity).toHaveBeenCalledWith("fleet");

    // Collapse + re-expand must NOT refetch (page cached).
    fireEvent.click(screen.getByText("fleet"));
    fireEvent.click(screen.getByText("fleet"));
    expect(apiMocks.getMyMemoryEntity).toHaveBeenCalledTimes(1);
  });

  it("surfaces a load error with a retry", async () => {
    apiMocks.getMyMemory.mockRejectedValueOnce(new Error("boom"));
    apiMocks.getMyMemory.mockResolvedValueOnce(OVERVIEW);
    render(<MemoryTab />);

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() =>
      expect(screen.getByText(/remembers things/)).toBeTruthy(),
    );
  });
});
