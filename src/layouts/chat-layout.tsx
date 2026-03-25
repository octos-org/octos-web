import type { ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/auth-context";
import { useOctosStatus } from "@/hooks/use-octos-status";
import { useTheme } from "@/hooks/use-theme";
import { CostBar } from "@/components/cost-bar";
import { SessionList } from "@/components/session-list";
import { LogOut, MessageSquare, BookOpen, Sun, Moon } from "lucide-react";

export function ChatLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const status = useOctosStatus();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const isNotebookRoute = location.pathname.startsWith("/notebooks");

  return (
    <div className="flex h-screen bg-surface-dark">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-border bg-surface">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <BookOpen size={20} className="text-accent" />
          <span className="font-semibold text-text-strong">MoFa</span>
          <button
            onClick={toggleTheme}
            className="ml-auto rounded-lg p-1.5 text-muted hover:bg-surface-light hover:text-accent transition"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>

        {/* Nav tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => navigate("/notebooks")}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition ${
              isNotebookRoute
                ? "border-b-2 border-accent text-accent"
                : "text-muted hover:text-text"
            }`}
          >
            <BookOpen size={14} />
            Notebooks
          </button>
          <button
            onClick={() => navigate("/")}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition ${
              !isNotebookRoute
                ? "border-b-2 border-accent text-accent"
                : "text-muted hover:text-text"
            }`}
          >
            <MessageSquare size={14} />
            Chat
          </button>
        </div>

        {/* Session list (only in chat mode) */}
        {!isNotebookRoute && <SessionList />}
        {isNotebookRoute && <div className="flex-1" />}

        {/* Footer */}
        <div className="border-t border-border p-3">
          {status && (
            <div className="mb-2 text-xs text-muted">
              {status.provider}/{status.model}
            </div>
          )}
          {user && (
            <div className="flex items-center justify-between">
              <span className="truncate text-sm text-text">
                {user.email}
              </span>
              <button
                onClick={logout}
                className="rounded p-1 text-muted hover:bg-surface-light hover:text-white"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex flex-1 min-w-0 flex-col min-h-0">
        {!isNotebookRoute && <CostBar model={status?.model} provider={status?.provider} />}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
