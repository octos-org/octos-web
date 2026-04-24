import { API_BASE, TOKEN_KEY, ADMIN_TOKEN_KEY } from "@/lib/constants";
import { getSettings } from "@/hooks/use-settings";
import { absoluteUrl } from "@/lib/utils";

// Per-mini base-domain suffixes. Each mini serves profiles under its
// own base domain (mini1=crew, mini2=bot, mini3=octos, mini5=ocean), so
// the suffix list must cover every variant — otherwise `dspfac.bot.ominix.io`
// resolves to a null profile id and the web client falls back to the
// stored selection (or none at all). The landing-page subdomains themselves
// (`crew.`, `bot.`, `octos.`, `ocean.`, `www`) must be stripped so they
// do not get treated as profile IDs.
const PROFILE_HOST_SUFFIXES = [
  ".octos.ominix.io",
  ".crew.ominix.io",
  ".bot.ominix.io",
  ".ocean.ominix.io",
];
const RESERVED_ROOT_SUBDOMAINS = new Set([
  "crew",
  "octos",
  "bot",
  "ocean",
  "www",
]);

export function inferProfileIdFromHostname(hostname: string): string | null {
  for (const suffix of PROFILE_HOST_SUFFIXES) {
    if (!hostname.endsWith(suffix)) continue;
    const subdomain = hostname.slice(0, -suffix.length);
    if (!subdomain || RESERVED_ROOT_SUBDOMAINS.has(subdomain)) {
      return null;
    }
    return subdomain;
  }
  return null;
}

function inferProfileIdFromHost(): string | null {
  if (typeof window === "undefined") return null;
  return inferProfileIdFromHostname(window.location.hostname);
}

function isLocalBrowserHost(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function getToken(): string | null {
  return (
    localStorage.getItem(TOKEN_KEY) || localStorage.getItem(ADMIN_TOKEN_KEY)
  );
}

export function setToken(token: string, isAdmin = false) {
  localStorage.setItem(isAdmin ? ADMIN_TOKEN_KEY : TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export function getSelectedProfileId(includeStoredFallback = true): string | null {
  // Exact-account portals must be driven by the current hostname, not stale
  // browser state from a different account or sub-account tab.
  return (
    inferProfileIdFromHost() ||
    (includeStoredFallback ? localStorage.getItem("selected_profile") : null)
  );
}

export function setSelectedProfileId(profileId: string) {
  localStorage.setItem("selected_profile", profileId);
}

let selectedProfilePromise: Promise<string | null> | null = null;

export async function ensureSelectedProfileId(): Promise<string | null> {
  const existing = getSelectedProfileId();
  if (existing) return existing;
  if (selectedProfilePromise) return selectedProfilePromise;

  selectedProfilePromise = (async () => {
    const token = getToken();
    if (!token) return null;

    try {
      const resp = await fetch(`${API_BASE}/api/my/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return null;
      const payload = (await resp.json()) as { profile?: { id?: string } };
      const profileId = payload.profile?.id?.trim();
      if (profileId) {
        setSelectedProfileId(profileId);
        return profileId;
      }
      return null;
    } finally {
      selectedProfilePromise = null;
    }
  })();

  return selectedProfilePromise;
}

export function buildApiHeaders(
  extraHeaders: Record<string, string> = {},
  profileIdOverride?: string | null,
  includeStoredProfileFallback = true,
): Record<string, string> {
  const token = getToken();
  const profileId =
    profileIdOverride === undefined
      ? getSelectedProfileId(includeStoredProfileFallback)
      : profileIdOverride;

  return {
    ...extraHeaders,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(profileId ? { "X-Profile-Id": profileId } : {}),
  };
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const settings = getSettings();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  const isAuthPath = path.startsWith("/api/auth/");
  const includeStoredProfileFallback = !isAuthPath;
  const profileHeaderOverride = isAuthPath && !isLocalBrowserHost() ? null : undefined;
  Object.assign(
    headers,
    buildApiHeaders({}, profileHeaderOverride, includeStoredProfileFallback),
  );
  // Pass search engine preference (not sensitive)
  headers["X-Search-Engine"] = settings.searchEngine;
  // Sensitive keys (serperApiKey, crawl4aiUrl) are stored server-side
  // via profile config — not sent per-request in headers.

  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!resp.ok) {
    // Auto-logout on auth failure (expired/invalid token)
    if (resp.status === 401 || resp.status === 403) {
      clearToken();
      // Redirect to login unless already there
      if (!window.location.pathname.endsWith("/login")) {
        window.location.href =
          absoluteUrl("/login") +
          "?redirect=" +
          encodeURIComponent(window.location.pathname);
      }
    }
    const text = await resp.text();
    throw new Error(text || `HTTP ${resp.status}`);
  }

  if (resp.status === 204) {
    return undefined as T;
  }

  const text = await resp.text();
  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}
