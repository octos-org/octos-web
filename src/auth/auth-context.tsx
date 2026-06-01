import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as authApi from "@/api/auth";
import {
  clearToken,
  getToken,
  setSelectedProfileId,
  setToken,
} from "@/api/client";
import type { AuthStatusResponse, AuthUser, PortalState } from "@/api/types";

interface AuthState {
  user: AuthUser | null;
  portal: PortalState | null;
  authStatus: AuthStatusResponse | null;
  token: string | null;
  loading: boolean;
  login: (email: string, code: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  /** No-password solo re-login for the existing local owner. Rejects with an
   *  "HTTP 404" error when no solo profile exists yet — the caller then shows
   *  the create form. */
  soloLogin: () => Promise<void>;
  /** Onboard a local profile AND log in (no password). */
  soloCreate: (body: { name: string; username: string; email: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-validate the stored token against `/api/auth/me`. Call this from
   *  any code path that sees an authenticated request rejected (e.g. the
   *  WS bridge's close-with-1008, a 401 from a long-lived poll). On
   *  rejection it wipes localStorage + redirects the user to `/login`,
   *  same as the initial-mount syncMe failure path. */
  revalidate: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [portal, setPortal] = useState<PortalState | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [token, setTokenState] = useState<string | null>(getToken());
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  // Centralised auth-fail handler: wipe token slots, clear React state,
  // and redirect to /login UNLESS we're already there (don't loop on the
  // login page itself when its own /api/auth/verify call rejects). The
  // initial-mount syncMe failure, the WS bridge's auth-1008 close, and
  // any future 401-from-a-long-poll path should all funnel through this
  // single helper so the SPA never lingers on an authenticated route
  // with a dead token (the "/chat zombie state" Yue hit on 2026-05-08).
  const failAuthAndRedirect = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
    setPortal(null);
    if (location.pathname !== "/login") {
      navigate("/login", { replace: true });
    }
  }, [navigate, location.pathname]);

  const syncMe = useCallback(async () => {
    const resp = await authApi.me();
    setUser(resp.user);
    setPortal(resp.portal);
    const maybeProfileId =
      typeof resp.profile === "object" &&
      resp.profile !== null &&
      "profile" in resp.profile &&
      typeof (resp.profile as { profile?: unknown }).profile === "object" &&
      (resp.profile as { profile?: { id?: unknown } }).profile !== null
        ? (resp.profile as { profile?: { id?: unknown } }).profile?.id
        : null;
    if (typeof maybeProfileId === "string" && maybeProfileId.trim()) {
      setSelectedProfileId(maybeProfileId);
    } else if (typeof window !== "undefined") {
      // Issue #111.3: when `/me` returns no profile, clear any stale
      // `selected_profile` from localStorage. Pre-fix the persisted
      // value lingered across accounts/hosts and leaked into the
      // header on subsequent requests, producing wrong-profile
      // history reads and surprise 403s.
      try {
        window.localStorage.removeItem("selected_profile");
      } catch {
        // ignore — localStorage may be unavailable in some sandbox modes
      }
    }
    return resp;
  }, []);

  useEffect(() => {
    authApi.status().then(setAuthStatus).catch(() => {
      // Best-effort bootstrap for login UI. Ignore network/auth-status failures.
    });
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    // If user already set (token login), skip server validation
    if (user) {
      setLoading(false);
      return;
    }
    syncMe()
      .catch(() => {
        failAuthAndRedirect();
      })
      .finally(() => setLoading(false));
  }, [token, user, syncMe, failAuthAndRedirect]);

  const revalidate = useCallback(async () => {
    // Caller flagged that an authenticated request was rejected; re-run
    // the canonical auth probe and let `failAuthAndRedirect` handle the
    // cleanup if the token is genuinely dead. If syncMe succeeds, the
    // rejection was for a different reason (server-side bug, transient
    // race) and we leave the session intact.
    try {
      await syncMe();
    } catch {
      failAuthAndRedirect();
    }
  }, [syncMe, failAuthAndRedirect]);

  // Issue #111.1: subscribe to the WS bridge's `crew:auth_expired`
  // signal so an auth-rejected handshake (server close-code 1008)
  // immediately runs the revalidate path. Pre-fix the bridge silently
  // retried forever and the user sat on a dead /chat with no signal
  // to re-login. The bridge fires this event once per auth-rejected
  // close; revalidate() probes `/api/auth/me` — if the token is
  // genuinely dead, it clears tokens and navigates to /login.
  useEffect(() => {
    function onAuthExpired() {
      void revalidate();
    }
    window.addEventListener("crew:auth_expired", onAuthExpired);
    return () => {
      window.removeEventListener("crew:auth_expired", onAuthExpired);
    };
  }, [revalidate]);

  const login = useCallback(async (email: string, code: string) => {
    const resp = await authApi.verify(email, code);
    if (resp.ok && resp.token && resp.user) {
      setToken(resp.token);
      setTokenState(resp.token);
      await syncMe();
    } else {
      throw new Error(resp.message || "Login failed");
    }
  }, [syncMe]);

  const loginWithToken = useCallback(async (t: string) => {
    setToken(t, true);
    setTokenState(t);
    // Validate the token by calling /me.
    try {
      await syncMe();
    } catch (err) {
      // Any error (auth rejection, network error, etc.) — reject the login attempt
      clearToken();
      setTokenState(null);
      setUser(null);
      setPortal(null);
      const msg = err instanceof Error ? err.message : "Token validation failed";
      throw new Error(msg);
    }
  }, [syncMe]);

  // No-password solo login. The server only honours these on a Local-mode
  // host that opted in (`--solo`) when reached over a non-proxied loopback
  // connection; otherwise they 403/404, so the SPA can never land a session
  // it shouldn't. `setToken(_, false)` stores under the session-token slot.
  const soloLogin = useCallback(async () => {
    const resp = await authApi.soloLogin();
    setToken(resp.token);
    setTokenState(resp.token);
    setUser(resp.user);
    // Refine portal/profile from /me; the token already unblocks AuthGuard.
    try {
      await syncMe();
    } catch {
      // best-effort refine
    }
  }, [syncMe]);

  const soloCreate = useCallback(
    async (body: { name: string; username: string; email: string }) => {
      const resp = await authApi.soloCreate(body);
      setToken(resp.token);
      setTokenState(resp.token);
      // Establish the principal from the create result so the UI has a user
      // even if /me fails. The local solo owner is created with the admin
      // role server-side. (AuthGuard gates on the token, so the app loads
      // regardless, but this keeps user-dependent chrome populated.)
      setUser({
        id: resp.user_id,
        email: resp.email,
        name: resp.name,
        role: "admin",
        created_at: new Date().toISOString(),
        last_login_at: null,
      });
      try {
        await syncMe();
      } catch {
        // best-effort refine
      }
    },
    [syncMe],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    clearToken();
    setTokenState(null);
    setUser(null);
    setPortal(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, portal, authStatus, token, loading, login, loginWithToken, soloLogin, soloCreate, logout, revalidate }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
