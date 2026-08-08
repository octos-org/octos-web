import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth-context";
import { SoloProfileForm } from "./solo-profile-form";
import * as authApi from "@/api/auth";
import { ApiError } from "@/api/client";
import type { AuthStatusResponse } from "@/api/types";

const RESEND_COUNTDOWN_S = 30;

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
  const [statusError, setStatusError] = useState(false);
  const [statusTick, setStatusTick] = useState(0);
  const [showToken, setShowToken] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [step, setStep] = useState<"email" | "code" | "solo">("email");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    // The context value provides the initial render. Always refresh it because
    // authentication settings may have changed since AuthProvider mounted
    // (for example, when an admin saves SMTP settings and then logs out).
    let active = true;
    authApi.status()
      .then((status) => {
        if (active) setAuthStatus(status);
      })
      .catch(() => {
        // Surface the failure with a retry instead of spinning forever on
        // "Checking sign-in options…" when the server is down.
        if (active) setStatusError(true);
      });
    return () => {
      active = false;
    };
  }, [statusTick]);

  // Resend-code countdown tick.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const scopedProfile = authStatus?.scoped_profile ?? null;
  const tokenModeEnabled = useMemo(
    () => !scopedProfile && Boolean(authStatus?.admin_token_login_enabled),
    [authStatus?.admin_token_login_enabled, scopedProfile],
  );
  const emailLoginEnabled = authStatus?.email_login_enabled ?? true;
  const soloEnabled = authStatus?.local_solo_enabled ?? false;
  // First run: solo is offered and the server says nobody has onboarded yet.
  // Show the create form as the primary content instead of making the user
  // click a button that fires a doomed 404 request.
  const soloFirstRun =
    soloEnabled && authStatus?.solo_profile_exists === false;

  const visibleMethods = [soloEnabled, emailLoginEnabled, tokenModeEnabled].filter(Boolean).length;

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
      setResendIn(RESEND_COUNTDOWN_S);
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
      setError(
        e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? "That token didn't work — check it and try again."
          : e instanceof Error
            ? e.message
            : "Invalid token",
      );
    }
  }

  async function handleSoloContinue() {
    setError("");
    setSending(true);
    try {
      // Re-login the existing local owner. First run (no profile yet) comes
      // back as a 404 → drop into the create form. Newer backends advertise
      // `solo_profile_exists` up front so this request is never wasted; the
      // fallthrough stays for older backends.
      await soloLogin();
      navigate(redirectTo || "/", { replace: true });
    } catch (e) {
      const is404 =
        (e instanceof ApiError && e.status === 404) ||
        (e instanceof Error && e.message.includes("404"));
      if (is404) {
        setStep("solo");
      } else {
        setError(e instanceof Error ? e.message : "Solo login failed");
      }
    } finally {
      setSending(false);
    }
  }

  const subtitle = scopedProfile
    ? "This login is scoped to the addressed account. Use the exact email registered for this sub-account."
    : soloFirstRun || step === "solo"
      ? "A local, single-user workspace. Set it up in one step."
      : authStatus === null
        ? statusError
          ? ""
          : "Sign in to your workspace."
        : authStatus.bootstrap_mode
          ? "Bootstrap admin access is enabled on this host."
          : !emailLoginEnabled
            ? soloEnabled
              ? "Continue with the local profile on this machine."
              : tokenModeEnabled
                ? "Sign in with your admin auth token."
                : "" // no methods — the warning box below says so
            : authStatus.allow_self_registration
              ? "Verify your email to create an account and sign in."
              : "Use an allowed or registered email to sign in.";

  const emailSection = (
    <>
      {step === "email" ? (
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
            autoComplete="email"
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
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && handleVerify()}
            maxLength={6}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            className="workbench-input w-full px-4 py-3 text-center text-2xl tracking-widest placeholder-muted"
          />
          <button
            onClick={handleVerify}
            disabled={code.length < 6 || sending}
            className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
          >
            {sending ? "Verifying..." : "Verify"}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button
              onClick={() => {
                setStep("email");
                setCode("");
              }}
              className="text-muted hover:text-text-strong"
            >
              Back
            </button>
            <button
              onClick={handleSendCode}
              disabled={resendIn > 0 || sending}
              className="text-muted hover:text-text-strong disabled:opacity-50"
            >
              {resendIn > 0 ? `Resend code (${resendIn}s)` : "Resend code"}
            </button>
          </div>
        </div>
      )}
    </>
  );

  const tokenSection = (
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
  );

  return (
    <div className="workbench-shell flex h-screen items-center justify-center px-4">
      <div className="workbench-panel w-full max-w-sm p-8">
        <img
          src="/images/octos-logo-color.svg"
          alt="Octos"
          className="mb-4 h-11 w-auto select-none"
        />
        <h1 className="text-2xl font-semibold tracking-tight text-text-strong">
          {scopedProfile
            ? `Sign in to ${scopedProfile.name}`
            : soloFirstRun || step === "solo"
              ? "Welcome to Octos"
              : "Octos"}
        </h1>
        {subtitle ? (
          <p className="mb-6 mt-2 text-sm text-muted">{subtitle}</p>
        ) : (
          // Keep the vertical rhythm when there is no subtitle to show.
          <div className="mb-6 mt-2" />
        )}

        {authStatus === null ? (
          statusError ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-(--workbench-danger-border) bg-(--workbench-danger-bg) p-3 text-sm text-(--workbench-danger-text)">
                Can't reach the server to load the sign-in options. Check
                that it is running, then retry.
              </div>
              <button
                onClick={() => {
                  setStatusError(false);
                  setStatusTick((t) => t + 1);
                }}
                className="workbench-button workbench-button-primary w-full py-3 font-medium"
              >
                Retry
              </button>
            </div>
          ) : (
            // The available sign-in methods are server-driven; don't flash
            // the wrong set while probing.
            <p className="text-sm text-muted">Checking sign-in options…</p>
          )
        ) : (
          <>
            {/* Primary block: solo (first-run form or one-click continue) */}
            {step === "solo" ? (
              <div className="mb-6 space-y-4">
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
            ) : soloFirstRun ? (
              <div className="mb-6">
                <SoloProfileForm
                  onDone={() => navigate(redirectTo || "/", { replace: true })}
                />
              </div>
            ) : soloEnabled ? (
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
              </div>
            ) : null}

            {error && (
              <div data-testid="login-error" className="mb-4 rounded-lg border border-(--workbench-danger-border) bg-(--workbench-danger-bg) p-3 text-sm text-(--workbench-danger-text)">
                {error}
              </div>
            )}

            {/* Secondary methods — only rendered when actually enabled. A
                disabled email login used to show a full (dead) form plus a
                low-contrast warning; now it simply doesn't appear. */}
            {step !== "solo" && (
              <>
                {soloEnabled && (emailLoginEnabled || tokenModeEnabled) && (
                  <div className="mb-6 flex items-center gap-3 text-xs text-muted">
                    <span className="h-px flex-1 bg-border" />
                    or sign in another way
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}

                {emailLoginEnabled && emailSection}

                {tokenModeEnabled &&
                  (visibleMethods === 1 || showToken ? (
                    tokenSection
                  ) : (
                    <button
                      onClick={() => setShowToken(true)}
                      className="mt-4 w-full text-center text-sm text-muted hover:text-text-strong"
                    >
                      Use an auth token
                    </button>
                  ))}

                {visibleMethods === 0 && (
                  <div className="rounded-lg border border-(--workbench-warning-border) bg-(--workbench-warning-bg) p-3 text-sm text-(--workbench-warning-text)">
                    No sign-in method is enabled on this host yet. Check the
                    server configuration.
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
