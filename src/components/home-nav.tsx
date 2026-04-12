import { useAuth } from "@/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { LogOut, Sun, Moon, MessageSquare, Plus, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function HomeNav({ onNewProject }: { onNewProject: () => void }) {
  const { user, portal, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <nav className="flex items-center gap-4 px-6 py-4">
      <span className="text-xl font-semibold tracking-tight text-text-strong">octos</span>

      <div className="flex-1" />

      <button
        onClick={onNewProject}
        className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-dim"
      >
        <Plus size={16} />
        New project
      </button>
      <button
        onClick={() => navigate("/chat")}
        className="flex items-center gap-2 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text hover:bg-surface-elevated"
      >
        <MessageSquare size={16} />
        Chat
      </button>
      {portal?.can_access_admin_portal && (
        <button
          onClick={() => window.location.assign("/admin/my")}
          className="rounded-xl p-2.5 text-muted hover:bg-surface-container hover:text-text-strong"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      )}
      <button
        onClick={toggleTheme}
        className="rounded-xl p-2.5 text-muted hover:bg-surface-container hover:text-text-strong"
        title={theme === "dark" ? "Light mode" : "Dark mode"}
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      {user && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">{user.email}</span>
          <button
            onClick={logout}
            className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong"
          >
            <LogOut size={16} />
          </button>
        </div>
      )}
    </nav>
  );
}
