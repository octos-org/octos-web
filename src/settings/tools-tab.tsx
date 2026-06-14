import { useState } from "react";
import {
  Save,
  Loader2,
  Check,
  RotateCcw,
  Globe,
  Search,
  Zap,
  Timer,
  Mail,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { formatSettingsError, updateMyProfileConfig, type Profile } from "./settings-api";
import { request } from "@/api/client";

interface ToolsTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}

/* ── Search engine definitions ── */

interface SearchEngine {
  key: string;        // env var name
  provider: string;   // backend /api/my/test-search provider id
  name: string;
  description: string;
  placeholder: string;
  docsUrl?: string;
}

const SEARCH_ENGINES: SearchEngine[] = [
  {
    key: "SERPER_API_KEY",
    provider: "serper",
    name: "Serper (Google)",
    description: "Google Search via Serper.dev API",
    placeholder: "Enter Serper API key",
    docsUrl: "https://serper.dev",
  },
  {
    key: "TAVILY_API_KEY",
    provider: "tavily",
    name: "Tavily",
    description: "AI-optimized search engine",
    placeholder: "Enter Tavily API key",
    docsUrl: "https://tavily.com",
  },
  {
    key: "PERPLEXITY_API_KEY",
    provider: "perplexity",
    name: "Perplexity",
    description: "Perplexity AI search API",
    placeholder: "Enter Perplexity API key",
    docsUrl: "https://docs.perplexity.ai",
  },
  {
    key: "YDC_API_KEY",
    provider: "you",
    name: "You.com",
    description: "You.com web search API",
    placeholder: "Enter You.com API key",
    docsUrl: "https://you.com/search-api",
  },
  {
    key: "BRAVE_API_KEY",
    provider: "brave",
    name: "Brave Search",
    description: "Privacy-focused web search via Brave",
    placeholder: "Enter Brave Search API key",
    docsUrl: "https://brave.com/search/api/",
  },
];

/* ── Deep crawl config ── */

interface CrawlConfig {
  max_depth: string;
  max_pages: string;
  timeout_secs: string;
}

/* ── Gateway settings ── */

interface GatewaySettings {
  browser_timeout_secs: string;
}

/* ── Email tool config ── */

type EmailProvider = "feishu" | "smtp";

interface EmailToolConfig {
  enabled: boolean;
  provider: EmailProvider;
  smtp_host: string;
  smtp_port: string;
  smtp_username: string;
  smtp_password: string;
  smtp_from: string;
}

/* ── Form state ── */

interface ToolsFormState {
  env_vars: Record<string, string>;
  crawl: CrawlConfig;
  gateway: GatewaySettings;
  emailTool: EmailToolConfig;
}

function profileToForm(profile: Profile): ToolsFormState {
  const envVars = profile.config.env_vars ?? {};
  return {
    env_vars: {
      SERPER_API_KEY: envVars.SERPER_API_KEY ?? "",
      TAVILY_API_KEY: envVars.TAVILY_API_KEY ?? "",
      PERPLEXITY_API_KEY: envVars.PERPLEXITY_API_KEY ?? "",
      YDC_API_KEY: envVars.YDC_API_KEY ?? "",
      BRAVE_API_KEY: envVars.BRAVE_API_KEY ?? "",
      CRAWL_MAX_DEPTH: envVars.CRAWL_MAX_DEPTH ?? "",
      CRAWL_MAX_PAGES: envVars.CRAWL_MAX_PAGES ?? "",
      CRAWL_TIMEOUT_SECS: envVars.CRAWL_TIMEOUT_SECS ?? "",
    },
    crawl: {
      max_depth: envVars.CRAWL_MAX_DEPTH ?? "",
      max_pages: envVars.CRAWL_MAX_PAGES ?? "",
      timeout_secs: envVars.CRAWL_TIMEOUT_SECS ?? "",
    },
    gateway: {
      browser_timeout_secs:
        profile.config.gateway.browser_timeout_secs != null
          ? String(profile.config.gateway.browser_timeout_secs)
          : "",
    },
    emailTool: {
      enabled: envVars.EMAIL_TOOL_ENABLED === "true",
      provider: (envVars.EMAIL_TOOL_PROVIDER as EmailProvider) || "smtp",
      smtp_host: envVars.SMTP_HOST ?? "",
      smtp_port: envVars.SMTP_PORT ?? "",
      smtp_username: envVars.SMTP_USERNAME ?? "",
      smtp_password: envVars.SMTP_PASSWORD ?? "",
      smtp_from: envVars.SMTP_FROM ?? "",
    },
  };
}

