import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminSettingsPage } from "./settings-page";

const apiMocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  portal: {
    accessible_profiles: [] as Array<{ id: string; name: string }>,
    can_access_admin_portal: true,
    home_profile_id: "",
  },
}));

vi.mock("@/auth/auth-context", () => ({
  useAuth: () => ({
    portal: authMocks.portal,
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
    authMocks.portal.can_access_admin_portal = true;
    authMocks.portal.accessible_profiles = [];
  });

  it("keeps self-service settings scoped to the authenticated profile", async () => {
    authMocks.portal.accessible_profiles = [
      { id: "profile-a", name: "Profile A" },
      { id: "profile-b", name: "Profile B" },
    ];

    render(
      <MemoryRouter>
        <AdminSettingsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(apiMocks.getMyProfile).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("combobox")).toBeNull();
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

  it("falls back to Profile when a non-admin deep-links to Authentication", async () => {
    authMocks.portal.can_access_admin_portal = false;
    render(
      <MemoryRouter initialEntries={["/settings?tab=authentication"]}>
        <AdminSettingsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/no profile available/i)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Profile" }).getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.queryByRole("button", { name: /authentication/i }),
    ).toBeNull();
  });
});
