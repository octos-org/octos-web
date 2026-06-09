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
} from "lucide-react";
import { updateMyProfile, type Profile } from "./settings-api";

interface ToolsTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}

/* ── Search engine definitions ── */

interface SearchEngine {
  key: string;        // env var name
  name: string;
  description: string;
  placeholder: string;
  docsUrl?: string;
}

const SEARCH_ENGINES: SearchEngine[] = [
  {
    key: "SERPER_API_KEY",
    name: "Serper (Google)",
    description: "Google Search via Serper.dev API",
    placeholder: "Enter Serper API key",
    docsUrl: "https://serper.dev",
  },
  {
    key: "TAVILY_API_KEY",
    name: "Tavily",
    description: "AI-optimized search engine",
    placeholder: "Enter Tavily API key",
    docsUrl: "https://tavily.com",
  },
  {
    key: "PERPLEXITY_API_KEY",
    name: "Perplexity",
    description: "Perplexity AI search API",
    placeholder: "Enter Perplexity API key",
    docsUrl: "https://docs.perplexity.ai",
  },
  {
    key: "YDC_API_KEY",
    name: "You.com",
    description: "You.com web search API",
    placeholder: "Enter You.com API key",
    docsUrl: "https://you.com/search-api",
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

/* ── Form state ── */

interface ToolsFormState {
  env_vars: Record<string, string>;
  crawl: CrawlConfig;
  gateway: GatewaySettings;
}

function profileToForm(profile: Profile): ToolsFormState {
  const envVars = profile.config.env_vars ?? {};
  return {
    env_vars: {
      SERPER_API_KEY: envVars.SERPER_API_KEY ?? "",
      TAVILY_API_KEY: envVars.TAVILY_API_KEY ?? "",
      PERPLEXITY_API_KEY: envVars.PERPLEXITY_API_KEY ?? "",
      YDC_API_KEY: envVars.YDC_API_KEY ?? "",
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
    const result = await updateMyProfile(payload);
    setSaving(false);
    if (result) {
      onProfileUpdated(result);
      const newForm = profileToForm(result);
      setForm(newForm);
      setOriginal(newForm);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError("Failed to update tools config.");
    }
  };

  const handleReset = () => {
    setForm(profileToForm(profile));
    setOriginal(profileToForm(profile));
  };

  const handleTestConnection = (engineKey: string) => {
    // Mark as testing
    setTestResults((prev) => ({ ...prev, [engineKey]: { status: "testing" } }));

    // Simulate a test - in a real scenario this would hit a backend /api/test-connection endpoint
    // For now, we validate the key format is non-empty and looks plausible
    const value = form.env_vars[engineKey]?.trim();
    setTimeout(() => {
      if (!value) {
        setTestResults((prev) => ({
          ...prev,
          [engineKey]: { status: "error", message: "API key is empty" },
        }));
      } else if (value.length < 8) {
        setTestResults((prev) => ({
          ...prev,
          [engineKey]: { status: "error", message: "API key appears too short" },
        }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [engineKey]: { status: "success", message: "Key format looks valid (save to apply)" },
        }));
      }
    }, 800);
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
      <div className="glass-section rounded-2xl p-6">
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
              onTest={() => handleTestConnection(engine.key)}
            />
          ))}
        </div>
      </div>

      {/* Deep Crawl Config */}
      <div className="glass-section rounded-2xl p-6">
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
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
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
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
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
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
            />
          </div>
        </div>
      </div>

      {/* Gateway Settings */}
      <div className="glass-section rounded-2xl p-6">
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
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
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
