import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "@/hooks/use-settings";
import { useTheme } from "@/hooks/use-theme";
import {
  ArrowLeft,
  Search,
  Eye,
  EyeOff,
  Check,
  Sun,
  Moon,
  ExternalLink,
} from "lucide-react";

export function SettingsPage() {
  const navigate = useNavigate();
  const { settings, update } = useSettings();
  const { theme, toggleTheme } = useTheme();
  const [showSerperKey, setShowSerperKey] = useState(false);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "error"
  >("idle");
  const [testMessage, setTestMessage] = useState("");

  const testSerperKey = async () => {
    if (!settings.serperApiKey.trim()) return;
    setTestStatus("testing");
    setTestMessage("");
    try {
      const resp = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": settings.serperApiKey.trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: "test", num: 1 }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const credits = resp.headers.get("X-Credits-Remaining");
        setTestStatus("ok");
        setTestMessage(
          `Connected! ${data.organic?.length ?? 0} results returned.${
            credits ? ` Credits remaining: ${credits}` : ""
          }`,
        );
      } else {
        const text = await resp.text();
        setTestStatus("error");
        setTestMessage(`HTTP ${resp.status}: ${text.slice(0, 100)}`);
      }
    } catch (e) {
      setTestStatus("error");
      setTestMessage(e instanceof Error ? e.message : "Connection failed");
    }
  };

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      {/* Header */}
      <nav className="flex items-center gap-4 px-6 py-4">
        <button
          onClick={() => navigate(-1)}
          className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-lg font-semibold tracking-tight text-text-strong">
          Settings
        </span>
        <div className="flex-1" />
        <button
          onClick={toggleTheme}
          className="rounded-xl p-2.5 text-muted hover:bg-surface-container hover:text-text-strong"
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {/* Search Engine */}
          <section className="mb-8">
            <h2 className="mb-1 text-sm font-medium text-text-strong">
              Search Engine
            </h2>
            <p className="mb-4 text-xs text-muted">
              Choose how the agent performs web searches.
            </p>

            <div className="flex flex-col gap-2">
              {(
                [
                  {
                    value: "default",
                    label: "Default (Backend)",
                    desc: "Use the server's built-in CDP browser search",
                  },
                  {
                    value: "serper",
                    label: "Serper.dev",
                    desc: "Fast Google Search API — no CAPTCHAs, $0.30-1/1K queries",
                  },
                  {
                    value: "duckduckgo",
                    label: "DuckDuckGo",
                    desc: "Free, no API key needed — may be rate-limited",
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => update({ searchEngine: opt.value })}
                  className={`flex items-start gap-3 rounded-xl p-4 text-left transition ${
                    settings.searchEngine === opt.value
                      ? "bg-accent-container border border-accent/30"
                      : "bg-surface-container border border-transparent hover:bg-surface-elevated"
                  }`}
                >
                  <div
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                      settings.searchEngine === opt.value
                        ? "border-accent bg-accent"
                        : "border-muted"
                    }`}
                  >
                    {settings.searchEngine === opt.value && (
                      <Check size={12} className="text-white" />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-text-strong">
                      {opt.label}
                    </div>
                    <div className="text-xs text-muted">{opt.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* Serper API Key */}
          {settings.searchEngine === "serper" && (
            <section className="mb-8 animate-in slide-in-from-top-2">
              <div className="flex items-center gap-2 mb-1">
                <Search size={14} className="text-accent" />
                <h2 className="text-sm font-medium text-text-strong">
                  Serper.dev API Key
                </h2>
              </div>
              <p className="mb-4 text-xs text-muted">
                Get your free API key (2,500 searches) at{" "}
                <a
                  href="https://serper.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link hover:text-accent inline-flex items-center gap-0.5"
                >
                  serper.dev <ExternalLink size={10} />
                </a>
              </p>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showSerperKey ? "text" : "password"}
                    value={settings.serperApiKey}
                    onChange={(e) =>
                      update({ serperApiKey: e.target.value })
                    }
                    placeholder="Enter your Serper API key"
                    className="w-full rounded-xl bg-surface-container px-4 py-3 pr-10 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30"
                  />
                  <button
                    onClick={() => setShowSerperKey(!showSerperKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                  >
                    {showSerperKey ? (
                      <EyeOff size={16} />
                    ) : (
                      <Eye size={16} />
                    )}
                  </button>
                </div>
                <button
                  onClick={testSerperKey}
                  disabled={
                    !settings.serperApiKey.trim() || testStatus === "testing"
                  }
                  className="shrink-0 rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30"
                >
                  {testStatus === "testing" ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    "Test"
                  )}
                </button>
              </div>

              {testMessage && (
                <div
                  className={`mt-3 rounded-lg px-4 py-2.5 text-xs ${
                    testStatus === "ok"
                      ? "bg-green-500/10 text-green-400"
                      : "bg-red-500/10 text-red-400"
                  }`}
                >
                  {testMessage}
                </div>
              )}
            </section>
          )}

          {/* Crawl4AI */}
          <section className="mb-8">
            <h2 className="mb-1 text-sm font-medium text-text-strong">
              Crawl4AI Server
            </h2>
            <p className="mb-4 text-xs text-muted">
              Optional. Connect to a Crawl4AI instance for enhanced web content
              extraction.
            </p>
            <input
              type="text"
              value={settings.crawl4aiUrl}
              onChange={(e) => update({ crawl4aiUrl: e.target.value })}
              placeholder="http://localhost:11235"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30"
            />
          </section>

          {/* Info */}
          <section className="rounded-xl bg-surface-container p-5">
            <h3 className="mb-2 text-xs font-medium text-text-strong uppercase tracking-wider">
              How it works
            </h3>
            <ul className="flex flex-col gap-2 text-xs text-muted">
              <li>
                <strong className="text-text">Serper.dev</strong> — Sends
                search queries to Google via Serper's API. Fast, reliable, no
                CAPTCHAs. Free tier: 2,500 queries.
              </li>
              <li>
                <strong className="text-text">DuckDuckGo</strong> — Searches
                via DuckDuckGo's endpoints. Free but may hit rate limits.
              </li>
              <li>
                <strong className="text-text">Crawl4AI</strong> — After
                getting search results, fetches and extracts clean content from
                linked pages. Run{" "}
                <code className="rounded bg-surface-dark px-1.5 py-0.5 text-code-inline">
                  docker run -p 11235:11235 unclecode/crawl4ai
                </code>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