function formToPayload(form: ToolsFormState, profile: Profile) {
  // Build env_vars: merge existing with edited keys; remove empty values
  const mergedEnv: Record<string, string> = { ...profile.config.env_vars };

  // Search engine keys from env_vars form
  for (const key of SEARCH_ENGINES.map((e) => e.key)) {
    const val = form.env_vars[key]?.trim();
    if (val) {
      mergedEnv[key] = val;
    } else {
      delete mergedEnv[key];
    }
  }

  // Deep crawl from crawl sub-form
  const crawlMap: Record<string, string> = {
    CRAWL_MAX_DEPTH: form.crawl.max_depth,
    CRAWL_MAX_PAGES: form.crawl.max_pages,
    CRAWL_TIMEOUT_SECS: form.crawl.timeout_secs,
  };
  for (const [key, val] of Object.entries(crawlMap)) {
    const trimmed = val.trim();
    if (trimmed) {
      mergedEnv[key] = trimmed;
    } else {
      delete mergedEnv[key];
    }
  }

  // Email tool settings
  const et = form.emailTool;
  mergedEnv.EMAIL_TOOL_ENABLED = et.enabled ? "true" : "false";
  mergedEnv.EMAIL_TOOL_PROVIDER = et.provider;

  const smtpMap: Record<string, string> = {
    SMTP_HOST: et.smtp_host,
    SMTP_PORT: et.smtp_port,
    SMTP_USERNAME: et.smtp_username,
    SMTP_PASSWORD: et.smtp_password,
    SMTP_FROM: et.smtp_from,
  };
  for (const [key, val] of Object.entries(smtpMap)) {
    const trimmed = val.trim();
    if (trimmed) {
      mergedEnv[key] = trimmed;
    } else {
      delete mergedEnv[key];
    }
  }

  const browserTimeout = form.gateway.browser_timeout_secs.trim()
    ? parseInt(form.gateway.browser_timeout_secs, 10) || null
    : null;

  return {
    config: {
      env_vars: mergedEnv,
      gateway: {
        ...profile.config.gateway,
        browser_timeout_secs: browserTimeout,
      },
    },
  };
}

/* ── Test connection helper ── */

interface TestResult {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
}

