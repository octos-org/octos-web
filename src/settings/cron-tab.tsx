// Schedule tab — user-scoped cron job list + enable toggle over
// `/api/my/cron*` (web parity audit P3 item 7: the book documents
// scheduled tasks, but the dashboard had no cron surface — only the
// admin-token list). Creation/editing stays with the agent (`cron`
// tool) and CLI; this surface reads the schedule and flips jobs on
// and off.
//
// Ownership rule mirrored from the server: while the profile's
// gateway process runs, IT owns cron.json — toggles 409 with
// `gateway_running`, so the UI disables the switches and points at
// the Profile tab's stop/start controls instead of offering writes
// that would be refused.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlarmClock, Loader2, RefreshCw } from "lucide-react";

import {
  cronToggleRefusalReason,
  formatSettingsError,
  getMyCron,
  setMyCronEnabled,
  type CronJobRow,
  type CronOverview,
  type CronScheduleWire,
} from "./settings-api";

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-border"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function describeSchedule(schedule: CronScheduleWire): string {
  switch (schedule.kind) {
    case "At": {
      const when = new Date(schedule.at_ms);
      return Number.isNaN(when.getTime())
        ? "once"
        : `once at ${when.toLocaleString()}`;
    }
    case "Every": {
      // Preserve remainders: 90s is "every 1m 30s", not "every 2m"
      // (codex web#266 r1 P2 — rounding misstated valid intervals).
      const totalSecs = Math.round(schedule.every_ms / 1000);
      if (totalSecs < 60) return `every ${totalSecs}s`;
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      if (mins < 60) {
        return secs === 0 ? `every ${mins}m` : `every ${mins}m ${secs}s`;
      }
      const parts = [`${Math.floor(mins / 60)}h`];
      if (mins % 60 !== 0) parts.push(`${mins % 60}m`);
      if (secs !== 0) parts.push(`${secs}s`);
      return `every ${parts.join(" ")}`;
    }
    case "Cron":
      return schedule.expr;
  }
}

function JobRow({
  job,
  disabledReason,
  onToggle,
  busy,
}: {
  job: CronJobRow;
  disabledReason: string | null;
  onToggle: (enabled: boolean) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-surface-dark/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{job.name}</span>
          <span className="shrink-0 rounded-md bg-surface-container/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted">
            {describeSchedule(job.schedule)}
          </span>
          {job.timezone ? (
            <span className="shrink-0 text-[10px] text-muted">{job.timezone}</span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted">{job.message}</p>
        <p className="text-[11px] text-muted/80">
          {job.enabled && job.next_in ? <>next in {job.next_in}</> : null}
          {job.enabled && job.next_in && job.last_run ? " · " : null}
          {job.last_run ? (
            <>
              last ran {new Date(job.last_run).toLocaleString()}
              {job.last_status ? ` (${job.last_status})` : ""}
            </>
          ) : null}
        </p>
      </div>
      {busy ? <Loader2 size={14} className="animate-spin text-muted" /> : null}
      <Toggle
        checked={job.enabled}
        onChange={onToggle}
        disabled={busy || disabledReason !== null}
        label={`Toggle ${job.name}`}
      />
    </div>
  );
}

export function CronTab() {
  const [overview, setOverview] = useState<CronOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  // Generation gate: a Reload GET that was in flight when a toggle
  // PUT resolved would overwrite the fresh server row with the old
  // snapshot (codex web#266 r1 P2). Every toggle bumps the
  // generation; a load only applies if no toggle landed after it
  // started.
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getMyCron();
      if (gen === loadGenRef.current) setOverview(next);
    } catch (err) {
      if (gen === loadGenRef.current) {
        setError(formatSettingsError(err, "Failed to load schedule."));
      }
    } finally {
      // Unconditional: an invalidated load must not leave the spinner
      // wedged on (its RESULT is gated above, its liveness is not).
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (job: CronJobRow, enabled: boolean) => {
    setTogglingId(job.id);
    setToggleError(null);
    try {
      const resp = await setMyCronEnabled(job.id, enabled);
      // Invalidate any in-flight GET that started before this PUT
      // resolved — its snapshot predates the toggle.
      loadGenRef.current++;
      setOverview((prev) =>
        prev
          ? {
              ...prev,
              jobs: prev.jobs.map((j) => (j.id === job.id ? resp.job : j)),
            }
          : prev,
      );
    } catch (err) {
      if (cronToggleRefusalReason(err) === "gateway_running") {
        // The gateway grabbed ownership since our last load — reflect
        // reality rather than showing a raw error.
        setToggleError(
          "The gateway is running and owns the schedule — stop it from the Profile tab to edit.",
        );
        void load();
      } else {
        setToggleError(formatSettingsError(err, "Failed to update the job."));
      }
    } finally {
      setTogglingId(null);
    }
  };

  if (loading && !overview) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading schedule…
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="glass-section space-y-3 p-5">
        <p className="text-sm text-red-400">{error}</p>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-text-strong hover:border-accent/30 transition"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!overview) return null;

  const lockReason = overview.gateway_running
    ? "The gateway is running and owns the schedule."
    : null;

  return (
    <div className="space-y-5">
      <section className="glass-section p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="workbench-icon-tile flex h-10 w-10 shrink-0 items-center justify-center">
            <AlarmClock size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Schedule</h3>
            <p className="text-xs text-muted">
              Recurring jobs the agent runs for you. Ask the agent to schedule
              something new — here you can pause and resume what exists.
            </p>
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-text-strong hover:border-accent/30 disabled:opacity-40 transition"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
        </div>
        {error ? (
          <p className="mt-3 text-xs text-red-400" data-testid="cron-reload-error">
            {error} Showing the last loaded snapshot.
          </p>
        ) : null}
        {lockReason ? (
          <p
            className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500"
            data-testid="cron-gateway-lock"
          >
            {lockReason} Toggles apply when it is stopped (Profile tab →
            stop), and take effect on the next start.
          </p>
        ) : null}
        {toggleError ? (
          <p className="mt-3 text-xs text-red-400" data-testid="cron-toggle-error">
            {toggleError}
          </p>
        ) : null}
      </section>

      {overview.jobs.length === 0 ? (
        <section className="glass-section p-5">
          <p className="text-sm text-muted">
            No scheduled jobs yet. Ask the agent to remind you about something
            or run a task on a schedule and it will appear here.
          </p>
        </section>
      ) : (
        <section className="glass-section space-y-2 p-5">
          {overview.jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              disabledReason={lockReason}
              busy={togglingId === job.id}
              onToggle={(enabled) => void toggle(job, enabled)}
            />
          ))}
        </section>
      )}
    </div>
  );
}
