import { useAuth } from "@/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { LogOut, Sun, Moon, MessageSquare, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function HomeNav() {
  const { user, portal, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <nav className="workbench-topbar flex min-h-16 items-center gap-3 px-5 py-3 max-sm:px-3">
      <button
        type="button"
        onClick={() => navigate("/")}
        className="flex min-w-0 items-center gap-2.5 text-left"
        aria-label="Octos home"
      >
        <img
          src="/images/octos-logo-color.svg"
          alt="Octos"
          className="h-7 w-auto shrink-0 select-none"
        />
        <span className="text-base font-semibold tracking-tight text-text-strong">Octos</span>
      </button>

      <div className="flex-1" />

      <button
        onClick={() => navigate("/chat")}
        className="workbench-button flex items-center gap-2 px-3 py-2 text-sm max-sm:px-2.5"
      >
        <MessageSquare size={16} />
        <span className="max-sm:hidden">Chat</span>
      </button>
      {portal?.can_access_admin_portal && (
        <button
          onClick={() => navigate("/settings")}
          className="glass-icon-button p-2.5"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={18} />
        </button>
      )}
      <button
        onClick={toggleTheme}
        className="glass-icon-button p-2.5"
        title={theme === "dark" ? "Light mode" : "Dark mode"}
        aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      {user && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-[18rem] truncate text-sm text-muted max-md:hidden">
            {user.email}
          </span>
          <button
            onClick={logout}
            className="glass-icon-button p-2"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut size={16} />
          </button>
        </div>
      )}
    </nav>
  );
}
