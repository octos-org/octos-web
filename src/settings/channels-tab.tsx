import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/constants";
import {
  Radio,
  Plus,
  Pencil,
  Trash2,
  Save,
  Loader2,
  Check,
  X,
  ChevronDown,
  Copy,
} from "lucide-react";
import {
  formatSettingsError,
  acceptMatrixInvite,
  dismissMatrixInvite,
  getMatrixInvites,
  getMyProfile,
  rejectMatrixInvite,
  testMatrixConnection,
  updateMyProfileConfig,
  type MatrixConnectionTestResult,
  type MatrixPendingInvite,
  type Profile,
} from "./settings-api";
import { ConfirmDialog } from "./confirm-dialog";

interface ChannelsTabProps {
  profile: Profile;
  onProfileUpdated?: (p: Profile) => void;
}

// ── Channel type definitions ──

const CHANNEL_TYPES = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "email",
  "feishu",
  "twilio",
  "api",
  "matrix",
  "wechat",
  "wecom-bot",
  "qq-bot",
] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

interface ChannelConfig {
  type: string;
  mode?: "websocket" | "webhook" | "managed" | "external" | "appservice" | "user";
  enabled?: boolean;
  token_env?: string;
  webhook_port?: number;
  allowed_senders?: string | string[];
  require_mention?: boolean;
  bot_token_env?: string;
  app_token_env?: string;
  app_id_env?: string;
  app_secret_env?: string;
  verification_token_env?: string;
  encrypt_key_env?: string;
  region?: "china" | "global";
  account_sid_env?: string;
  auth_token_env?: string;
  from_number?: string;
  port?: number;
  auth_token?: string;
  homeserver?: string;
  as_token?: string;
  hs_token?: string;
  server_name?: string;
  sender_localpart?: string;
  user_prefix?: string;
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
  // Matrix user-account (client) mode
  user_id?: string;
  access_token?: string;
  password?: string;
  device_name?: string;
  rooms?: string | string[];
  auto_join?: "off" | "allowlist" | "always";
  auto_join_allowlist?: string | string[];
  group_policy?: "open" | "allowlist" | "disabled";
}

// ── Default field values per channel type ──

