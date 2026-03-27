import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth-context";
import * as authApi from "@/api/auth";

export function LoginPage() {
  const { login, loginWithToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Validate redirect target — only allow same-origin paths to prevent open redirect
  const rawRedirect = searchParams.get("redirect");
  const redirectTo = rawRedirect?.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : null;

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const [mode, setMode] = useState<"otp" | "token">("otp");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSendCode() {
    setError("");
    setSending(true);
    try {
      await authApi.sendCode(email);
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
      if (redirectTo) {
        window.location.href = redirectTo;
        return;
      }
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setSending(false);
    }
  }

  function handleTokenLogin() {
    if (!adminToken.trim()) return;
    loginWithToken(adminToken.trim());
    if (redirectTo) {
      window.location.href = redirectTo;
      return;
    }
    navigate("/", { replace: true });
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface-dark">
      <div className="w-full max-w-sm rounded-xl bg-surface p-8">
        <h1 className="mb-6 text-2xl font-bold text-text-strong">octos</h1>

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
        </div>

        {error && (
          <div data-testid="login-error" className="mb-4 rounded-lg bg-red-900/30 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {mode === "otp" ? (
          step === "email" ? (
            <div className="space-y-4">
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && isValidEmail(email) && handleSendCode()}
                className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-text placeholder-muted outline-none focus:border-accent"
              />
              <button
                onClick={handleSendCode}
                disabled={!isValidEmail(email) || sending}
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
