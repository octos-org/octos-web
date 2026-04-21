import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth-context";
import * as authApi from "@/api/auth";
import type { AuthStatusResponse } from "@/api/types";

export function LoginPage() {
  const { login, loginWithToken, authStatus: initialAuthStatus } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Validate redirect target — only allow same-origin paths to prevent open redirect
  const rawRedirect = searchParams.get("redirect");
  const redirectTo = rawRedirect?.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : null;

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(
    initialAuthStatus,
  );
  const [mode, setMode] = useState<"otp" | "token">("otp");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (initialAuthStatus) {
      setAuthStatus(initialAuthStatus);
      return;
    }
    authApi.status().then(setAuthStatus).catch(() => {
      // Leave the page usable even if auth status probing fails.
    });
  }, [initialAuthStatus]);

  const scopedProfile = authStatus?.scoped_profile ?? null;
  const tokenModeEnabled = useMemo(
    () => !scopedProfile && Boolean(authStatus?.admin_token_login_enabled),
    [authStatus?.admin_token_login_enabled, scopedProfile],
  );
  const emailLoginEnabled = authStatus?.email_login_enabled ?? true;

  useEffect(() => {
    if (mode === "token" && !tokenModeEnabled) {
      setMode("otp");
    }
  }, [mode, tokenModeEnabled]);

  async function handleSendCode() {
    setError("");
    setSending(true);
    try {
      const resp = await authApi.sendCode(email);
      if (!resp.ok) {
        setError(resp.message || "Failed to send code");
        return;
      }
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setSending(false);
    }
  }

  async function handleVerify() {
    setError("");
    setSending(true);
    try {
      await login(email, code);
      navigate(redirectTo || "/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setSending(false);
    }
  }

  async function handleTokenLogin() {
    if (!adminToken.trim()) return;
    setError("");
    try {
      await loginWithToken(adminToken.trim());
      navigate(redirectTo || "/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid token");
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface-dark">
      <div className="w-full max-w-sm rounded-xl bg-surface p-8">
        <img
          src="/images/octos-logo-color.svg"
          alt="Octos"
          className="mb-4 h-9 w-auto select-none"
        />
        <h1 className="text-2xl font-bold text-text-strong">
          {scopedProfile ? `Sign in to ${scopedProfile.name}` : "octos"}
        </h1>
        <p className="mb-6 mt-2 text-sm text-muted">
          {scopedProfile
            ? "This login is scoped to the addressed account. Use the exact email registered for this sub-account."
            : authStatus?.bootstrap_mode
              ? "Bootstrap admin access is enabled on this host."
              : "Use an allowed or registered email to sign in."}
        </p>

        {/* Mode tabs */}
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setMode("otp")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
              mode === "otp"
                ? "bg-accent text-surface-dark"
                : "bg-surface-light text-muted hover:text-text-strong"
            }`}
          >
            Email OTP
          </button>
          {tokenModeEnabled && (
            <button
              onClick={() => setMode("token")}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                mode === "token"
                  ? "bg-accent text-surface-dark"
                  : "bg-surface-light text-muted hover:text-text-strong"
              }`}
            >
              Auth Token
            </button>
          )}
        </div>

        {error && (
          <div data-testid="login-error" className="mb-4 rounded-lg bg-red-900/30 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {!emailLoginEnabled && (
          <div className="mb-4 rounded-lg bg-amber-900/20 p-3 text-sm text-amber-300">
            {scopedProfile
              ? "Email OTP login is not enabled for this account yet."
              : "Email OTP login is not enabled on this host."}
          </div>
        )}

        {mode === "otp" ? (
          step === "email" ? (
            <div className="space-y-4">
              <input
                type="email"
                placeholder={
                  scopedProfile
                    ? "Registered account email"
                    : "Email address"
                }
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  isValidEmail(email) &&
                  emailLoginEnabled &&
                  handleSendCode()
                }
                className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-text placeholder-muted outline-none focus:border-accent"
              />
              <button
                onClick={handleSendCode}
                disabled={!isValidEmail(email) || sending || !emailLoginEnabled}
                className="w-full rounded-lg bg-accent py-3 font-medium text-surface-dark transition hover:bg-accent-dim disabled:opacity-50"
              >
                {sending ? "Sending..." : "Send Code"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Code sent to <span className="text-text-strong">{email}</span>
              </p>
              <input
                type="text"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                maxLength={6}
                className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-center text-2xl tracking-widest text-text placeholder-muted outline-none focus:border-accent"
              />
              <button
                onClick={handleVerify}
                disabled={code.length < 6 || sending}
                className="w-full rounded-lg bg-accent py-3 font-medium text-surface-dark transition hover:bg-accent-dim disabled:opacity-50"
              >
                {sending ? "Verifying..." : "Verify"}
              </button>
              <button
                onClick={() => {
                  setStep("email");
                  setCode("");
                }}
                className="w-full text-sm text-muted hover:text-text-strong"
              >
                Back
              </button>
            </div>
          )
        ) : (
          <div className="space-y-4">
            <input
              data-testid="token-input"
              type="password"
              placeholder="Admin auth token"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleTokenLogin()}
              className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-text placeholder-muted outline-none focus:border-accent"
            />
            <button
              data-testid="login-button"
              onClick={handleTokenLogin}
              disabled={!adminToken.trim()}
              className="w-full rounded-lg bg-accent py-3 font-medium text-surface-dark transition hover:bg-accent-dim disabled:opacity-50"
            >
              Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