function SearchEngineCard({
  engine,
  value,
  onChange,
  testResult,
  onTest,
}: {
  engine: SearchEngine;
  value: string;
  onChange: (val: string) => void;
  testResult: TestResult;
  onTest: () => void;
}) {
  const hasKey = !!value.trim();

  return (
    <div className="rounded-xl bg-surface-container/60 p-4 border border-transparent hover:border-border transition">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-dark/60">
            <Search size={14} className="text-muted" />
          </div>
          <div>
            <h4 className="text-sm font-medium text-text-strong">{engine.name}</h4>
            <p className="text-xs text-muted">{engine.description}</p>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              hasKey ? "bg-green-400" : "bg-muted/30"
            }`}
          />
          <span className="text-[10px] font-medium text-muted">
            {hasKey ? "Configured" : "Not set"}
          </span>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={engine.placeholder}
          className="flex-1 rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
        />
        <button
          type="button"
          onClick={onTest}
          disabled={!hasKey || testResult.status === "testing"}
          className="shrink-0 flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium border transition disabled:opacity-30
            bg-surface-dark/50 text-muted border-border hover:text-accent hover:border-accent/30"
        >
          {testResult.status === "testing" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Zap size={12} />
          )}
          Test
        </button>
      </div>

      {testResult.status === "success" && (
        <p className="mt-2 text-xs text-green-400">{testResult.message || "Connection successful"}</p>
      )}
      {testResult.status === "error" && (
        <p className="mt-2 text-xs text-red-400">{testResult.message || "Connection failed"}</p>
      )}
    </div>
  );
}

/* ── Email Tool section ── */

function EmailToolSection({
  config,
  onChange,
}: {
  config: EmailToolConfig;
  onChange: (next: EmailToolConfig) => void;
}) {
  const smtpConfigured =
    !!config.smtp_host.trim() &&
    !!config.smtp_port.trim() &&
    !!config.smtp_username.trim() &&
    !!config.smtp_password.trim() &&
    !!config.smtp_from.trim();

  const set = (patch: Partial<EmailToolConfig>) => onChange({ ...config, ...patch });

  return (
    <div className="space-y-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-xl bg-surface-container/60 p-4 border border-transparent hover:border-border transition">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-dark/60">
            <Mail size={14} className="text-muted" />
          </div>
          <div>
            <h4 className="text-sm font-medium text-text-strong">Email Sending</h4>
            <p className="text-xs text-muted">Allow agents to send emails via this tool</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => set({ enabled: !config.enabled })}
          className="shrink-0 flex items-center gap-1.5 text-sm font-medium transition"
          aria-label={config.enabled ? "Disable email tool" : "Enable email tool"}
        >
          {config.enabled ? (
            <ToggleRight size={28} className="text-accent" />
          ) : (
            <ToggleLeft size={28} className="text-muted/50" />
          )}
        </button>
      </div>

      {config.enabled && (
        <>
          {/* Provider selector */}
          <div className="rounded-xl bg-surface-container/60 p-4 border border-transparent">
            <label className="mb-2 block text-xs font-medium text-muted">Provider</label>
            <div className="flex gap-2">
              {(["feishu", "smtp"] as EmailProvider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => set({ provider: p })}
                  className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium border transition ${
                    config.provider === p
                      ? "bg-accent/10 text-accent border-accent/30"
                      : "bg-surface-dark/50 text-muted border-border hover:border-accent/20"
                  }`}
                >
                  {p === "feishu" ? "Feishu" : "SMTP"}
                </button>
              ))}
            </div>
          </div>

          {/* SMTP fields */}
          {config.provider === "smtp" && (
            <div className="rounded-xl bg-surface-container/60 p-4 border border-transparent space-y-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-muted">SMTP Configuration</p>
                {smtpConfigured && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-green-400">
                    <Check size={10} />
                    SMTP is configured
                  </span>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1.5 block text-xs text-muted">Host</label>
                  <input
                    type="text"
                    value={config.smtp_host}
                    onChange={(e) => set({ smtp_host: e.target.value })}
                    placeholder="smtp.example.com"
                    className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-muted">Port</label>
                  <input
                    type="number"
                    value={config.smtp_port}
                    onChange={(e) => set({ smtp_port: e.target.value })}
                    placeholder="587"
                    min={1}
                    max={65535}
                    className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition tabular-nums"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs text-muted">Username</label>
                  <input
                    type="text"
                    value={config.smtp_username}
                    onChange={(e) => set({ smtp_username: e.target.value })}
                    placeholder="user@example.com"
                    className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-muted">Password</label>
                  <input
                    type="password"
                    value={config.smtp_password}
                    onChange={(e) => set({ smtp_password: e.target.value })}
                    placeholder="App password"
                    className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs text-muted">From Address</label>
                <input
                  type="email"
                  value={config.smtp_from}
                  onChange={(e) => set({ smtp_from: e.target.value })}
                  placeholder="noreply@example.com"
                  className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
                />
              </div>

              <p className="border-t border-border/50 pt-3 text-xs text-muted">
                SMTP settings are saved to this profile and used by the agent email tool.
              </p>
            </div>
          )}

          {config.provider === "feishu" && (
            <div className="rounded-xl bg-surface-container/60 p-4 border border-transparent">
              <p className="text-xs text-muted">
                Feishu email is configured via your Feishu workspace. Ensure the Feishu channel is set up in the Channels tab.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ToolsTab({ profile, onProfileUpdated }: ToolsTabProps) {
  const [form, setForm] = useState<ToolsFormState>(() => profileToForm(profile));
  const [original, setOriginal] = useState<ToolsFormState>(() => profileToForm(profile));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const payload = formToPayload(form, profile);
    try {
      const result = await updateMyProfileConfig(profile, payload.config);
      onProfileUpdated(result);
      const newForm = profileToForm(result);
      setForm(newForm);
      setOriginal(newForm);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to update tools config."));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setForm(profileToForm(profile));
    setOriginal(profileToForm(profile));
  };

  const handleTestConnection = async (engine: SearchEngine) => {
    const engineKey = engine.key;
    setTestResults((prev) => ({ ...prev, [engineKey]: { status: "testing" } }));
    const value = form.env_vars[engineKey]?.trim();

    if (!value) {
      setTestResults((prev) => ({
        ...prev,
        [engineKey]: { status: "error", message: "API key is empty" },
      }));
      return;
    }

    try {
      const resp = await request<{ ok: boolean; message?: string; error?: string }>(
        "/api/my/test-search",
        {
          method: "POST",
          body: JSON.stringify({
            provider: engine.provider,
            api_key: value,
            api_key_env: engine.key,
            profile_id: profile.id,
          }),
        },
      );
      if (resp.ok) {
        setTestResults((prev) => ({
          ...prev,
          [engineKey]: {
            status: "success",
            message: resp.message || "Search API connected",
          },
        }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [engineKey]: {
            status: "error",
            message: resp.error || resp.message || "Search API rejected the key",
          },
        }));
      }
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [engineKey]: { status: "error", message: "Search test endpoint unavailable" },
      }));
    }
  };

  const updateEnvVar = (key: string, value: string) => {
    setForm((f) => ({
      ...f,
      env_vars: { ...f.env_vars, [key]: value },
    }));
    // Clear test result when value changes
    setTestResults((prev) => ({ ...prev, [key]: { status: "idle" } }));
  };

  return (
    <div className="space-y-6">
      {/* Web Search APIs */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Globe size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Web Search APIs</h3>
            <p className="text-xs text-muted">Configure search engine API keys for web tools</p>
          </div>
        </div>

        <div className="space-y-3">
          {SEARCH_ENGINES.map((engine) => (
            <SearchEngineCard
              key={engine.key}
              engine={engine}
              value={form.env_vars[engine.key] ?? ""}
              onChange={(val) => updateEnvVar(engine.key, val)}
              testResult={testResults[engine.key] ?? { status: "idle" }}
              onTest={() => void handleTestConnection(engine)}
            />
          ))}
        </div>
      </div>

      {/* Email Tool */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Mail size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Email Tool</h3>
            <p className="text-xs text-muted">Allow agents to send emails on your behalf</p>
          </div>
        </div>

        <EmailToolSection
          config={form.emailTool}
          onChange={(emailTool) => setForm((f) => ({ ...f, emailTool }))}
        />
      </div>

      {/* Deep Crawl Config */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Search size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Deep Crawl</h3>
            <p className="text-xs text-muted">Configure web crawling behavior and limits</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Max Depth
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={form.crawl.max_depth}
              onChange={(e) => setForm((f) => ({ ...f, crawl: { ...f.crawl, max_depth: e.target.value } }))}
              placeholder="3"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition tabular-nums"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Max Pages
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={form.crawl.max_pages}
              onChange={(e) => setForm((f) => ({ ...f, crawl: { ...f.crawl, max_pages: e.target.value } }))}
              placeholder="50"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition tabular-nums"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Timeout (seconds)
            </label>
            <input
              type="number"
              min={1}
              max={600}
              value={form.crawl.timeout_secs}
              onChange={(e) => setForm((f) => ({ ...f, crawl: { ...f.crawl, timeout_secs: e.target.value } }))}
              placeholder="30"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition tabular-nums"
            />
          </div>
        </div>
      </div>

      {/* Gateway Settings */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Timer size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Gateway Settings</h3>
            <p className="text-xs text-muted">Browser and request timeout configuration</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Browser Timeout (seconds)
            </label>
            <input
              type="number"
              min={5}
              max={600}
              value={form.gateway.browser_timeout_secs}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  gateway: { ...f.gateway, browser_timeout_secs: e.target.value },
                }))
              }
              placeholder="30"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition tabular-nums"
            />
            <p className="mt-1.5 text-xs text-muted/70">
              Maximum time to wait for browser-based tools to complete
            </p>
          </div>
        </div>
      </div>

      {/* Save actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : saved ? (
            <Check size={14} />
          ) : (
            <Save size={14} />
          )}
          {saved ? "Saved" : "Save Changes"}
        </button>
        {isDirty && (
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm text-muted hover:text-text-strong hover:border-accent/30 transition"
          >
            <RotateCcw size={14} />
            Reset
          </button>
        )}
        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}
