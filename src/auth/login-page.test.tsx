import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthStatusResponse } from "@/api/types";
import { LoginPage } from "./login-page";

const authMocks = vi.hoisted(() => ({
  authStatus: null as AuthStatusResponse | null,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  soloLogin: vi.fn(),
}));

vi.mock("./auth-context", () => ({
  useAuth: () => ({
    authStatus: authMocks.authStatus,
    login: authMocks.login,
    loginWithToken: authMocks.loginWithToken,
    soloLogin: authMocks.soloLogin,
  }),
}));

function renderLogin(allowSelfRegistration: boolean) {
  authMocks.authStatus = {
    bootstrap_mode: false,
    email_login_enabled: true,
    admin_token_login_enabled: false,
    allow_self_registration: allowSelfRegistration,
    local_solo_enabled: false,
    scoped_profile: null,
  };
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage registration guidance", () => {
  afterEach(() => cleanup());

  it("invites a new user to create an account when registration is open", () => {
    renderLogin(true);

    expect(
      screen.getByText(/verify your email to create an account and sign in/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/use an allowed or registered email/i),
    ).toBeNull();
  });

  it("requires an allowed or registered email when registration is restricted", () => {
    renderLogin(false);

    expect(
      screen.getByText(/use an allowed or registered email to sign in/i),
    ).toBeTruthy();
  });
});
