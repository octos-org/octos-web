import { useState } from "react";
import {
  Radio,
  Plus,
  Trash2,
  Save,
  Loader2,
  Check,
  X,
  ChevronDown,
  Copy,
} from "lucide-react";
import { updateMyProfile, type Profile, type ProfileConfig } from "./settings-api";

interface ChannelsTabProps {
  profile: Profile;
  onProfileUpdated?: (p: Profile) => void;
}

// ── Channel type definitions ──

const CHANNEL_TYPES = [
  "telegram",
  "discord",
  "whatsapp",
  "email",
  "feishu",
  "wechat",
  "wecom-bot",
  "qq-bot",
] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

interface ChannelConfig {
  type: string;
  mode?: "websocket" | "webhook" | "managed" | "external";
  enabled?: boolean;
  token_env?: string;
  webhook_port?: number;
  allowed_senders?: string;
  require_mention?: boolean;
  app_id_env?: string;
  app_secret_env?: string;
  verification_token_env?: string;
  encrypt_key_env?: string;
  region?: "china" | "global";
  smtp_host?: string;
  smtp_port?: number;
  username_env?: string;
  password_env?: string;
  bot_id?: string;
  app_id?: string;
  secret_env?: string;
  client_secret_env?: string;
  bridge_url?: string;
  base_url?: string;
}

// ── Default field values per channel type ──

function defaultsForType(type: ChannelType): Partial<ChannelConfig> {
  switch (type) {
    case "telegram":
      return { token_env: "TELEGRAM_BOT_TOKEN", allowed_senders: "" };
    case "discord":
      return { token_env: "DISCORD_BOT_TOKEN" };
    case "whatsapp":
      return { bridge_url: "" };
    case "email":
      return { smtp_host: "", smtp_port: 587, username_env: "EMAIL_USERNAME", password_env: "EMAIL_PASSWORD" };
    case "feishu":
      return {
        app_id_env: "FEISHU_APP_ID",
        app_secret_env: "FEISHU_APP_SECRET",
        verification_token_env: "",
        encrypt_key_env: "",
        mode: "webhook",
        region: "china",
      };
    case "wechat":
      return { token_env: "WECHAT_BOT_TOKEN", base_url: "https://api.weixin.qq.com/cgi-bin" };
    case "wecom-bot":
      return { bot_id: "", secret_env: "WECOM_BOT_SECRET" };
    case "qq-bot":
      return { app_id: "", client_secret_env: "QQ_BOT_CLIENT_SECRET" };
  }
}

// ── Helpers ──

function channelLabel(type: string): string {
  const labels: Record<string, string> = {
    telegram: "Telegram",
    discord: "Discord",
    whatsapp: "WhatsApp",
    email: "Email (SMTP)",
    feishu: "Feishu (Lark)",
    wechat: "WeChat",
    "wecom-bot": "WeCom Bot",
    "qq-bot": "QQ Bot",
  };
  return labels[type] ?? type;
}

// ── Webhook URL helpers ──

/** Channel types that receive inbound events via webhook. */
const WEBHOOK_CHANNEL_TYPES = new Set(["feishu"]);

function usesWebhook(channel: ChannelConfig): boolean {
  if (channel.type === "feishu") return channel.mode === "webhook" || !channel.mode;
  return WEBHOOK_CHANNEL_TYPES.has(channel.type);
}

