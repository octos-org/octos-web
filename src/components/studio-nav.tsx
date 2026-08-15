import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Menu } from "lucide-react";

import { useAuth } from "@/auth/auth-context";
import {
  WorkbenchThemeButton,
  WorkbenchUserActions,
} from "@/components/workbench-shell";
import { unlockAudio } from "@/home/voice/audio-playback";
import { useOminixRuntimeSummary } from "@/home/use-ominix-runtime-summary";
import {
  APP_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
  isAppNavActive,
} from "@/components/app-nav";

function isActive(pathname: string, to: string): boolean {
  return isAppNavActive(pathname, to);
}

/**
 * The Ivory Obsidian glass top bar from the Stitch design: brand,
 * text links with an active underline, and per-page actions on the
 * right ahead of the Display/Voice runtime shortcuts, theme toggle,
 * and user actions.
 *
 * Items come from the shared app-nav source of truth (same set, labels
 * and order as the chat sidebar's WorkbenchRouteNav).
 */
export function StudioNav({ actions }: { actions?: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { portal } = useAuth();
  const voiceRuntime = useOminixRuntimeSummary();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    function onDocPointerDown(event: MouseEvent) {
      if (
        mobileRef.current &&
        !mobileRef.current.contains(event.target as Node)
      ) {
        setMobileOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  // Primary text links + the secondary Display/Voice shortcuts, so the
  // mobile menu reaches exactly the same surfaces as the desktop bar.
  const links = APP_NAV_ITEMS.filter(
    (link) => !link.adminOnly || portal?.can_access_admin_portal,
  );

  return (
    <nav className="studio-glass-nav">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-6">
          {/* Text links collapse into this menu below md so phones never
              lose the routes (the old icon nav kept them at all widths). */}
          <div className="relative md:hidden" ref={mobileRef}>
            <button
              type="button"
              className="studio-ghost-button p-2"
              aria-label="Open navigation"
              aria-haspopup="menu"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((open) => !open)}
            >
              <Menu size={18} />
            </button>
            {mobileOpen && (
              <div role="menu" className="studio-menu left-0 right-auto">
                {links.map((link) => (
                  <button
                    key={link.to}
                    type="button"
                    role="menuitem"
                    className="studio-menu-item"
                    aria-current={
                      isActive(pathname, link.to) ? "page" : undefined
                    }
                    onClick={() => {
                      setMobileOpen(false);
                      navigate(link.to);
                    }}
                  >
                    {link.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="Octos home">
            <img
              src="/images/octos-logo-color.svg"
              alt=""
              aria-hidden="true"
              className="h-6 w-auto"
            />
            <span className="studio-headline text-lg font-bold">Octos</span>
          </Link>
          <div className="hidden h-16 items-center gap-6 md:flex">
            {PRIMARY_NAV_ITEMS.filter(
              (link) => !link.adminOnly || portal?.can_access_admin_portal,
            ).map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="studio-nav-link"
                data-active={isActive(pathname, link.to) || undefined}
                aria-current={isActive(pathname, link.to) ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {SECONDARY_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.to}
                type="button"
                className="studio-ghost-button relative p-2"
                aria-label={item.label}
                title={
                  item.to === "/voice" && voiceRuntime.needsAttention
                    ? `Voice — ${voiceRuntime.label}`
                    : item.label
                }
                onClick={() => {
                  if (item.to === "/voice") unlockAudio();
                  navigate(item.to);
                }}
              >
                <Icon size={18} />
                {item.to === "/voice" && voiceRuntime.needsAttention && (
                  <span
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-highlight"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
          <WorkbenchThemeButton />
          <WorkbenchUserActions />
        </div>
      </div>
    </nav>
  );
}
