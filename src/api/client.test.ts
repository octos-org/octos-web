/**
 * Unit tests for the M12 Phase D-4 401/403 reaper scoping.
 *
 * Pre-D-4 the reaper fired on EVERY 401/403 from EVERY REST call,
 * clearing both `octos_session_token` and `octos_auth_token` and
 * hard-redirecting to `/login`. Phase D-4 narrows the reaper to paths
 * under `/api/auth/*` only. See `src/api/client.ts` for the rationale.
 *
 * The mini5 user-incident motivating ADR PR octos-org/octos#910 was a
 * stale REST callsite on `/api/sessions/*` 401-ing after a background
 * token refresh and ejecting the user mid-rename. These tests pin the
 * new behavior so a regression can't reintroduce that failure mode.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { publicRequest, request, getToken, setToken } from "@/api/client";
import { TOKEN_KEY, ADMIN_TOKEN_KEY } from "@/lib/constants";

// ---------------------------------------------------------------------------
// jsdom location helpers
// ---------------------------------------------------------------------------
//
// We need to observe both `window.location.pathname` (the reaper reads it
// to decide whether to redirect) and `window.location.href` (the reaper
// writes to it on the redirect). jsdom's `window.location` properties are
// not configurable, so we replace `window.location` outright with a
// minimal stub object whose `href` setter records writes.

const hrefWrites: string[] = [];
let originalLocation: Location | undefined;

function installLocationStub(pathname = "/app/dashboard"): void {
  hrefWrites.length = 0;
  if (!originalLocation) {
    originalLocation = window.location;
  }
  const stub = {
    pathname,
    hostname: "localhost",
    host: "localhost",
    protocol: "http:",
    origin: "http://localhost",
    search: "",
    hash: "",
    port: "",
    set href(value: string) {
      hrefWrites.push(value);
    },
    get href() {
      return `http://localhost${pathname}`;
    },
    assign: (value: string) => {
      hrefWrites.push(value);
    },
    replace: (value: string) => {
      hrefWrites.push(value);
    },
    reload: () => {},
    toString: () => `http://localhost${pathname}`,
  };
  // jsdom permits replacing `window.location` wholesale via
  // `delete window.location; window.location = stub`. The `as unknown as
  // Location` cast keeps tsc happy without bringing in the full Location
  // interface surface (pathname is the only read we exercise).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).location;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).location = stub;
}

function restoreLocationStub(): void {
  if (originalLocation) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).location;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = originalLocation;
  }
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchStatus(status: number, body = ""): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Start every test signed in so the reaper has tokens to clear.
  localStorage.setItem(TOKEN_KEY, "session-token");
  localStorage.setItem(ADMIN_TOKEN_KEY, "admin-token");
  installLocationStub("/app/dashboard");
});

afterEach(() => {
  restoreLocationStub();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Reaper triggers — auth-flow paths only
// ---------------------------------------------------------------------------

describe("client.request — 401 reaper scoped to /api/auth/*", () => {
  it("401 from /api/auth/me → clears tokens AND redirects to /login", async () => {
    mockFetchStatus(401, "unauthorized");

    let caught: unknown;
    try {
      await request("/api/auth/me");
    } catch (e) {
      caught = e;
    }

    // Throws so the caller can render an error message.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("unauthorized");

    // Tokens cleared.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
    expect(getToken()).toBeNull();

    // Redirect to /login with the original pathname as ?redirect=.
    expect(hrefWrites.length).toBe(1);
    expect(hrefWrites[0]).toBe(
      "/login?redirect=" + encodeURIComponent("/app/dashboard"),
    );
  });

  it("401 from /api/auth/status → triggers reaper", async () => {
    mockFetchStatus(401);

    await expect(request("/api/auth/status")).rejects.toBeInstanceOf(Error);

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(hrefWrites.length).toBe(1);
  });

  it("403 from /api/auth/me → also triggers reaper", async () => {
    mockFetchStatus(403, "forbidden");

    await expect(request("/api/auth/me")).rejects.toBeInstanceOf(Error);

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
    expect(hrefWrites.length).toBe(1);
  });

  it("does not redirect when already on /login", async () => {
    installLocationStub("/login");
    mockFetchStatus(401);

    await expect(request("/api/auth/me")).rejects.toBeInstanceOf(Error);

    // Tokens still cleared, but no redirect (we're already on /login).
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(hrefWrites.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reaper does NOT trigger — non-auth paths
// ---------------------------------------------------------------------------

describe("client.request — 401/403 on non-auth paths does NOT trigger reaper", () => {
  it("401 from /api/files/upload → propagates as Error, leaves tokens intact", async () => {
    mockFetchStatus(401, "upload session expired");

    let caught: unknown;
    try {
      await request("/api/files/upload");
    } catch (e) {
      caught = e;
    }

    // Caller sees a normal error envelope.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("upload session expired");

    // Tokens NOT cleared (the structural cutover).
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");

    // No redirect.
    expect(hrefWrites.length).toBe(0);
  });

  it("403 from /api/files/some-blob → propagates as Error, leaves tokens intact", async () => {
    mockFetchStatus(403, "forbidden");

    await expect(request("/api/files/some-blob")).rejects.toBeInstanceOf(Error);

    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");
    expect(hrefWrites.length).toBe(0);
  });

  it("401 from /api/sessions/foo → does NOT trigger reaper (mini5 incident regression test)", async () => {
    // This is the EXACT failure mode that motivated ADR PR
    // octos-org/octos#910: a stale REST callsite on `/api/sessions/*`
    // 401-ed after a background token refresh, the reaper fired, and
    // the user got booted to /login mid-rename. Post-D-4 this 401
    // propagates as a normal error and the session-rename UI is free
    // to surface a retry control.
    mockFetchStatus(401, "session token expired");

    let caught: unknown;
    try {
      await request("/api/sessions/sess-abc");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("session token expired");

    // Tokens preserved — the user stays signed in.
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");

    // No redirect — the user keeps their current view.
    expect(hrefWrites.length).toBe(0);
  });

  it("401 from /api/my/content/c-1 (auxiliary REST) → no reaper", async () => {
    mockFetchStatus(401);

    await expect(request("/api/my/content/c-1")).rejects.toBeInstanceOf(Error);

    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(hrefWrites.length).toBe(0);
  });

  it("401 from /api/admin/* → no reaper (admin endpoints are NOT auth flow)", async () => {
    // Documents the boundary intent: the reaper fires for `/api/auth/*`
    // ONLY. Admin endpoints, while privileged, are not the auth flow
    // and a 401 on one should propagate as a normal error so admin UI
    // can surface a contextual permissions message rather than nuking
    // the session and booting the admin to /login.
    mockFetchStatus(401, "admin scope required");

    let caught: unknown;
    try {
      await request("/api/admin/users");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("admin scope required");

    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");
    expect(hrefWrites.length).toBe(0);
  });

  it("500 from /api/auth/me does NOT trigger reaper (only 401/403 do)", async () => {
    mockFetchStatus(500, "server error");

    await expect(request("/api/auth/me")).rejects.toBeInstanceOf(Error);

    // Server is on fire — but the user's session is fine. Don't clear.
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(hrefWrites.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auth-path edge cases
// ---------------------------------------------------------------------------

describe("client.request — /api/auth/* prefix matching", () => {
  it("paths that merely contain 'auth' do NOT match — only the prefix triggers", async () => {
    mockFetchStatus(401);

    // A hypothetical session resource whose name contains "auth".
    await expect(request("/api/sessions/auth-debug")).rejects.toBeInstanceOf(
      Error,
    );

    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(hrefWrites.length).toBe(0);
  });

  it("nested /api/auth/* paths trigger reaper (e.g. /api/auth/sso/callback)", async () => {
    mockFetchStatus(401);

    await expect(
      request("/api/auth/sso/callback"),
    ).rejects.toBeInstanceOf(Error);

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(hrefWrites.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// publicRequest — the no-reaper path for solo (policy-gated) endpoints
// ---------------------------------------------------------------------------

describe("client.publicRequest — solo endpoints never reap tokens", () => {
  it("403 from /api/auth/solo/create (policy denial) → throws but keeps tokens, no redirect", async () => {
    // A solo 403 means "not opted in / proxied / non-loopback" — NOT that the
    // signed-in user's existing token is dead. It must not log them out.
    mockFetchStatus(403, "forbidden");

    let caught: unknown;
    try {
      await publicRequest("/api/auth/solo/create", { method: "POST" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("admin-token");
    expect(hrefWrites.length).toBe(0);
  });

  it("404 from /api/auth/solo (no profile yet) → throws 'HTTP 404', tokens intact", async () => {
    mockFetchStatus(404);

    let caught: unknown;
    try {
      await publicRequest("/api/auth/solo", { method: "POST" });
    } catch (e) {
      caught = e;
    }

    // The login page keys the create-form fallback off this "404" message.
    expect((caught as Error).message).toContain("404");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    expect(hrefWrites.length).toBe(0);
  });
});

// Avoid unused-import lint on setToken — exported for symmetry but
// not exercised here (token-setting is covered indirectly by getToken).
void setToken;
