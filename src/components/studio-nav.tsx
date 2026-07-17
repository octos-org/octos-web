import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Menu, Mic, MonitorSmartphone } from "lucide-react";

import { useAuth } from "@/auth/auth-context";
import {
  WorkbenchThemeButton,
  WorkbenchUserActions,
} from "@/components/workbench-shell";
import { unlockAudio } from "@/home/voice/audio-playback";
import { useOminixRuntimeSummary } from "@/home/use-ominix-runtime-summary";

const NAV_LINKS: Array<{ label: string; to: string; adminOnly?: boolean }> = [
  { label: "Dashboard", to: "/" },
  { label: "Chat", to: "/chat" },
  { label: "Slides", to: "/slides" },
  { label: "Sites", to: "/sites" },
  { label: "Settings", to: "/settings" },
];

function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * The Ivory Obsidian glass top bar from the Stitch design: brand,
 * text links with an active underline, and per-page actions on the
 * right ahead of the Display/Voice runtime shortcuts, theme toggle,
 * and user actions.
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

  const links = NAV_LINKS.filter(
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
              className="h-6 w-6"
            />
            <span className="studio-headline text-lg font-bold">Octos</span>
          </Link>
          <div className="hidden h-16 items-center gap-6 md:flex">
            {links.map((link) => (
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
          <button
            type="button"
            className="studio-ghost-button relative p-2"
            aria-label="Display"
            title="Display mode"
            onClick={() => navigate("/home")}
          >
            <MonitorSmartphone size={18} />
          </button>
          <button
            type="button"
            className="studio-ghost-button relative p-2"
            aria-label="Voice"
            title={
              voiceRuntime.needsAttention
                ? `Voice — ${voiceRuntime.label}`
                : "Voice"
            }
            onClick={() => {
              unlockAudio();
              navigate("/voice");
            }}
          >
            <Mic size={18} />
            {voiceRuntime.needsAttention && (
              <span
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-highlight"
                aria-hidden="true"
              />
            )}
          </button>
          <WorkbenchThemeButton />
          <WorkbenchUserActions />
        </div>
      </div>
    </nav>
  );
}
