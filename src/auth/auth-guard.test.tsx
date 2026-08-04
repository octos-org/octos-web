import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthGuard } from "./auth-guard";

const authMocks = vi.hoisted(() => ({
  token: null as string | null,
  loading: false,
}));

vi.mock("./auth-context", () => ({
  useAuth: () => ({ token: authMocks.token, loading: authMocks.loading }),
}));

function LoginProbe() {
  const location = useLocation();
  return (
    <div data-testid="login-probe">{location.pathname + location.search}</div>
  );
}

function renderGuard(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route element={<AuthGuard />}>
          <Route path="/" element={<div>home page</div>} />
          <Route path="/chat" element={<div>chat page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AuthGuard", () => {
  afterEach(() => {
    cleanup();
    authMocks.token = null;
    authMocks.loading = false;
  });

  it("bounces unauthenticated deep links to /login with the destination preserved", () => {
    renderGuard("/chat?topic=design");
    expect(screen.getByTestId("login-probe").textContent).toBe(
      `/login?redirect=${encodeURIComponent("/chat?topic=design")}`,
    );
  });

  it("bounces the home path without a redundant redirect param", () => {
    renderGuard("/");
    expect(screen.getByTestId("login-probe").textContent).toBe("/login");
  });

  it("renders the protected route when a token is present", () => {
    authMocks.token = "tok";
    renderGuard("/chat");
    expect(screen.getByText("chat page")).toBeTruthy();
  });
});
