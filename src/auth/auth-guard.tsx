import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./auth-context";

const skipAuth = import.meta.env.VITE_SKIP_AUTH === "true";

export function AuthGuard() {
  const { token, loading } = useAuth();

  // Only skip auth when explicitly configured via VITE_SKIP_AUTH=true
  if (skipAuth) return <Outlet />;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-dark">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
