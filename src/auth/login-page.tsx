import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth-context";
import { SoloProfileForm } from "./solo-profile-form";
import * as authApi from "@/api/auth";
import type { AuthStatusResponse } from "@/api/types";

export function LoginPage() {
  const { login, loginWithToken, soloLogin, authStatus: initialAuthStatus } =
    useAuth();
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
  const [step, setStep] = useState<"email" | "code" | "solo">("email");
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
  const soloEnabled = authStatus?.local_solo_enabled ?? false;

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

  async function handleSoloContinue() {
    setError("");
    setSending(true);
    try {
      // Re-login the existing local owner. First run (no profile yet) comes
      // back as an "HTTP 404" error → drop into the create form.
      await soloLogin();
      navigate(redirectTo || "/", { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("404")) {
        setStep("solo");
      } else {
        setError(msg || "Solo login failed");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="workbench-shell flex h-screen items-center justify-center px-4">
      <div className="workbench-panel w-full max-w-sm p-8">
        <img
          src="/images/octos-logo-color.svg"
          alt="Octos"
          className="mb-4 h-9 w-auto select-none"
        />
        <h1 className="text-2xl font-semibold tracking-tight text-text-strong">
          {scopedProfile ? `Sign in to ${scopedProfile.name}` : "octos"}
        </h1>
        <p className="mb-6 mt-2 text-sm text-muted">
          {scopedProfile
            ? "This login is scoped to the addressed account. Use the exact email registered for this sub-account."
            : authStatus?.bootstrap_mode
              ? "Bootstrap admin access is enabled on this host."
              : "Use an allowed or registered email to sign in."}
        </p>

        {soloEnabled && step !== "solo" && (
          <div className="mb-6">
            <button
              data-testid="solo-continue"
              onClick={handleSoloContinue}
              disabled={sending}
              className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
            >
              {sending ? "Continuing..." : "Continue without a password"}
            </button>
            <p className="mt-2 text-center text-xs text-muted">
              Solo mode — local, single-user, stays on this machine.
            </p>
            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              or sign in with email
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        {/* Mode tabs */}
        {step !== "solo" && (
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setMode("otp")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
              mode === "otp"
                ? "bg-accent text-[#100d09]"
                : "bg-surface-container text-muted hover:text-text-strong"
            }`}
          >
            Email OTP
          </button>
          {tokenModeEnabled && (
            <button
              onClick={() => setMode("token")}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                mode === "token"
                  ? "bg-accent text-[#100d09]"
                  : "bg-surface-container text-muted hover:text-text-strong"
              }`}
            >
              Auth Token
            </button>
          )}
        </div>
        )}

        {error && (
          <div data-testid="login-error" className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {!emailLoginEnabled && (
          <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-300">
            {scopedProfile
              ? "Email OTP login is not enabled for this account yet."
              : "Email OTP login is not enabled on this host."}
          </div>
        )}

        {step === "solo" ? (
          <div className="space-y-4">
            <SoloProfileForm
              onDone={() => navigate(redirectTo || "/", { replace: true })}
            />
            <button
              onClick={() => {
                setStep("email");
                setError("");
              }}
              className="w-full text-sm text-muted hover:text-text-strong"
            >
              Back
            </button>
          </div>
        ) : mode === "otp" ? (
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
                className="workbench-input w-full px-4 py-3 placeholder-muted"
              />
              <button
                onClick={handleSendCode}
                disabled={!isValidEmail(email) || sending || !emailLoginEnabled}
                className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
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
                className="workbench-input w-full px-4 py-3 text-center text-2xl tracking-widest placeholder-muted"
              />
              <button
                onClick={handleVerify}
                disabled={code.length < 6 || sending}
                className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
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
              className="workbench-input w-full px-4 py-3 placeholder-muted"
            />
            <button
              data-testid="login-button"
              onClick={handleTokenLogin}
              disabled={!adminToken.trim()}
              className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
            >
              Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
