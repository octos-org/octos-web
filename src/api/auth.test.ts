import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {status} from "./auth";
import {clearToken, getToken, request, setToken} from "./client";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it("loads public sign-in options independently of malformed saved credentials and preferences", async () => {
  localStorage.setItem("octos_auth_token", "invalid\n凭据");
  localStorage.setItem("octos-settings", JSON.stringify({searchEngine: "无效偏好"}));
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-Profile-Id")).toBe(false);
    expect(headers.has("X-Search-Engine")).toBe(false);
    return new Response(JSON.stringify({admin_token_login_enabled: true}));
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(status()).resolves.toEqual({admin_token_login_enabled: true});
  expect(fetcher).toHaveBeenCalledOnce();
});

it("keeps a public sign-in response valid while another request clears an expired token", async () => {
  setToken("expired-synthetic-token");
  let respond!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
  const pending = status();
  clearToken();
  respond(new Response(JSON.stringify({admin_token_login_enabled: true})));
  await expect(pending).resolves.toEqual({admin_token_login_enabled: true});
});

it("rejects an invalid token paste before replacing a valid login or its local work", () => {
  setToken("valid-synthetic-token");
  localStorage.setItem("octos_learning_sessions_v1", "existing private lesson");
  expect(() => setToken("invalid\n凭据", true)).toThrow("invalid format");
  expect(getToken()).toBe("valid-synthetic-token");
  expect(localStorage.getItem("octos_learning_sessions_v1")).toBe("existing private lesson");
});

it("classifies a malformed saved token as invalid credentials before fetch", async () => {
  localStorage.setItem("octos_session_token", "invalid\n凭据");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(request("/api/auth/me")).rejects.toMatchObject({status: 401});
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not attach unrelated search preferences to authentication requests", async () => {
  setToken("valid-synthetic-token");
  localStorage.setItem("octos-settings", JSON.stringify({searchEngine: "无效偏好"}));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    expect(headers.get("Authorization")).toBe("Bearer valid-synthetic-token");
    expect(headers.has("X-Search-Engine")).toBe(false);
    return new Response(JSON.stringify({user: {id: "review"}}));
  }));
  await expect(request("/api/auth/me")).resolves.toEqual({user: {id: "review"}});
});
