import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearToken, getToken, request, requestBlob, restoreIdentityCache, setToken } from "./client";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it("does not let account A's late authentication rejection log out account B", async () => {
  setToken("token-a");
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
  const pending = request("/api/auth/me");
  setToken("token-b");
  respond(new Response("Expired A", { status: 401 }));
  await expect(pending).rejects.toMatchObject({ status: 409 });
  expect(getToken()).toBe("token-b");
});

it("rejects account A's delayed binary response after switching to B", async () => {
  setToken("token-a");
  let respond!: (blob: Blob) => void;
  const bytes = new Promise<Blob>((resolve) => { respond = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => bytes }));
  const pending = requestBlob("/api/files/private-a");
  await Promise.resolve();
  setToken("token-b");
  respond(new Blob(["private A bytes"]));
  await expect(pending).rejects.toMatchObject({ status: 409 });
});

it("preserves local-only work for its verified owner without exposing it to the next account", () => {
  setToken("token-a");
  restoreIdentityCache("profile:a");
  localStorage.setItem("octos_learning_sessions_v1", "private lesson A");
  localStorage.setItem("octos_home_events", "private calendar A");
  clearToken();
  setToken("token-b");
  restoreIdentityCache("profile:b");
  expect(localStorage.getItem("octos_learning_sessions_v1")).toBeNull();
  expect(localStorage.getItem("octos_home_events")).toBeNull();
  localStorage.setItem("octos_home_events", "calendar B");
  clearToken();
  setToken("new-token-a");
  restoreIdentityCache("profile:a");
  expect(localStorage.getItem("octos_learning_sessions_v1")).toBe("private lesson A");
  expect(localStorage.getItem("octos_home_events")).toBe("private calendar A");
});

it("never attributes an unowned legacy cache to a newly verified profile", () => {
  localStorage.setItem("octos_home_events", "unowned private calendar");
  setToken("new-login");
  restoreIdentityCache("profile:new");
  expect(localStorage.getItem("octos_home_events")).toBeNull();
  expect(Object.keys(localStorage).some((key) => key.includes("unowned%3A"))).toBe(true);
});
