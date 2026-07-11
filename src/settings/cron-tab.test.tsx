import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CronTab, describeSchedule } from "./cron-tab";
import { BridgeRpcError } from "@/runtime/ui-protocol-bridge";

const apiMocks = vi.hoisted(() => ({
  getMyCron: vi.fn(),
  setMyCronEnabled: vi.fn(),
  // Mirrors the real implementation (settings-api.ts): the WS bridge
  // surfaces `cron/toggle` refusals as `BridgeRpcError` with the REST
  // `reason` forwarded in `data.detail` (octos PR #1621).
  cronToggleRefusalReason: vi.fn((err: unknown) => {
    if (!(err && typeof err === "object" && "data" in err)) return null;
    const data = (err as { data?: { detail?: unknown } }).data;
    return typeof data?.detail === "string" ? data.detail : null;
  }),
  formatSettingsError: vi.fn((err: unknown, fallback = "Request failed.") =>
    err instanceof Error ? err.message : fallback,
  ),
}));

vi.mock("./settings-api", () => apiMocks);

const JOB = {
  id: "aa11",
  name: "morning briefing",
  enabled: true,
  schedule: { kind: "Every" as const, every_ms: 1_800_000 },
  message: "check the queue",
  channel: "system",
  last_run: "2026-07-10T08:00:00Z",
  last_status: "ok",
  next_in: "12m",
  timezone: null,
};

const OVERVIEW = {
  count: 1,
  jobs: [JOB],
  gateway_running: false,
};

describe("describeSchedule", () => {
  it("renders each schedule kind", () => {
    expect(describeSchedule({ kind: "Every", every_ms: 1_800_000 })).toBe(
      "every 30m",
    );
    expect(describeSchedule({ kind: "Every", every_ms: 5_400_000 })).toBe(
      "every 1h 30m",
    );
    expect(describeSchedule({ kind: "Every", every_ms: 45_000 })).toBe(
      "every 45s",
    );
    // Remainders survive — 90s is NOT "every 2m" (codex web#266 r1 P2).
    expect(describeSchedule({ kind: "Every", every_ms: 90_000 })).toBe(
      "every 1m 30s",
    );
    expect(describeSchedule({ kind: "Every", every_ms: 3_599_000 })).toBe(
      "every 59m 59s",
    );
    expect(describeSchedule({ kind: "Every", every_ms: 3_690_000 })).toBe(
      "every 1h 1m 30s",
    );
    expect(describeSchedule({ kind: "Cron", expr: "0 0 9 * * * *" })).toBe(
      "0 0 9 * * * *",
    );
    expect(
      describeSchedule({ kind: "At", at_ms: Date.UTC(2026, 6, 10, 9) }),
    ).toContain("once at");
  });
});

