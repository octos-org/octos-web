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

  it("surfaces the server's truncation declaration on capped documents", async () => {
    // octos #1621 codex r1: capped fields arrive as clean prefixes with
    // <field>_truncated + <field>_total_bytes DECLARED — the tab must
    // say so rather than render a shorter document as complete.
    apiMocks.getMyMemory.mockResolvedValue({
      ...OVERVIEW,
      long_term_truncated: true,
      long_term_total_bytes: 200 * 1024,
    });
    apiMocks.getMyMemoryEntity.mockResolvedValue({
      name: "fleet",
      content: "# fleet prefix",
      content_truncated: true,
      content_total_bytes: 512 * 1024,
    });
    render(<MemoryTab />);
    await waitFor(() =>
      expect(screen.getByText(/remembers things/)).toBeTruthy(),
    );
    expect(
      screen.getByTestId("memory-truncation-notice").textContent,
    ).toContain("of 200 KB");
    cleanup();

    // codex web#268 r4 P2: shown bytes are UTF-8, matching the server's
    // *_total_bytes unit — 32768 CJK chars are 96 KiB on the wire, not
    // the 32 KiB that string.length (UTF-16 code units) would claim.
    apiMocks.getMyMemory.mockResolvedValue({
      ...OVERVIEW,
      long_term: "\u6c49".repeat(32 * 1024),
      long_term_truncated: true,
      long_term_total_bytes: 200 * 1024,
    });
    render(<MemoryTab />);
    await waitFor(() =>
      expect(screen.getByTestId("memory-truncation-notice")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("memory-truncation-notice").textContent,
    ).toContain("first 96 KB of 200 KB");

    fireEvent.click(screen.getByText("fleet"));
    await waitFor(() =>
      expect(screen.getAllByTestId("memory-truncation-notice")).toHaveLength(2),
    );
  });

  it("keeps the snapshot but flags a failed reload", async () => {
    apiMocks.getMyMemory.mockResolvedValueOnce(OVERVIEW);
    apiMocks.getMyMemory.mockRejectedValueOnce(new Error("reload boom"));
    render(<MemoryTab />);
    await waitFor(() =>
      expect(screen.getByText(/remembers things/)).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Reload"));
    await waitFor(() =>
      expect(screen.getByTestId("memory-reload-error").textContent).toContain(
        "reload boom",
      ),
    );
    // The stale snapshot stays on screen, flagged — not silently kept.
    expect(screen.getByText(/remembers things/)).toBeTruthy();
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
