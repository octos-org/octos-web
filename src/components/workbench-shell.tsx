import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Home,
  LogOut,
  MessageSquare,
  Mic,
  MonitorSmartphone,
  Moon,
  Presentation,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "@/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";

type WorkbenchTone = "default" | "accent" | "success" | "warning" | "danger";

const routeItems: Array<{
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}> = [
  { to: "/", label: "Home", icon: Home },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/slides", label: "Slides", icon: Presentation },
  { to: "/sites", label: "Sites", icon: Globe },
  { to: "/home", label: "Display", icon: MonitorSmartphone },
  { to: "/voice", label: "Voice", icon: Mic },
  { to: "/settings", label: "Settings", icon: Settings, adminOnly: true },
];

function isRouteActive(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function WorkbenchPage({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`workbench-shell flex h-screen flex-col overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

export function WorkbenchBrand() {
  return (
    <Link
      to="/"
      className="workbench-brand flex min-w-0 items-center gap-2.5 text-left"
      aria-label="Octos home"
    >
      <img
        src="/images/octos-logo-color.svg"
        alt="Octos"
        className="h-7 w-auto shrink-0 select-none"
      />
      <span className="text-base font-semibold text-text-strong max-sm:hidden">
        Octos
      </span>
    </Link>
  );
}

export function WorkbenchRouteNav({ compact = false }: { compact?: boolean }) {
  const { portal } = useAuth();
  const location = useLocation();

  return (
    <div className="workbench-route-nav flex min-w-0 items-center gap-1.5 overflow-x-auto">
      {routeItems
        .filter((item) => !item.adminOnly || portal?.can_access_admin_portal)
        .map(({ to, label, icon: Icon }) => {
          const active = isRouteActive(location.pathname, to);
          return (
            <Link
              key={to}
              to={to}
              className="workbench-route-link flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm"
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : undefined}
            >
              <Icon size={15} />
              <span className={compact ? "max-lg:hidden" : "max-md:hidden"}>
                {label}
              </span>
            </Link>
          );
        })}
    </div>
  );
}

export function WorkbenchThemeButton() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? "Light mode" : "Dark mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="glass-icon-button p-2.5"
      title={label}
      aria-label={label}
    >
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export function WorkbenchUserActions() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="max-w-[18rem] truncate text-sm text-muted max-xl:hidden">
        {user.email}
      </span>
      <button
        type="button"
        onClick={logout}
        className="glass-icon-button p-2"
        aria-label="Log out"
        title="Log out"
      >
        <LogOut size={16} />
      </button>
    </div>
  );
}

export function WorkbenchTopbar({
  backTo,
  onBack,
  icon: Icon,
  context,
  title,
  subtitle,
  badge,
  actions,
  afterTitle,
}: {
  backTo?: string;
  onBack?: () => void;
  icon?: LucideIcon;
  context?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  afterTitle?: ReactNode;
}) {
  const navigate = useNavigate();
  const backButton = backTo || onBack;
  const titleClass =
    "truncate text-lg font-semibold text-text-strong";
  const titleIsPrimitive = typeof title === "string" || typeof title === "number";

  return (
    <nav className="workbench-topbar shrink-0">
      <div className="workbench-topbar-inner flex min-h-16 items-center gap-3 px-5 py-3 max-sm:flex-wrap max-sm:px-3">
        {backButton && (
          <button
            type="button"
            onClick={() => (onBack ? onBack() : navigate(backTo!))}
            className="glass-icon-button p-2"
            title="Go back"
            aria-label="Go back"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        {Icon && (
          <div className="workbench-icon-tile flex h-10 w-10 shrink-0 items-center justify-center">
            <Icon size={18} />
          </div>
        )}
        <div className="workbench-topbar-title min-w-0 flex-1">
          {context && <div className="shell-kicker">{context}</div>}
          <div className="flex min-w-0 items-center gap-2">
            {titleIsPrimitive ? (
              <h1 className={titleClass}>{title}</h1>
            ) : (
              <div className={titleClass} role="heading" aria-level={1}>
                {title}
              </div>
            )}
            {badge}
          </div>
          {subtitle && (
            <div className="mt-0.5 truncate text-xs text-muted">{subtitle}</div>
          )}
          {afterTitle}
        </div>
        {actions && (
          <div className="workbench-topbar-actions flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        )}
      </div>
    </nav>
  );
}

export function WorkbenchSectionHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="workbench-section-header mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function WorkbenchStatusPill({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: WorkbenchTone;
}) {
  return (
    <span className="workbench-status-pill" data-tone={tone}>
      {children}
    </span>
  );
}

export function WorkbenchRouteCard({
  icon: Icon,
  title,
  description,
  to,
  onClick,
  meta,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  to?: string;
  onClick?: () => void;
  meta?: ReactNode;
}) {
  const navigate = useNavigate();
  const handleClick = () => {
    if (onClick) {
      onClick();
      return;
    }
    if (to) navigate(to);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="workbench-card workbench-route-card flex min-h-32 items-center gap-4 p-5 text-left"
    >
      <div className="workbench-icon-tile flex h-11 w-11 shrink-0 items-center justify-center">
        <Icon size={24} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-strong">{title}</div>
        <div className="mt-1 text-xs text-muted">{description}</div>
        {meta && <div className="mt-3 text-[11px] text-muted/70">{meta}</div>}
      </div>
      <ArrowRight
        className="route-card-arrow text-muted"
        size={17}
        aria-hidden="true"
      />
    </button>
  );
}