describe("CronTab", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.getMyCron.mockReset();
    apiMocks.setMyCronEnabled.mockReset();
  });

  it("lists jobs with schedule and history", async () => {
    apiMocks.getMyCron.mockResolvedValue(OVERVIEW);
    render(<CronTab />);

    await waitFor(() =>
      expect(screen.getByText("morning briefing")).toBeTruthy(),
    );
    expect(screen.getByText("every 30m")).toBeTruthy();
    expect(screen.getByText("check the queue")).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByTestId("cron-gateway-lock")).toBeNull();
  });

  it("renders the zero state without jobs", async () => {
    apiMocks.getMyCron.mockResolvedValue({
      count: 0,
      jobs: [],
      gateway_running: false,
    });
    render(<CronTab />);

    await waitFor(() =>
      expect(screen.getByText(/No scheduled jobs yet/)).toBeTruthy(),
    );
  });

  it("toggles a job and applies the server row", async () => {
    apiMocks.getMyCron.mockResolvedValue(OVERVIEW);
    apiMocks.setMyCronEnabled.mockResolvedValue({
      job: { ...JOB, enabled: false, next_in: null },
    });
    render(<CronTab />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(apiMocks.setMyCronEnabled).toHaveBeenCalledWith("aa11", false);
  });

  it("locks toggles while the gateway owns the schedule", async () => {
    apiMocks.getMyCron.mockResolvedValue({
      ...OVERVIEW,
      gateway_running: true,
    });
    render(<CronTab />);

    await waitFor(() =>
      expect(screen.getByTestId("cron-gateway-lock")).toBeTruthy(),
    );
    const toggle = screen.getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  it("reflects a 409 gateway_running refusal and refreshes", async () => {
    apiMocks.getMyCron.mockResolvedValueOnce(OVERVIEW);
    apiMocks.setMyCronEnabled.mockRejectedValue(
      new BridgeRpcError(-32602, "cron/toggle: REST returned 409 conflict", {
        detail: "gateway_running",
        rest_status: 409,
      }),
    );
    apiMocks.getMyCron.mockResolvedValueOnce({
      ...OVERVIEW,
      gateway_running: true,
    });
    render(<CronTab />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByTestId("cron-toggle-error").textContent).toContain(
        "gateway is running",
      ),
    );
    // The refetch adopted the lock state.
    await waitFor(() =>
      expect(screen.getByTestId("cron-gateway-lock")).toBeTruthy(),
    );
  });

  it("does not blank the tab when a superseded load resolves first", async () => {
    // codex web#266 r2 P2: under real StrictMode the effect runs
    // TWICE, starting two loads. If the FIRST (superseded) resolves
    // while the SECOND (winning) is still pending, the superseded load
    // must NOT clear loading — otherwise `!overview` blanks the tab.
    let resolveFirst: (v: typeof OVERVIEW) => void = () => {};
    let resolveSecond: (v: typeof OVERVIEW) => void = () => {};
    apiMocks.getMyCron.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve as (v: typeof OVERVIEW) => void;
        }),
    );
    apiMocks.getMyCron.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve as (v: typeof OVERVIEW) => void;
        }),
    );
    render(
      <StrictMode>
        <CronTab />
      </StrictMode>,
    );
    // Both effects have run → two pending GETs. Loader is visible.
    await waitFor(() =>
      expect(screen.getByText(/Loading schedule/)).toBeTruthy(),
    );

    // The SUPERSEDED (first) load resolves. With the old unconditional
    // clear this stopped the spinner while overview was still null →
    // blank tab. The fix keeps the loader up until the winner resolves.
    resolveFirst({ ...OVERVIEW, count: 99 });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/Loading schedule/)).toBeTruthy();
    expect(screen.queryByText("morning briefing")).toBeNull();

    // The WINNING (second) load resolves → real content, loader gone.
    resolveSecond(OVERVIEW);
    await waitFor(() =>
      expect(screen.getByText("morning briefing")).toBeTruthy(),
    );
  });

  it("rejects a stale reload snapshot that resolves after a toggle", async () => {
    // codex web#266 r1 P2: GET starts (old rows) → PUT resolves and
    // applies the toggled row → GET resolves late. The stale snapshot
    // must NOT overwrite the fresh row.
    let resolveStaleLoad: (v: typeof OVERVIEW) => void = () => {};
    apiMocks.getMyCron.mockResolvedValueOnce(OVERVIEW);
    apiMocks.setMyCronEnabled.mockResolvedValue({
      job: { ...JOB, enabled: false, next_in: null },
    });
    render(<CronTab />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    // Arm the SECOND load (Reload click) as a hanging promise.
    apiMocks.getMyCron.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStaleLoad = resolve as (v: typeof OVERVIEW) => void;
        }),
    );
    fireEvent.click(screen.getByText("Reload"));

    // Toggle lands while the reload is still in flight.
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );

    // The stale reload resolves with the OLD (enabled) row — rejected.
    resolveStaleLoad(OVERVIEW);
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
  });

  it("keeps the snapshot but flags a failed reload", async () => {
    apiMocks.getMyCron.mockResolvedValueOnce(OVERVIEW);
    apiMocks.getMyCron.mockRejectedValueOnce(new Error("reload boom"));
    render(<CronTab />);
    await waitFor(() =>
      expect(screen.getByText("morning briefing")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Reload"));
    await waitFor(() =>
      expect(screen.getByTestId("cron-reload-error").textContent).toContain(
        "reload boom",
      ),
    );
    expect(screen.getByText("morning briefing")).toBeTruthy();
  });
});
