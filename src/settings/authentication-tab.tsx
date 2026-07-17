import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  Send,
  ShieldCheck,
  UserPlus,
} from "lucide-react";

import {
  fetchAuthenticationSettings,
  formatSettingsError,
  saveAuthenticationSettings,
  sendAuthenticationTestEmail,
} from "./settings-api";

type RegistrationMode = "open" | "restricted";

interface FormState {
  host: string;
  port: string;
  username: string;
  password: string;
  fromAddress: string;
  registrationMode: RegistrationMode;
  passwordConfigured: boolean;
}

const EMPTY_FORM: FormState = {
  host: "",
  port: "587",
  username: "",
  password: "",
  fromAddress: "",
  registrationMode: "restricted",
  passwordConfigured: false,
};

function validateSettings(form: FormState): string | null {
  if (!form.host.trim()) return "SMTP host is required.";
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return "SMTP port must be an integer between 1 and 65535.";
  }
  if (!form.fromAddress.includes("@")) {
    return "From address must contain an email address.";
  }
  return null;
}

export function AuthenticationTab() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthenticationSettings()
      .then((settings) => {
        if (cancelled) return;
        setForm({
          host: settings.host,
          port: String(settings.port),
          username: settings.username,
          password: "",
          fromAddress: settings.from_address,
          registrationMode: settings.allow_self_registration
            ? "open"
            : "restricted",
          passwordConfigured: settings.password_configured,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            formatSettingsError(err, "Failed to load authentication settings."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaveMessage(null);
    setSaveError(null);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateSettings(form);
    if (validationError) {
      setSaveError(validationError);
      setSaveMessage(null);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const password = form.password;
      await saveAuthenticationSettings({
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim(),
        from_address: form.fromAddress.trim(),
        allow_self_registration: form.registrationMode === "open",
        ...(password ? { password } : {}),
      });
      setForm((current) => ({
        ...current,
        password: "",
        passwordConfigured: current.passwordConfigured || Boolean(password),
      }));
      setSaveMessage("Authentication settings saved and applied.");
    } catch (err) {
      setSaveError(
        formatSettingsError(err, "Failed to save authentication settings."),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (event: FormEvent) => {
    event.preventDefault();
    const recipient = testRecipient.trim();
    if (!recipient.includes("@")) {
      setTestError("Enter a valid test recipient email address.");
      setTestMessage(null);
      return;
    }

    setTesting(true);
    setTestError(null);
    setTestMessage(null);
    try {
      const result = await sendAuthenticationTestEmail(recipient);
      if (result.ok) {
        setTestMessage(result.message ?? `Test email sent to ${recipient}.`);
      } else {
        setTestError(result.error ?? "The server could not send the test email.");
      }
    } catch (err) {
      setTestError(formatSettingsError(err, "Failed to send the test email."));
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="glass-section rounded-lg border border-red-400/30 p-6 text-sm text-red-300"
      >
        <div className="flex items-center gap-2">
          <AlertCircle size={18} />
          {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={(event) => void handleSave(event)} className="space-y-6">
        <section className="glass-section rounded-lg p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Registration Access
              </h3>
              <p className="text-xs text-muted">
                Choose who can create a user through email verification
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label
              className={`cursor-pointer rounded-xl border p-4 transition ${
                form.registrationMode === "open"
                  ? "border-accent/60 bg-accent/10"
                  : "border-border/40 bg-surface-container/40 hover:border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="registration-mode"
                  value="open"
                  checked={form.registrationMode === "open"}
                  onChange={() => updateForm("registrationMode", "open")}
                  className="mt-1 accent-[var(--accent)]"
                />
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-text-strong">
                    <UserPlus size={16} />
                    Open registration
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Anyone who verifies an email OTP can create their own user and profile.
                  </p>
                </div>
              </div>
            </label>

            <label
              className={`cursor-pointer rounded-xl border p-4 transition ${
                form.registrationMode === "restricted"
                  ? "border-accent/60 bg-accent/10"
                  : "border-border/40 bg-surface-container/40 hover:border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="registration-mode"
                  value="restricted"
                  checked={form.registrationMode === "restricted"}
                  onChange={() => updateForm("registrationMode", "restricted")}
                  className="mt-1 accent-[var(--accent)]"
                />
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-text-strong">
                    <KeyRound size={16} />
                    Restricted registration
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Only existing users and addresses listed under Users → Allowed Emails can sign in.
                  </p>
                </div>
              </div>
            </label>
          </div>

          {form.registrationMode === "open" && (
            <div
              role="note"
              aria-label="Open registration warning"
              className="mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-xs [background:var(--workbench-warning-bg)] [border-color:var(--workbench-warning-border)] [color:var(--workbench-warning-text)]"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">
                  Anyone with an email address can register
                </p>
                <p className="mt-1 leading-relaxed">
                  Use open registration for local testing. On an internet-facing server,
                  each verified email can create a profile and consume resources.
                </p>
              </div>
            </div>
          )}
        </section>

        <section className="glass-section rounded-lg p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Mail size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Email OTP Delivery
              </h3>
              <p className="text-xs text-muted">
                SMTP used to send login verification codes
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-muted">
              SMTP host
              <input
                aria-label="SMTP host"
                value={form.host}
                onChange={(event) => updateForm("host", event.target.value)}
                placeholder="smtp.example.com"
                autoComplete="off"
                className="workbench-input w-full px-3 py-2.5 text-sm text-text-strong"
              />
            </label>
            <label className="space-y-1.5 text-xs text-muted">
              SMTP port
              <input
                aria-label="SMTP port"
                type="number"
                min={1}
                max={65_535}
                value={form.port}
                onChange={(event) => updateForm("port", event.target.value)}
                className="workbench-input w-full px-3 py-2.5 text-sm text-text-strong"
              />
            </label>
            <label className="space-y-1.5 text-xs text-muted">
              SMTP username
              <input
                aria-label="SMTP username"
                value={form.username}
                onChange={(event) => updateForm("username", event.target.value)}
                autoComplete="username"
                className="workbench-input w-full px-3 py-2.5 text-sm text-text-strong"
              />
            </label>
            <label className="space-y-1.5 text-xs text-muted">
              SMTP password
              <input
                aria-label="SMTP password"
                type="password"
                value={form.password}
                onChange={(event) => updateForm("password", event.target.value)}
                placeholder={
                  form.passwordConfigured
                    ? "Leave blank to keep the saved password"
                    : "Enter SMTP password"
                }
                autoComplete="new-password"
                className="workbench-input w-full px-3 py-2.5 text-sm text-text-strong"
              />
              {form.passwordConfigured && (
                <span className="flex items-center gap-1 text-[11px] text-green-400">
                  <CheckCircle2 size={11} />
                  A password is already configured. It is never returned to the browser.
                </span>
              )}
              {!form.passwordConfigured && (
                <span className="text-[11px] text-muted/70">
                  Leave blank only when the server already provides SMTP credentials,
                  such as through SMTP_PASSWORD.
                </span>
              )}
            </label>
            <label className="space-y-1.5 text-xs text-muted sm:col-span-2">
              From address
              <input
                aria-label="From address"
                value={form.fromAddress}
                onChange={(event) => updateForm("fromAddress", event.target.value)}
                placeholder="Octos <login@example.com>"
                className="workbench-input w-full px-3 py-2.5 text-sm text-text-strong"
              />
            </label>
          </div>

          {(saveError || saveMessage) && (
            <div
              role={saveError ? "alert" : "status"}
              className={`mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-xs ${
                saveError
                  ? "border-red-400/30 bg-red-400/5 text-red-300"
                  : "border-green-400/30 bg-green-400/5 text-green-300"
              }`}
            >
              {saveError ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
              {saveError ?? saveMessage}
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
              Save authentication settings
            </button>
          </div>
        </section>
      </form>

      <section className="glass-section rounded-lg p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Send size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Test Login Email
            </h3>
            <p className="text-xs text-muted">
              Uses the currently saved SMTP configuration
            </p>
          </div>
        </div>

        <form
          onSubmit={(event) => void handleTest(event)}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="flex-1 space-y-1.5 text-xs text-muted">
            Test recipient
            <input
              aria-label="Test recipient"
              type="email"
              value={testRecipient}
              onChange={(event) => {
                setTestRecipient(event.target.value);
                setTestMessage(null);
                setTestError(null);
              }}
              placeholder="you@example.com"
              className="workbench-input w-full px-3 py-2.5 text-sm text-text-strong"
            />
          </label>
          <button
            type="submit"
            disabled={testing}
            className="flex shrink-0 items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2.5 text-sm font-medium text-accent transition hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            Send test email
          </button>
        </form>

        {(testError || testMessage) && (
          <div
            role={testError ? "alert" : "status"}
            className={`mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-xs ${
              testError
                ? "border-red-400/30 bg-red-400/5 text-red-300"
                : "border-green-400/30 bg-green-400/5 text-green-300"
            }`}
          >
            {testError ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
            {testError ?? testMessage}
          </div>
        )}
      </section>
    </div>
  );
}