function defaultsForType(type: ChannelType): Partial<ChannelConfig> {
  switch (type) {
    case "telegram":
      return { token_env: "TELEGRAM_BOT_TOKEN", allowed_senders: "" };
    case "discord":
      return { token_env: "DISCORD_BOT_TOKEN" };
    case "slack":
      return { bot_token_env: "SLACK_BOT_TOKEN", app_token_env: "SLACK_APP_TOKEN" };
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
    case "twilio":
      return {
        account_sid_env: "TWILIO_ACCOUNT_SID",
        auth_token_env: "TWILIO_AUTH_TOKEN",
        from_number: "",
        mode: "webhook",
      };
    case "api":
      return { port: 9090, auth_token: "" };
    case "matrix":
      return {
        mode: "appservice",
        homeserver: "",
        as_token: "",
        hs_token: "",
        server_name: "",
        sender_localpart: "octos",
        user_prefix: "octos_",
        allowed_senders: "",
        user_id: "",
        access_token: "",
        password: "",
        device_name: "octos",
        rooms: "",
        auto_join: "off",
        auto_join_allowlist: "",
        group_policy: "allowlist",
        require_mention: true,
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
    slack: "Slack",
    whatsapp: "WhatsApp",
    email: "Email (SMTP)",
    feishu: "Feishu (Lark)",
    twilio: "Twilio SMS",
    api: "Local API",
    matrix: "Matrix",
    wechat: "WeChat",
    "wecom-bot": "WeCom Bot",
    "qq-bot": "QQ Bot",
  };
  return labels[type] ?? type;
}

// ── Webhook URL helpers ──

/** Channel types that receive inbound events via webhook. */
const WEBHOOK_CHANNEL_TYPES = new Set(["feishu", "twilio"]);

function usesWebhook(channel: ChannelConfig): boolean {
  if (channel.type === "feishu") return channel.mode === "webhook" || !channel.mode;
  return WEBHOOK_CHANNEL_TYPES.has(channel.type);
}

function webhookUrl(channelType: string, profileId: string): string {
  const configuredOrigin =
    import.meta.env.VITE_WEBHOOK_ORIGIN ??
    import.meta.env.VITE_PUBLIC_API_ORIGIN;
  if (configuredOrigin) {
    return `${String(configuredOrigin).replace(/\/$/, "")}/webhook/${channelType}/${profileId}`;
  }
  if (/^https?:\/\//.test(API_BASE)) {
    return `${new URL(API_BASE).origin}/webhook/${channelType}/${profileId}`;
  }
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/webhook/${channelType}/${profileId}`;
}

function parseChannels(raw: unknown[]): ChannelConfig[] {
  return raw.map((ch) => {
    if (typeof ch === "object" && ch !== null) return ch as ChannelConfig;
    return { type: "unknown" } as ChannelConfig;
  });
}

function cleanChannelDraft(draft: ChannelConfig): ChannelConfig {
  const cleaned: ChannelConfig = {
    type: draft.type,
    enabled: draft.enabled ?? true,
  };
  for (const [key, value] of Object.entries(draft)) {
    if (key === "type" || key === "enabled") continue;
    if (
      draft.type === "matrix" &&
      (key === "allowed_senders" ||
        key === "rooms" ||
        key === "auto_join_allowlist")
    ) {
      // Backend expects these as string arrays (Vec<String>); convert the
      // comma-separated form before persisting.
      const items = Array.isArray(value)
        ? value
        : String(value ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
      if (items.length > 0) {
        (cleaned as unknown as Record<string, unknown>)[key] = items;
      }
      continue;
    }
    if (value !== "" && value != null) {
      (cleaned as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return cleaned;
}

function isMatrixUserDraft(channel: ChannelConfig | null | undefined): channel is ChannelConfig {
  return channel?.type === "matrix" && channel.mode === "user";
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
  profileId,
}: {
  draft: ChannelConfig;
  onChange: (patch: Partial<ChannelConfig>) => void;
  profileId?: string;
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
        value={Array.isArray(draft[key]) ? (draft[key] as string[]).join(", ") : (draft[key] as string | number) ?? ""}
        onChange={(e) => {
          const value =
            opts?.type === "number"
              ? e.target.value === "" ? undefined : Number(e.target.value)
              : e.target.value;
          onChange({ [key]: value });
        }}
        placeholder={opts?.placeholder}
        className="w-full rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
      />
    </div>
  );

  const checkbox = (label: string, key: keyof ChannelConfig) => (
    <label
      key={key}
      className="flex items-center gap-3 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text"
    >
      <input
        type="checkbox"
        checked={Boolean(draft[key])}
        onChange={(e) => onChange({ [key]: e.target.checked })}
        className="h-4 w-4 accent-accent"
      />
      <span>{label}</span>
    </label>
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
    case "slack":
      return (
        <>
          {field("Bot token env var", "bot_token_env", { placeholder: "SLACK_BOT_TOKEN" })}
          {field("App token env var", "app_token_env", { placeholder: "SLACK_APP_TOKEN" })}
        </>
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
          {profileId && usesWebhook(draft) && (
            <WebhookUrlField channelType="feishu" profileId={profileId} />
          )}
        </>
      );
    case "twilio":
      return (
        <>
          {field("Account SID env var", "account_sid_env", { placeholder: "TWILIO_ACCOUNT_SID" })}
          {field("Auth token env var", "auth_token_env", { placeholder: "TWILIO_AUTH_TOKEN" })}
          {field("From number", "from_number", { placeholder: "+15551234567" })}
          {profileId && usesWebhook(draft) && (
            <WebhookUrlField channelType="twilio" profileId={profileId} />
          )}
        </>
      );
    case "api":
      return (
        <>
          {field("Port", "port", { placeholder: "9090", type: "number" })}
          {field("Auth token", "auth_token", { placeholder: "Optional shared secret", type: "password" })}
        </>
      );
    case "matrix": {
      const matrixMode = draft.mode === "user" ? "user" : "appservice";
      return (
        <>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Mode</label>
            <div className="relative">
              <select
                value={matrixMode}
                onChange={(e) => onChange({ mode: e.target.value as "appservice" | "user" })}
                className="w-full appearance-none rounded-xl bg-surface-container px-4 py-2.5 pr-10 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
              >
                <option value="appservice">Application service (bot bridge)</option>
                <option value="user">User account (login as account)</option>
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
              />
            </div>
            <p className="mt-1.5 text-[11px] text-muted/70">
              {matrixMode === "user"
                ? "Logs in as a regular Matrix account and long-polls /sync — works on any homeserver, no appservice registration."
                : "Homeserver-side appservice registration with a virtual bot user."}
            </p>
          </div>
          {field("Homeserver", "homeserver", { placeholder: "https://matrix.example.com" })}
          {matrixMode === "user" ? (
            <>
              {field("User ID / localpart", "user_id", { placeholder: "octos or @octos:octos.meldry.com" })}
              {field("Access token", "access_token", { placeholder: "syt_… (or use password below)", type: "password" })}
              {field("Password", "password", { placeholder: "Account password (if no access token)", type: "password" })}
              {field("Device name", "device_name", { placeholder: "octos" })}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Room policy</label>
                <div className="relative">
                  <select
                    value={draft.group_policy ?? "allowlist"}
                    onChange={(e) =>
                      onChange({
                        group_policy: e.target.value as "open" | "allowlist" | "disabled",
                      })
                    }
                    className="w-full appearance-none rounded-xl bg-surface-container px-4 py-2.5 pr-10 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
                  >
                    <option value="allowlist">Allowlist</option>
                    <option value="open">Open</option>
                    <option value="disabled">Disabled</option>
                  </select>
                  <ChevronDown
                    size={14}
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                  />
                </div>
              </div>
              {field("Allowed rooms", "rooms", { placeholder: "!room1:matrix.example.com, !room2:…" })}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Invite handling</label>
                <div className="relative">
                  <select
                    value={draft.auto_join ?? "off"}
                    onChange={(e) =>
                      onChange({
                        auto_join: e.target.value as "off" | "allowlist" | "always",
                      })
                    }
                    className="w-full appearance-none rounded-xl bg-surface-container px-4 py-2.5 pr-10 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
                  >
                    <option value="off">Review manually</option>
                    <option value="allowlist">Auto-join allowlist</option>
                    <option value="always">Auto-join all</option>
                  </select>
                  <ChevronDown
                    size={14}
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                  />
                </div>
              </div>
              {field("Invite allowlist", "auto_join_allowlist", { placeholder: "!room:server, #alias:server, *" })}
              {checkbox("Require mention", "require_mention")}
              {field("Allowed senders", "allowed_senders", { placeholder: "@user:matrix.example.com, @bot:matrix.example.com" })}
            </>
          ) : (
            <>
              {field("Application service token", "as_token", { placeholder: "MATRIX_AS_TOKEN", type: "password" })}
              {field("Homeserver token", "hs_token", { placeholder: "MATRIX_HS_TOKEN", type: "password" })}
              {field("Server name", "server_name", { placeholder: "matrix.example.com" })}
              {field("Sender localpart", "sender_localpart", { placeholder: "octos" })}
              {field("User prefix", "user_prefix", { placeholder: "octos_" })}
              {field("Allowed senders", "allowed_senders", { placeholder: "@user:matrix.example.com, @bot:matrix.example.com" })}
            </>
          )}
        </>
      );
    }
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

function MatrixPendingInviteList({
  invites,
  busyKey,
  onAccept,
  onReject,
  onDismiss,
}: {
  invites: MatrixPendingInvite[];
  busyKey: string | null;
  onAccept: (invite: MatrixPendingInvite) => void;
  onReject: (invite: MatrixPendingInvite) => void;
  onDismiss: (invite: MatrixPendingInvite) => void;
}) {
  if (invites.length === 0) return null;

  return (
    <div className="ml-12 rounded-lg border border-accent/20 bg-accent/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-text-strong">Pending room invites</h4>
          <p className="text-[11px] text-muted">{invites.length} waiting for admin review</p>
        </div>
      </div>
      <div className="space-y-2">
        {invites.map((invite) => {
          const title = invite.room_name || invite.canonical_alias || invite.room_id;
          const key = `${invite.channel_index}:${invite.room_id}`;
          const busy = busyKey?.endsWith(key) ?? false;
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-surface-dark/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-text-strong">{title}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted">{invite.room_id}</div>
                {invite.inviter && (
                  <div className="mt-0.5 truncate text-[11px] text-muted/80">Invited by {invite.inviter}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => onAccept(invite)}
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-40 transition"
                  title="Accept invite"
                >
                  {busyKey === `accept:${key}` ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  Accept
                </button>
                <button
                  onClick={() => onReject(invite)}
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/30 px-3 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-40 transition"
                  title="Reject invite"
                >
                  {busyKey === `reject:${key}` ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                  Reject
                </button>
                <button
                  onClick={() => onDismiss(invite)}
                  disabled={busy}
                  className="h-8 rounded-lg border border-border px-3 text-xs text-muted hover:text-text-strong hover:border-accent/30 disabled:opacity-40 transition"
                  title="Dismiss locally"
                >
                  {busyKey === `dismiss:${key}` ? <Loader2 size={13} className="animate-spin" /> : "Dismiss"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatrixConnectionTestStatus({
  result,
}: {
  result: MatrixConnectionTestResult | null;
}) {
  if (!result) return null;
  const inviteDetails = result.pending_invite_details ?? [];

  return (
    <div className="mt-3 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-text">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-text-strong">
          <Check size={13} className="text-accent" />
          Connected
        </span>
        <span className="text-muted">{result.user_id}</span>
        {result.device_id && <span className="text-muted">device {result.device_id}</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        <span>{result.homeserver}</span>
        <span>{result.joined_rooms} joined rooms</span>
        <span>{result.pending_invites} pending invites</span>
        <span>{result.sync.has_next_batch ? "sync token ok" : "sync token missing"}</span>
      </div>
      {inviteDetails.length > 0 && (
        <div className="mt-2 border-t border-accent/15 pt-2">
          <div className="mb-1 text-[11px] font-medium text-text-strong">Pending invite details</div>
          <div className="space-y-1.5">
            {inviteDetails.map((invite) => {
              const title = invite.room_name || invite.canonical_alias || invite.room_id;
              return (
                <div key={invite.room_id} className="min-w-0 text-[11px] text-muted">
                  <div className="truncate font-medium text-text-strong">{title}</div>
                  <div className="truncate">{invite.room_id}</div>
                  {invite.canonical_alias && invite.canonical_alias !== title && (
                    <div className="truncate">Alias {invite.canonical_alias}</div>
                  )}
                  {invite.inviter && <div className="truncate">Invited by {invite.inviter}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ──

export function ChannelsTab({ profile, onProfileUpdated }: ChannelsTabProps) {
  const channels = parseChannels(profile.config.channels ?? []);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoveIdx, setPendingRemoveIdx] = useState<number | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<ChannelConfig | null>(null);
  const [matrixInvites, setMatrixInvites] = useState<MatrixPendingInvite[]>([]);
  const [matrixInviteBusyKey, setMatrixInviteBusyKey] = useState<string | null>(null);
  const [matrixTestBusyKey, setMatrixTestBusyKey] = useState<string | null>(null);
  const [matrixTestResult, setMatrixTestResult] = useState<{
    key: string;
    result: MatrixConnectionTestResult;
  } | null>(null);

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

  const updateEditDraft = (patch: Partial<ChannelConfig>) => {
    setEditDraft((d) => d ? { ...d, ...patch } : d);
  };

  const loadMatrixInvites = async () => {
    try {
      setMatrixInvites(await getMatrixInvites());
    } catch (err) {
      setError(formatSettingsError(err, "Failed to load Matrix invites."));
    }
  };

  useEffect(() => {
    const hasMatrixUserChannel = channels.some((ch) => ch.type === "matrix" && ch.mode === "user");
    if (!hasMatrixUserChannel) {
      setMatrixInvites([]);
      return;
    }
    void loadMatrixInvites();
    const timer = window.setInterval(() => {
      void loadMatrixInvites();
    }, 15_000);
    return () => window.clearInterval(timer);
    // profile.updated_at changes after channel edits; use it as the refresh key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.updated_at]);

  const handleMatrixInviteAction = async (
    invite: MatrixPendingInvite,
    action: "accept" | "reject" | "dismiss",
  ) => {
    const key = `${action}:${invite.channel_index}:${invite.room_id}`;
    setMatrixInviteBusyKey(key);
    setError(null);
    try {
      if (action === "accept") {
        await acceptMatrixInvite(invite.room_id, {
          channel_index: invite.channel_index,
          add_to_allowed_rooms: true,
        });
        const refreshed = await getMyProfile();
        if (refreshed) onProfileUpdated?.(refreshed);
      } else if (action === "reject") {
        await rejectMatrixInvite(invite.room_id, { channel_index: invite.channel_index });
      } else {
        await dismissMatrixInvite(invite.room_id, { channel_index: invite.channel_index });
      }
      await loadMatrixInvites();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(formatSettingsError(err, `Failed to ${action} Matrix invite.`));
    } finally {
      setMatrixInviteBusyKey(null);
    }
  };

  const handleMatrixConnectionTest = async (
    channel: ChannelConfig,
    channelIndex?: number,
  ) => {
    const key = channelIndex == null ? "new" : String(channelIndex);
    setMatrixTestBusyKey(key);
    setMatrixTestResult(null);
    setError(null);
    try {
      const result = await testMatrixConnection({
        channel_index: channelIndex,
        channel: cleanChannelDraft(channel) as unknown as Record<string, unknown>,
      });
      setMatrixTestResult({ key, result });
    } catch (err) {
      setError(formatSettingsError(err, "Matrix connection test failed."));
    } finally {
      setMatrixTestBusyKey(null);
    }
  };

  // Persist channel list via PUT /api/my/profile
  const persistChannels = async (newChannels: ChannelConfig[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const result = await updateMyProfileConfig(profile, {
        channels: newChannels,
      });
      onProfileUpdated?.(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (err) {
      setError(formatSettingsError(err, "Failed to update channels."));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    const cleaned = cleanChannelDraft(draft);
    const ok = await persistChannels([...channels, cleaned]);
    if (ok) {
      setShowAddForm(false);
      setDraft({ type: "telegram", enabled: true, ...defaultsForType("telegram") });
      setNewType("telegram");
    }
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditDraft({ ...channels[idx] });
    setShowAddForm(false);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
    setEditDraft(null);
  };

  const handleSaveEdit = async () => {
    if (editingIdx == null || !editDraft) return;
    const updated = channels.map((ch, i) =>
      i === editingIdx ? cleanChannelDraft(editDraft) : ch,
    );
    const ok = await persistChannels(updated);
    if (ok) cancelEdit();
  };

  const confirmRemove = async () => {
    if (pendingRemoveIdx == null) return;
    const idx = pendingRemoveIdx;
    setPendingRemoveIdx(null);
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
              const channelInvites =
                channel.type === "matrix" && channel.mode === "user"
                  ? matrixInvites.filter((invite) => invite.channel_index === idx)
                  : [];
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
                      onClick={() => startEdit(idx)}
                      disabled={saving}
                      className="shrink-0 rounded-lg p-2 text-muted hover:text-text-strong hover:bg-surface-dark/70 disabled:opacity-40 transition"
                      title="Edit channel"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => setPendingRemoveIdx(idx)}
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
                  <MatrixPendingInviteList
                    invites={channelInvites}
                    busyKey={matrixInviteBusyKey}
                    onAccept={(invite) => void handleMatrixInviteAction(invite, "accept")}
                    onReject={(invite) => void handleMatrixInviteAction(invite, "reject")}
                    onDismiss={(invite) => void handleMatrixInviteAction(invite, "dismiss")}
                  />
                  {editingIdx === idx && editDraft && (
                    <div className="ml-12 rounded-xl border border-border/70 bg-surface-dark/40 p-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <ChannelFormFields
                          draft={editDraft}
                          onChange={updateEditDraft}
                          profileId={profile.id}
                        />
                      </div>
                      <div className="mt-4 flex items-center gap-3">
                        <button
                          onClick={() => void handleSaveEdit()}
                          disabled={saving}
                          className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
                        >
                          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                          Save Channel
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="rounded-xl border border-border px-4 py-2 text-xs text-muted hover:text-text-strong hover:border-accent/30 transition"
                        >
                          Cancel
                        </button>
                        {isMatrixUserDraft(editDraft) && (
                          <button
                            onClick={() => void handleMatrixConnectionTest(editDraft, idx)}
                            disabled={matrixTestBusyKey === String(idx)}
                            className="inline-flex items-center gap-2 rounded-xl border border-accent/30 px-4 py-2 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40 transition"
                          >
                            {matrixTestBusyKey === String(idx) ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Radio size={14} />
                            )}
                            Test Connection
                          </button>
                        )}
                      </div>
                      {matrixTestResult?.key === String(idx) && (
                        <MatrixConnectionTestStatus result={matrixTestResult.result} />
                      )}
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
            <ChannelFormFields
              draft={draft}
              onChange={updateDraft}
              profileId={profile.id}
            />
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
            {isMatrixUserDraft(draft) && (
              <button
                onClick={() => void handleMatrixConnectionTest(draft)}
                disabled={matrixTestBusyKey === "new"}
                className="inline-flex items-center gap-2 rounded-xl border border-accent/30 px-4 py-2.5 text-sm font-medium text-accent hover:bg-accent/10 disabled:opacity-40 transition"
              >
                {matrixTestBusyKey === "new" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Radio size={14} />
                )}
                Test Connection
              </button>
            )}
          </div>
          {matrixTestResult?.key === "new" && (
            <MatrixConnectionTestStatus result={matrixTestResult.result} />
          )}
        </div>
      )}
      <ConfirmDialog
        open={pendingRemoveIdx != null}
        title="Remove Channel"
        body={
          pendingRemoveIdx != null && channels[pendingRemoveIdx]
            ? `Remove ${channelLabel(channels[pendingRemoveIdx].type)} channel?`
            : "Remove this channel?"
        }
        confirmLabel="Remove Channel"
        variant="danger"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemoveIdx(null)}
      />
    </div>
  );
}
