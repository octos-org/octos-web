import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./auth-context";
import * as authApi from "@/api/auth";

export function LoginPage() {
  const { login, loginWithToken } = useAuth();
  const navigate = useNavigate();

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
    navigate("/", { replace: true });
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface-dark">
      <div className="w-full max-w-sm rounded-xl bg-surface p-8">
        <h1 className="mb-6 text-2xl font-bold text-white">MoFa</h1>

        {/* Mode tabs */}
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setMode("otp")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
              mode === "otp"
                ? "bg-accent text-surface-dark"
                : "bg-surface-light text-muted hover:text-white"
            }`}
          >
            邮箱验证
          </button>
          <button
            onClick={() => setMode("token")}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
              mode === "token"
                ? "bg-accent text-surface-dark"
                : "bg-surface-light text-muted hover:text-white"
            }`}
          >
            令牌登录
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
                placeholder="邮箱地址"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
                className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-white placeholder-muted outline-none focus:border-accent"
              />
              <button
                onClick={handleSendCode}
                disabled={!email || sending}
                className="w-full rounded-lg bg-accent py-3 font-medium text-surface-dark transition hover:bg-accent-dim disabled:opacity-50"
              >
                {sending ? "发送中..." : "发送验证码"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                验证码已发送到 <span className="text-white">{email}</span>
              </p>
              <input
                type="text"
                placeholder="6 位验证码"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                maxLength={6}
                className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-center text-2xl tracking-widest text-white placeholder-muted outline-none focus:border-accent"
              />
              <button
                onClick={handleVerify}
                disabled={code.length < 6 || sending}
                className="w-full rounded-lg bg-accent py-3 font-medium text-surface-dark transition hover:bg-accent-dim disabled:opacity-50"
              >
                {sending ? "验证中..." : "验证"}
              </button>
              <button
                onClick={() => {
                  setStep("email");
                  setCode("");
                }}
                className="w-full text-sm text-muted hover:text-white"
              >
                返回
              </button>
            </div>
          )
        ) : (
          <div className="space-y-4">
            <input
              data-testid="token-input"
              type="password"
              placeholder="管理员令牌"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleTokenLogin()}
              className="w-full rounded-lg border border-border bg-surface-light px-4 py-3 text-white placeholder-muted outline-none focus:border-accent"
            />
            <button
              data-testid="login-button"
              onClick={handleTokenLogin}
              disabled={!adminToken.trim()}
              className="w-full rounded-lg bg-accent py-3 font-medium text-surface-dark transition hover:bg-accent-dim disabled:opacity-50"
            >
              登录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
