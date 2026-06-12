import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./auth-context";

// Client-side mirror of the backend validators (`validate_local_name`,
// `normalize_local_username`, `validate_local_email`). UX nicety only — the
// server stays authoritative and any rejection it returns is shown below.
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * The solo onboarding form: full name / username / email → `soloCreate`.
 * On success calls `onDone` if provided, otherwise navigates to `/`.
 */
export function SoloProfileForm({ onDone }: { onDone?: () => void }) {
  const { soloCreate } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const nameOk = name.trim().length > 0 && name.trim().length <= 128;
  const usernameOk =
    username.trim().length > 0 &&
    username.trim().length <= 64 &&
    USERNAME_RE.test(username.trim());
  const emailOk = EMAIL_RE.test(email.trim());
  const canSubmit = nameOk && usernameOk && emailOk && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    try {
      await soloCreate({
        name: name.trim(),
        username: username.trim(),
        email: email.trim(),
      });
      if (onDone) onDone();
      else navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create profile");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="solo-profile-form">
      <p className="text-sm text-muted">
        Create a local profile. It stays on this machine — no email code is sent.
      </p>
      <input
        data-testid="solo-name"
        type="text"
        placeholder="Full name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={submitting}
        autoFocus
        className="workbench-input w-full px-4 py-3 placeholder-muted"
      />
      <div>
        <input
          data-testid="solo-username"
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={submitting}
          className="workbench-input w-full px-4 py-3 font-mono placeholder-muted"
        />
        <p className="mt-1 text-xs text-muted">
          Letters, digits, dot, hyphen or underscore.
        </p>
      </div>
      <input
        data-testid="solo-email"
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={submitting}
        className="workbench-input w-full px-4 py-3 placeholder-muted"
      />
      {error && (
        <p data-testid="solo-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <button
        data-testid="solo-submit"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create profile & continue"}
      </button>
    </div>
  );
}
