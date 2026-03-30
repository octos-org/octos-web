import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./auth-context";

const isStaticDeploy = import.meta.env.BASE_URL !== "/";

export function AuthGuard() {
  const { token, loading } = useAuth();

  // Skip auth on static deployments (e.g. GitHub Pages)
  if (isStaticDeploy) return <Outlet />;

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
