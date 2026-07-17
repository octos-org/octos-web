import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminSettingsPage } from "./settings-page";

const apiMocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
}));

vi.mock("@/auth/auth-context", () => ({
  useAuth: () => ({
    portal: {
      accessible_profiles: [],
      can_access_admin_portal: true,
      home_profile_id: "",
    },
  }),
}));

vi.mock("@/components/workbench-shell", () => ({
  WorkbenchStatusPill: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  WorkbenchThemeButton: () => null,
}));

vi.mock("./settings-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings-api")>();
  return { ...actual, ...apiMocks };
});

describe("AdminSettingsPage", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.getMyProfile.mockReset();
    apiMocks.getMyProfile.mockResolvedValue(null);
  });

  it("keeps the Authentication menu icon visible beside the admin badge", async () => {
    render(
      <MemoryRouter>
        <AdminSettingsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /authentication/i })).toBeTruthy();
    });
    const button = screen.getByRole("button", { name: /authentication/i });
    const icon = button.querySelector("svg");

    expect(icon?.classList.contains("shrink-0")).toBe(true);
  });
});
