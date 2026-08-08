import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./auth-context";

/**
 * The solo onboarding form: just a display name → `soloCreate`. The server
 * derives the username/email from the name (see `derive_solo_credentials`)
 * — a local, password-free profile should not make a first-time user fill
 * out three fields and a username regex.
 *
 * Renders a real <form> so Enter submits. On success calls `onDone` if
 * provided, otherwise navigates to `/`.
 */
export function SoloProfileForm({ onDone }: { onDone?: () => void }) {
  const { soloCreate } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  const nameOk = trimmed.length > 0 && trimmed.length <= 128;
  const showNameHint = touched && trimmed.length > 128;
  const canSubmit = nameOk && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    try {
      await soloCreate({ name: trimmed });
      if (onDone) onDone();
      else navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create profile");
      setSubmitting(false);
    }
  }

  return (
    <form
      className="space-y-4"
      data-testid="solo-profile-form"
      onSubmit={handleSubmit}
      noValidate
    >
      <p className="text-sm text-muted">
        This stays on this machine — no password, no email code.
      </p>
      <div>
        <input
          data-testid="solo-name"
          type="text"
          aria-label="What should we call you?"
          placeholder="What should we call you?"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={submitting}
          autoFocus
          autoComplete="name"
          aria-invalid={showNameHint}
          aria-describedby={showNameHint ? "solo-name-hint" : undefined}
          className="workbench-input w-full px-4 py-3 placeholder-muted"
        />
        {showNameHint && (
          <p id="solo-name-hint" className="mt-1 text-xs text-red-400">
            Keep it under 128 characters.
          </p>
        )}
      </div>
      {error && (
        <p data-testid="solo-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <button
        data-testid="solo-submit"
        type="submit"
        disabled={!canSubmit}
        className="workbench-button workbench-button-primary w-full py-3 font-medium disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create profile & continue"}
      </button>
    </form>
  );
}