function webhookUrl(channelType: string, profileId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/webhook/${channelType}/${profileId}`;
}

function parseChannels(raw: unknown[]): ChannelConfig[] {
  return raw.map((ch) => {
    if (typeof ch === "object" && ch !== null) return ch as ChannelConfig;
    return { type: "unknown" } as ChannelConfig;
  });
}

// ── Sub-component: form fields for each channel type ──

function WebhookUrlField({ channelType, profileId }: { channelType: string; profileId: string }) {
  const [copied, setCopied] = useState(false);
  const url = webhookUrl(channelType, profileId);

  const handleCopy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">Webhook URL</label>
      <p className="mb-1.5 text-[11px] text-muted/70">
        Paste this URL into your platform&apos;s webhook settings.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text/70 outline-none border border-border/50 select-all"
        />
        <button
          type="button"
          onClick={handleCopy}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-text-strong hover:border-accent/30 transition"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function ChannelFormFields({
  draft,
  onChange,
  channelId,
}: {
  draft: ChannelConfig;
  onChange: (patch: Partial<ChannelConfig>) => void;
  channelId?: string;
}) {
  const field = (
    label: string,
    key: keyof ChannelConfig,
    opts?: { placeholder?: string; type?: string },
  ) => (
    <div key={key}>
      <label className="mb-1.5 block text-xs font-medium text-muted">{label}</label>
      <input
        type={opts?.type ?? "text"}
        value={(draft[key] as string | number) ?? ""}
        onChange={(e) => onChange({ [key]: opts?.type === "number" ? Number(e.target.value) : e.target.value })}
        placeholder={opts?.placeholder}
        className="w-full rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
      />
    </div>
  );

  switch (draft.type) {
    case "telegram":
      return (
        <>
          {field("Token env var", "token_env", { placeholder: "TELEGRAM_BOT_TOKEN" })}
          {field("Allowed senders", "allowed_senders", { placeholder: "Comma-separated user IDs" })}
        </>
      );
    case "discord":
      return (
        field("Token env var", "token_env", { placeholder: "DISCORD_BOT_TOKEN" })
      );
    case "whatsapp": {
      return (
        field("Bridge URL", "bridge_url", { placeholder: "https://your-bridge.example.com" })
      );
    }
    case "email":
      return (
        <>
          {field("SMTP Host", "smtp_host", { placeholder: "smtp.example.com" })}
          {field("SMTP Port", "smtp_port", { placeholder: "587", type: "number" })}
          {field("Username env var", "username_env", { placeholder: "EMAIL_USERNAME" })}
          {field("Password env var", "password_env", { placeholder: "EMAIL_PASSWORD" })}
        </>
      );
    case "feishu":
      return (
        <>
          {field("App ID env var", "app_id_env", { placeholder: "FEISHU_APP_ID" })}
          {field("App secret env var", "app_secret_env", { placeholder: "FEISHU_APP_SECRET" })}
          {field("Verification token env var", "verification_token_env")}
          {field("Encrypt key env var", "encrypt_key_env")}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Region</label>
            <div className="relative">
              <select
                value={draft.region ?? "china"}
                onChange={(e) => onChange({ region: e.target.value as "china" | "global" })}
                className="w-full appearance-none rounded-xl bg-surface-container px-4 py-2.5 pr-10 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
              >
                <option value="china">China</option>
                <option value="global">Global</option>
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
              />
            </div>
          </div>
          {channelId && usesWebhook(draft) && (
            <WebhookUrlField channelType="feishu" profileId={channelId} />
          )}
        </>
      );
    case "wechat":
      return (
        <>
          {field("Token env var", "token_env", { placeholder: "WECHAT_BOT_TOKEN" })}
          {field("Base URL", "base_url", { placeholder: "https://api.weixin.qq.com/cgi-bin" })}
        </>
      );
    case "wecom-bot":
      return (
        <>
          {field("Bot ID", "bot_id")}
          {field("Secret env var", "secret_env", { placeholder: "WECOM_BOT_SECRET" })}
        </>
      );
    case "qq-bot":
      return (
        <>
          {field("App ID", "app_id")}
          {field("Client secret env var", "client_secret_env", { placeholder: "QQ_BOT_CLIENT_SECRET" })}
        </>
      );
    default:
      return <p className="text-xs text-muted">No configurable fields for this channel type.</p>;
  }
}

// ── Main component ──

export function ChannelsTab({ profile, onProfileUpdated }: ChannelsTabProps) {
  const channels = parseChannels(profile.config.channels ?? []);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add-channel form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newType, setNewType] = useState<ChannelType>("telegram");
  const [draft, setDraft] = useState<ChannelConfig>({ type: "telegram", enabled: true, ...defaultsForType("telegram") });

  const handleTypeChange = (type: ChannelType) => {
    setNewType(type);
    setDraft({ type, enabled: true, ...defaultsForType(type) });
  };

  const updateDraft = (patch: Partial<ChannelConfig>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  // Persist channel list via PUT /api/my/profile
  const persistChannels = async (newChannels: ChannelConfig[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const result = await updateMyProfile({
      config: { channels: newChannels } as Partial<ProfileConfig>,
    });
    setSaving(false);
    if (result) {
      onProfileUpdated?.(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    }
    setError("Failed to update channels.");
    return false;
  };

  const handleAdd = async () => {
    // Strip empty string fields to keep payload clean
    const cleaned: ChannelConfig = { type: draft.type, enabled: draft.enabled ?? true };
    for (const [k, v] of Object.entries(draft)) {
      if (k === "type" || k === "enabled") continue;
      if (v !== "" && v != null) {
        (cleaned as unknown as Record<string, unknown>)[k] = v;
      }
    }
    const ok = await persistChannels([...channels, cleaned]);
    if (ok) {
      setShowAddForm(false);
      setDraft({ type: "telegram", enabled: true, ...defaultsForType("telegram") });
      setNewType("telegram");
    }
  };

  const handleRemove = async (idx: number) => {
    const ch = channels[idx];
    const label = channelLabel(ch?.type ?? "unknown");
    if (!window.confirm(`Remove ${label} channel?`)) return;
    const updated = channels.filter((_, i) => i !== idx);
    await persistChannels(updated);
  };

  const handleToggle = async (idx: number) => {
    const updated = channels.map((ch, i) =>
      i === idx ? { ...ch, enabled: !(ch.enabled ?? true) } : ch,
    );
    await persistChannels(updated);
  };

  return (
    <div className="space-y-6">
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Radio size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Channels</h3>
              <p className="text-xs text-muted">
                {channels.length > 0
                  ? `${channels.length} channel${channels.length === 1 ? "" : "s"} configured`
                  : "Communication channels for the agent"}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent-dim transition"
          >
            <Plus size={14} />
            Add Channel
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {saved && (
          <div className="mb-4 rounded-xl bg-accent/10 px-4 py-3 text-xs text-accent flex items-center gap-2">
            <Check size={14} />
            Channels updated
          </div>
        )}

        {channels.length === 0 && !showAddForm ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Radio size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No channels configured</p>
            <p className="mt-1 text-xs text-muted/60">
              Add a channel to connect your agent to messaging platforms
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {channels.map((channel, idx) => {
              const enabled = channel.enabled ?? true;
              return (
                <div key={idx} className="space-y-2">
                  <div className="flex items-center gap-4 rounded-xl bg-surface-container/60 px-4 py-3.5 border border-transparent hover:border-border transition">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-dark/60 text-xs font-bold uppercase text-muted">
                      {channel.type.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-strong truncate">
                          {channelLabel(channel.type)}
                        </span>
                        <span className="shrink-0 rounded-md bg-surface-dark/60 px-1.5 py-0.5 text-[10px] font-medium text-muted uppercase tracking-wider">
                          {channel.type}
                        </span>
                      </div>
                    </div>
                    {/* Toggle */}
                    <button
                      onClick={() => handleToggle(idx)}
                      disabled={saving}
                      className="shrink-0"
                      title={enabled ? "Disable channel" : "Enable channel"}
                    >
                      <div
                        className={`relative h-6 w-11 rounded-full transition-colors ${
                          enabled ? "bg-accent" : "bg-surface-dark/80"
                        }`}
                      >
                        <div
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                            enabled ? "translate-x-[22px]" : "translate-x-0.5"
                          }`}
                        />
                      </div>
                    </button>
                    {/* Delete */}
                    <button
                      onClick={() => handleRemove(idx)}
                      disabled={saving}
                      className="shrink-0 rounded-lg p-2 text-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition"
                      title="Remove channel"
                    >
                      {saving ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>
                  {/* Webhook URL for applicable channels */}
                  {usesWebhook(channel) && (
                    <div className="ml-12 pr-1">
                      <WebhookUrlField channelType={channel.type} profileId={profile.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Channel Form */}
      {showAddForm && (
        <div className="glass-section rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Plus size={20} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-strong">New Channel</h3>
                <p className="text-xs text-muted">Configure a new messaging channel</p>
              </div>
            </div>
            <button
              onClick={() => setShowAddForm(false)}
              className="rounded-lg p-2 text-muted hover:text-text-strong hover:bg-surface-container transition"
              title="Cancel"
            >
              <X size={16} />
            </button>
          </div>

          <div className="space-y-4">
            {/* Type selector */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">Channel Type</label>
              <div className="relative">
                <select
                  value={newType}
                  onChange={(e) => handleTypeChange(e.target.value as ChannelType)}
                  className="w-full appearance-none rounded-xl bg-surface-container px-4 py-2.5 pr-10 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
                >
                  {CHANNEL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {channelLabel(t)}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                />
              </div>
            </div>

            {/* Dynamic fields */}
            <ChannelFormFields draft={draft} onChange={updateDraft} />
          </div>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={handleAdd}
              disabled={saving}
              className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {saving ? "Saving..." : "Add Channel"}
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="rounded-xl border border-border px-4 py-2.5 text-sm text-muted hover:text-text-strong hover:border-accent/30 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
