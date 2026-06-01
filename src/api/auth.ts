import { publicRequest, request } from "./client";
import type {
  AuthMeResponse,
  AuthStatusResponse,
  AuthVerifyResponse,
  SoloCreateResult,
  SoloLoginResult,
} from "./types";

export async function sendCode(email: string): Promise<{ ok: boolean; message?: string }> {
  return request("/api/auth/send-code", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function verify(
  email: string,
  code: string,
): Promise<AuthVerifyResponse> {
  return request("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

export async function me(): Promise<AuthMeResponse> {
  return request("/api/auth/me");
}

export async function status(): Promise<AuthStatusResponse> {
  return request("/api/auth/status");
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

// No-password solo login (Local-mode host opted in via `octos serve --solo`,
// loopback peer). `soloLogin` re-logs the existing owner — it rejects with an
// "HTTP 404" error when no solo profile exists yet, which the login page uses
// to fall through to the create form. `soloCreate` onboards a local profile
// and logs in atomically.
export async function soloLogin(): Promise<SoloLoginResult> {
  // publicRequest: a solo 403/404 is a policy denial, not a dead session — do
  // NOT let the /api/auth/* token reaper clear a signed-in user's tokens.
  return publicRequest("/api/auth/solo", { method: "POST" });
}

export async function soloCreate(body: {
  name: string;
  username: string;
  email: string;
}): Promise<SoloCreateResult> {
  return publicRequest("/api/auth/solo/create", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
