import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CronTab, describeSchedule } from "./cron-tab";

const apiMocks = vi.hoisted(() => ({
  getMyCron: vi.fn(),
  setMyCronEnabled: vi.fn(),
  cronToggleRefusalReason: vi.fn((err: unknown) => {
    if (!(err instanceof Error)) return null;
    try {
      const body = JSON.parse(err.message) as { reason?: unknown };
      return typeof body.reason === "string" ? body.reason : null;
    } catch {
      return null;
    }
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
  ok: true,
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
      ok: true,
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
      ok: true,
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
      new Error(JSON.stringify({ ok: false, reason: "gateway_running" })),
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

  it("rejects a stale reload snapshot that resolves after a toggle", async () => {
    // codex web#266 r1 P2: GET starts (old rows) → PUT resolves and
    // applies the toggled row → GET resolves late. The stale snapshot
    // must NOT overwrite the fresh row.
    let resolveStaleLoad: (v: typeof OVERVIEW) => void = () => {};
    apiMocks.getMyCron.mockResolvedValueOnce(OVERVIEW);
    apiMocks.setMyCronEnabled.mockResolvedValue({
      ok: true,
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
