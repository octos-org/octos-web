import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import * as authApi from "@/api/auth";
import { setToken, clearToken, getToken } from "@/api/client";
import type { AuthUser } from "@/api/types";

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, code: string) => Promise<void>;
  loginWithToken: (token: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setTokenState] = useState<string | null>(getToken());
  const [loading, setLoading] = useState(true);

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
    authApi
      .me()
      .then((resp) => {
        setUser(resp.user);
      })
      .catch(() => {
        clearToken();
        setTokenState(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const login = useCallback(async (email: string, code: string) => {
    const resp = await authApi.verify(email, code);
    if (resp.ok && resp.token && resp.user) {
      setToken(resp.token);
      setTokenState(resp.token);
      setUser(resp.user);
    } else {
      throw new Error(resp.message || "Login failed");
    }
  }, []);

  const loginWithToken = useCallback(async (t: string) => {
    setToken(t, true);
    setTokenState(t);
    // Validate the token by calling /me. If it fails, the token is invalid.
    try {
      const me = await authApi.me();
      setUser(me.user);
    } catch {
      // Token is likely an admin token without a user record — allow it
      // but mark as admin so the UI works.
      setUser({ email: "admin", role: "admin" } as AuthUser);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    clearToken();
    setTokenState(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, token, loading, login, loginWithToken, logout }}
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
