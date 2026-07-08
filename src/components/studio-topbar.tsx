import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, type LucideIcon } from "lucide-react";

/**
 * Tool-page chrome in the Ivory Obsidian design language. API-compatible
 * with the legacy `WorkbenchTopbar` so editor/settings surfaces swap
 * shells without touching their behavior: back affordance, icon chip,
 * kicker context, editable-title slot, badge, and right-aligned actions.
 */
export function StudioTopbar({
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
  const titleClass = "studio-headline truncate text-lg";
  const titleIsPrimitive =
    typeof title === "string" || typeof title === "number";

  return (
    <nav className="studio-glass-nav shrink-0">
      <div className="flex min-h-16 items-center gap-3 px-5 py-3 max-sm:flex-wrap max-sm:px-3">
        {backButton && (
          <button
            type="button"
            onClick={() => (onBack ? onBack() : navigate(backTo!))}
            className="studio-ghost-button p-2"
            title="Go back"
            aria-label="Go back"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        {Icon && (
          <div className="studio-skill-tile-icon h-10 w-10 shrink-0">
            <Icon size={18} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          {context && <div className="studio-kicker">{context}</div>}
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
          <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        )}
      </div>
    </nav>
  );
}
