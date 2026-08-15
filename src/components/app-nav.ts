import {
  GraduationCap,
  Globe,
  Home,
  MessageSquare,
  Mic,
  MonitorSmartphone,
  Presentation,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface AppNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * Family-device surfaces (full-screen Display, Voice) — rendered as
   * icon shortcuts rather than primary text items, but still part of
   * the SAME ordered list so every shell shows one consistent set.
   */
  secondary?: boolean;
  adminOnly?: boolean;
}

/**
 * Single source of truth for app-level navigation. Every shell
 * (StudioNav top bar, WorkbenchRouteNav sidebar, mobile menus) renders
 * from this list so labels, order, and targets can never drift apart.
 */
export const APP_NAV_ITEMS: AppNavItem[] = [
  { to: "/", label: "Home", icon: Home },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/learn", label: "Learning", icon: GraduationCap },
  { to: "/slides", label: "Slides", icon: Presentation },
  { to: "/sites", label: "Sites", icon: Globe },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/home", label: "Display", icon: MonitorSmartphone, secondary: true },
  { to: "/voice", label: "Voice", icon: Mic, secondary: true },
];

export const PRIMARY_NAV_ITEMS: AppNavItem[] = APP_NAV_ITEMS.filter(
  (item) => !item.secondary,
);

export const SECONDARY_NAV_ITEMS: AppNavItem[] = APP_NAV_ITEMS.filter(
  (item) => item.secondary,
);

/** Exact-match `/`, prefix-match everything else (same rule both navs
 *  previously duplicated). */
export function isAppNavActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}
