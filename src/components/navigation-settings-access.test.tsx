import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/auth-context", () => ({
  useAuth: () => ({
    user: { email: "member@example.test" },
    portal: { can_access_admin_portal: false },
    logout: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: vi.fn() }),
}));

vi.mock("@/home/use-ominix-runtime-summary", () => ({
  useOminixRuntimeSummary: () => ({
    label: "Unavailable",
    tone: "default",
    ready: false,
    loading: false,
    canRepair: false,
    state: "unavailable",
    needsAttention: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/home/voice/audio-playback", () => ({ unlockAudio: vi.fn() }));

import { StudioNav } from "./studio-nav";
import { WorkbenchRouteNav } from "./workbench-shell";

afterEach(cleanup);

describe("non-admin Settings navigation", () => {
  it("keeps Settings in the workbench navigation", () => {
    render(
      <MemoryRouter>
        <WorkbenchRouteNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("keeps Settings in the studio navigation", () => {
    render(
      <MemoryRouter>
        <StudioNav />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });
});
