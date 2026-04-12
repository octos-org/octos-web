import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
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
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [portal, setPortal] = useState<PortalState | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [token, setTokenState] = useState<string | null>(getToken());
  const [loading, setLoading] = useState(true);

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
        clearToken();
        setTokenState(null);
        setUser(null);
        setPortal(null);
      })
      .finally(() => setLoading(false));
  }, [token, user, syncMe]);

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
      value={{ user, portal, authStatus, token, loading, login, loginWithToken, logout }}
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
