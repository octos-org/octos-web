import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle,
  Download,
  Loader2,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  disableOminixModel,
  downloadOminixModel,
  enableOminixModel,
  fetchOminixAvailableModels,
  fetchOminixLogs,
  fetchOminixPlatformModels,
  fetchPlatformSkillsStatus,
  installPlatformSkill,
  removeOminixModel,
  removePlatformSkill,
  runOminixServiceAction,
  type OminixCatalogModel,
  type OminixLogResponse,
  type OminixServiceAction,
  type PlatformSkillInfo,
  type PlatformSkillsStatus,
} from "./settings-api";

type Role = "asr" | "tts";

type PendingAction =
  | { kind: "service"; action: OminixServiceAction }
  | { kind: "remove-local-model"; modelId: string }
  | { kind: "disable-model"; modelId: string }
  | { kind: "download-model"; modelId: string }
  | { kind: "remove-skill"; name: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusClass(ok: boolean) {
  return ok
    ? "border-green-400/30 bg-green-400/5 text-green-400"
    : "border-red-400/30 bg-red-400/5 text-red-400";
}

function compactText(value: string | null | undefined, fallback = "-") {
  return value && value.trim() ? value : fallback;
}

function modelStatus(model: OminixCatalogModel) {
  return model.status?.trim().toLowerCase() ?? "";
}

function isModelReady(model: OminixCatalogModel) {
  return ["ready", "downloaded", "installed"].includes(modelStatus(model));
}

function roleForModel(model: OminixCatalogModel): Role | null {
  const role = model.role?.trim().toLowerCase();
  return role === "asr" || role === "tts" ? role : null;
}

function roleOptionsForModel(model: OminixCatalogModel): Role[] {
  const explicitRole = roleForModel(model);
  if (explicitRole) return [explicitRole];

  const haystack = [
    model.id,
    model.name,
    model.category,
    ...(model.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const roles: Role[] = [];
  if (/\b(asr|stt|transcrib|speech-to-text)\b/.test(haystack)) roles.push("asr");
  if (/\b(tts|text-to-speech|synthes)/.test(haystack)) roles.push("tts");
  return roles.length ? roles : ["asr", "tts"];
}

function resultMessage(result: unknown) {
  if (!result || typeof result !== "object") return "Action completed";
  const value = result as {
    message?: unknown;
    detail?: unknown;
    status?: unknown;
  };
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.detail === "string" && value.detail.trim()) return value.detail;
  if (typeof value.status === "string" && value.status.trim()) return value.status;
  return "Action completed";
}

function assertActionOk(result: unknown) {
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    (result as { ok?: unknown }).ok === false
  ) {
    throw new Error(resultMessage(result));
  }
}

function Section({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="glass-section rounded-lg p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            {icon}
          </div>
          <h3 className="text-sm font-semibold text-text-strong">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  ariaLabel,
  tone = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  tone?: "default" | "good" | "danger" | "warn";
}) {
  const toneClass = {
    default: "border-border/40 text-muted hover:bg-surface-container hover:text-text-strong",
    good: "border-green-400/20 bg-green-400/5 text-green-400 hover:bg-green-400/10",
    danger: "border-red-400/20 bg-red-400/5 text-red-400 hover:bg-red-400/10",
    warn: "border-yellow-400/20 bg-yellow-400/5 text-yellow-400 hover:bg-yellow-400/10",
  }[tone];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 ${toneClass}`}
    >
      {children}
    </button>
  );
}

function ModelMeta({ model }: { model: OminixCatalogModel }) {
  const size = model.storage?.total_size_display;
  const memory = model.runtime?.memory_required_mb;
  const bits = [
    model.category,
    model.role,
    model.status,
    size,
    memory ? `${memory} MB` : null,
  ].filter(Boolean);

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {bits.map((bit) => (
        <span
          key={String(bit)}
          className="rounded-md bg-surface-dark/50 px-1.5 py-0.5 text-[10px] font-medium text-muted"
        >
          {bit}
        </span>
      ))}
    </div>
  );
}

function PlatformModelRow({
  model,
  busy,
  onDownload,
  onDisable,
}: {
  model: OminixCatalogModel;
  busy: boolean;
  onDownload: (modelId: string) => void;
  onDisable: (modelId: string) => void;
}) {
  const ready = isModelReady(model);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/30 bg-surface-container/50 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-text-strong">
            {compactText(model.name, model.id)}
          </span>
          <span className="rounded-md bg-green-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
            Enabled for Octos
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
          {model.id}
        </div>
        <ModelMeta model={model} />
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
        {!ready && (
          <SmallButton
            disabled={busy}
            ariaLabel={`Download ${model.id}`}
            tone="good"
            onClick={() => onDownload(model.id)}
          >
            <Download size={12} />
            Download
          </SmallButton>
        )}
        <SmallButton
          disabled={busy}
          ariaLabel={`Disable ${model.id}`}
          tone="warn"
          onClick={() => onDisable(model.id)}
        >
          Disable
        </SmallButton>
      </div>
    </div>
  );
}

function AvailableModelRow({
  model,
  busy,
  onEnable,
  onDisable,
  onDownload,
  onRemoveLocal,
}: {
  model: OminixCatalogModel;
  busy: boolean;
  onEnable: (modelId: string, role: Role) => void;
  onDisable: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onRemoveLocal: (modelId: string) => void;
}) {
  const enabled = Boolean(model.enabled_for_octos);
  const ready = isModelReady(model);
  const roleOptions = roleOptionsForModel(model);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/30 bg-surface-container/50 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-text-strong">
            {compactText(model.name, model.id)}
          </span>
          {enabled && (
            <span className="rounded-md bg-green-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
              Enabled
            </span>
          )}
          {ready && (
            <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              Downloaded
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
          {model.id}
        </div>
        <ModelMeta model={model} />
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
        {enabled && !ready && (
          <SmallButton
            disabled={busy}
            ariaLabel={`Download ${model.id}`}
            tone="good"
            onClick={() => onDownload(model.id)}
          >
            <Download size={12} />
            Download
          </SmallButton>
        )}
        {!enabled &&
          roleOptions.map((role) => (
            <SmallButton
              key={role}
              disabled={busy}
              ariaLabel={`Enable ${role.toUpperCase()} ${model.id}`}
              tone="good"
              onClick={() => onEnable(model.id, role)}
            >
              Enable {role.toUpperCase()}
            </SmallButton>
          ))}
        {enabled && (
          <SmallButton
            disabled={busy}
            ariaLabel={`Disable ${model.id}`}
            tone="warn"
            onClick={() => onDisable(model.id)}
          >
            Disable
          </SmallButton>
        )}
        {ready && (
          <SmallButton
            disabled={busy}
            ariaLabel={`Remove local model ${model.id}`}
            tone="danger"
            onClick={() => onRemoveLocal(model.id)}
          >
            <Trash2 size={12} />
            Remove Local
          </SmallButton>
        )}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  busy,
  onInstall,
  onRemove,
}: {
  skill: PlatformSkillInfo;
  busy: boolean;
  onInstall: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/30 bg-surface-container/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-medium text-text-strong">{skill.name}</div>
        <div className="mt-0.5 text-xs text-muted">
          {skill.installed ? "Installed" : "Not installed"}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
        {!skill.installed && (
          <SmallButton
            disabled={busy}
            ariaLabel={`Install platform skill ${skill.name}`}
            tone="good"
            onClick={() => onInstall(skill.name)}
          >
            Install
          </SmallButton>
        )}
        {skill.installed && (
          <SmallButton
            disabled={busy}
            ariaLabel={`Remove platform skill ${skill.name}`}
            tone="danger"
            onClick={() => onRemove(skill.name)}
          >
            Remove
          </SmallButton>
        )}
      </div>
    </div>
  );
}

function ConfirmBar({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PendingAction;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const label =
    pending.kind === "service"
      ? `${pending.action} ominix-api service?`
      : pending.kind === "download-model"
        ? `Download ${pending.modelId}?`
        : pending.kind === "remove-local-model"
          ? `Remove local model ${pending.modelId}?`
          : pending.kind === "disable-model"
            ? `Disable ${pending.modelId} for Octos?`
            : `Remove platform skill ${pending.name}?`;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-yellow-400/30 bg-yellow-400/5 px-4 py-3">
      <AlertCircle size={16} className="shrink-0 text-yellow-400" />
      <span className="flex-1 text-xs font-medium text-yellow-400">{label}</span>
      <button
        onClick={onConfirm}
        disabled={busy}
        className="rounded-lg bg-yellow-400/20 px-3 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-400/30 disabled:opacity-40"
      >
        Confirm
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className="rounded-lg px-3 py-1 text-xs text-muted hover:text-text-strong disabled:opacity-40"
      >
        Cancel
      </button>
    </div>
  );
}

export function OminixTab() {
  const [status, setStatus] = useState<PlatformSkillsStatus | null>(null);
  const [platformModels, setPlatformModels] = useState<OminixCatalogModel[]>([]);
  const [availableModels, setAvailableModels] = useState<OminixCatalogModel[]>([]);
  const [logs, setLogs] = useState<OminixLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [statusResult, platformResult, availableResult, logsResult] =
      await Promise.allSettled([
        fetchPlatformSkillsStatus(),
        fetchOminixPlatformModels(),
        fetchOminixAvailableModels(),
        fetchOminixLogs(80),
      ]);

    const errors: string[] = [];

    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    else errors.push(`status: ${errorMessage(statusResult.reason)}`);

    if (platformResult.status === "fulfilled") setPlatformModels(platformResult.value);
    else errors.push(`models: ${errorMessage(platformResult.reason)}`);

    if (availableResult.status === "fulfilled") setAvailableModels(availableResult.value);
    else errors.push(`available models: ${errorMessage(availableResult.reason)}`);

    if (logsResult.status === "fulfilled") setLogs(logsResult.value);
    else errors.push(`logs: ${errorMessage(logsResult.reason)}`);

    setError(errors.length ? errors.join("\n") : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runningLabel = status?.ominix_api.healthy ? "Healthy" : "Unreachable";
  const registeredLabel = status?.ominix_api.service_registered
    ? "LaunchAgent registered"
    : "LaunchAgent missing";

  const platformModelIds = useMemo(
    () => new Set(platformModels.map((m) => m.id)),
    [platformModels],
  );
  const catalogModels = useMemo(
    () =>
      availableModels
        .filter((m) => !platformModelIds.has(m.id))
        .concat(availableModels.filter((m) => platformModelIds.has(m.id))),
    [availableModels, platformModelIds],
  );

  async function performAction(key: string, fn: () => Promise<unknown>) {
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await fn();
      assertActionOk(result);
      setMessage(resultMessage(result));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    const action = pending;
    setPending(null);

    if (action.kind === "service") {
      await performAction(`service:${action.action}`, () =>
        runOminixServiceAction(action.action),
      );
      return;
    }
    if (action.kind === "download-model") {
      await performAction(`download:${action.modelId}`, () =>
        downloadOminixModel(action.modelId),
      );
      return;
    }
    if (action.kind === "remove-local-model") {
      await performAction(`remove:${action.modelId}`, () =>
        removeOminixModel(action.modelId),
      );
      return;
    }
    if (action.kind === "disable-model") {
      await performAction(`disable:${action.modelId}`, () =>
        disableOminixModel(action.modelId),
      );
      return;
    }
    await performAction(`remove-skill:${action.name}`, () =>
      removePlatformSkill(action.name),
    );
  }

  const busy = busyKey !== null || loading;

  return (
    <div className="space-y-6">
      <Section
        title="OminiX API"
        icon={<Power size={20} />}
        action={
          <button
            onClick={() => void load()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-surface-container hover:text-text-strong disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      >
        {loading && !status ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={22} className="animate-spin text-muted" />
          </div>
        ) : (
          <div className="space-y-4">
            {pending && (
              <ConfirmBar
                pending={pending}
                busy={busyKey !== null}
                onConfirm={() => void confirmPending()}
                onCancel={() => setPending(null)}
              />
            )}
            {error && (
              <div className="whitespace-pre-wrap rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-xs text-red-300">
                {error}
              </div>
            )}
            {message && (
              <div className="rounded-xl border border-green-400/30 bg-green-400/5 px-4 py-3 text-xs text-green-300">
                {message}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className={`rounded-xl border px-4 py-3 ${statusClass(Boolean(status?.ominix_api.healthy))}`}>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {status?.ominix_api.healthy ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                  {runningLabel}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] opacity-80">
                  {compactText(status?.ominix_api.url)}
                </div>
              </div>
              <div className={`rounded-xl border px-4 py-3 ${statusClass(Boolean(status?.ominix_api.service_registered))}`}>
                <div className="text-sm font-semibold">{registeredLabel}</div>
                <div className="mt-1 text-[11px] opacity-80">io.ominix.ominix-api</div>
              </div>
              <div className="rounded-xl border border-border/30 bg-surface-container/50 px-4 py-3">
                <div className="text-sm font-semibold text-text-strong">
                  {status?.models.asr.length ?? 0} ASR / {status?.models.tts.length ?? 0} TTS
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted">
                  {compactText(status?.models.dir)}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <SmallButton
                disabled={busy}
                tone="good"
                onClick={() => setPending({ kind: "service", action: "start" })}
              >
                <Play size={12} />
                Start
              </SmallButton>
              <SmallButton
                disabled={busy}
                tone="danger"
                onClick={() => setPending({ kind: "service", action: "stop" })}
              >
                <Square size={11} />
                Stop
              </SmallButton>
              <SmallButton
                disabled={busy}
                tone="warn"
                onClick={() => setPending({ kind: "service", action: "restart" })}
              >
                <RotateCw size={12} />
                Restart
              </SmallButton>
            </div>
          </div>
        )}
      </Section>

      <Section title="Platform Skills" icon={<Activity size={20} />}>
        <div className="space-y-3">
          {(status?.platform_skills ?? []).length === 0 ? (
            <div className="rounded-xl bg-surface-container/50 px-4 py-6 text-center text-sm text-muted">
              No platform skills returned
            </div>
          ) : (
            status?.platform_skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                busy={busy}
                onInstall={(name) =>
                  void performAction(`install-skill:${name}`, () => installPlatformSkill(name))
                }
                onRemove={(name) => setPending({ kind: "remove-skill", name })}
              />
            ))
          )}
          <div className="truncate font-mono text-[11px] text-muted">
            {compactText(status?.skills_dir)}
          </div>
        </div>
      </Section>

      <Section title="Enabled Platform Models" icon={<Download size={20} />}>
        <div className="space-y-3">
          {platformModels.length === 0 ? (
            <div className="rounded-xl bg-surface-container/50 px-4 py-6 text-center text-sm text-muted">
              No models are enabled for Octos
            </div>
          ) : (
            platformModels.map((model) => (
              <PlatformModelRow
                key={model.id}
                model={model}
                busy={busy}
                onDownload={(modelId) =>
                  setPending({ kind: "download-model", modelId })
                }
                onDisable={(modelId) => setPending({ kind: "disable-model", modelId })}
              />
            ))
          )}
        </div>
      </Section>

      <Section title="Available Catalog" icon={<CheckCircle size={20} />}>
        <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
          {catalogModels.length === 0 ? (
            <div className="rounded-xl bg-surface-container/50 px-4 py-6 text-center text-sm text-muted">
              No catalog models returned
            </div>
          ) : (
            catalogModels.map((model) => (
              <AvailableModelRow
                key={model.id}
                model={model}
                busy={busy}
                onEnable={(modelId, role) =>
                  void performAction(`enable:${modelId}:${role}`, () =>
                    enableOminixModel(modelId, role),
                  )
                }
                onDisable={(modelId) =>
                  void performAction(`disable:${modelId}`, () =>
                    disableOminixModel(modelId),
                  )
                }
                onDownload={(modelId) =>
                  setPending({ kind: "download-model", modelId })
                }
                onRemoveLocal={(modelId) =>
                  setPending({ kind: "remove-local-model", modelId })
                }
              />
            ))
          )}
        </div>
      </Section>

      <Section
        title="Logs"
        icon={<Terminal size={20} />}
        action={
          <SmallButton disabled={busy} onClick={() => void load()}>
            <RefreshCw size={12} />
            Reload
          </SmallButton>
        }
      >
        <div className="mb-2 truncate font-mono text-[11px] text-muted">
          {compactText(logs?.log_path)}
        </div>
        {logs?.error && (
          <div className="mb-3 rounded-xl border border-yellow-400/30 bg-yellow-400/5 px-4 py-3 text-xs text-yellow-300">
            {logs.error}
          </div>
        )}
        <pre className="max-h-80 overflow-auto rounded-xl bg-black/30 p-4 font-mono text-[11px] leading-5 text-text/80">
          {(logs?.lines ?? []).join("\n") || "No logs"}
        </pre>
      </Section>
    </div>
  );
}
