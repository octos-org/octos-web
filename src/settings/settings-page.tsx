import { Fragment, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/auth/auth-context";
import {
  User,
  Cpu,
  Home,
  Puzzle,
  Radio,
  Users,
  Shield,
  Wrench,
  Activity,
  Server,
  Waves,
  Loader2,
  Settings as SettingsIcon,
  Palette,
  Volume2,
  Brain,
  AlarmClock,
  ShieldCheck,
  KeyRound,
  Search,
} from "lucide-react";
import {
  WorkbenchStatusPill,
  WorkbenchThemeButton,
} from "@/components/workbench-shell";
import { StudioTopbar } from "@/components/studio-topbar";
import { getMyProfile, type Profile } from "./settings-api";
import { ProfileTab } from "./profile-tab";
import { LlmTab } from "./llm-tab";
import { ApiKeysTab } from "./api-keys-tab";
import { SkillsTab } from "./skills-tab";
import { ChannelsTab } from "./channels-tab";
import { SmartHomeTab } from "./smart-home-tab";
import { UsersTab } from "./users-tab";
import { SandboxTab } from "./sandbox-tab";
import { ToolsTab } from "./tools-tab";
import { SystemTab } from "./system-tab";
import { ServerTab } from "./server-tab";
import { OminixTab } from "./ominix-tab";
import { AppearanceTab } from "./appearance-tab";
import { VoiceTab } from "./voice-tab";
import { MemoryTab } from "./memory-tab";
import { CronTab } from "./cron-tab";
import { AuthenticationTab } from "./authentication-tab";

type TabId = "profile" | "appearance" | "llm" | "api-keys" | "voice" | "memory" | "schedule" | "skills" | "channels" | "smart-home" | "sandbox" | "tools" | "authentication" | "users" | "system" | "server" | "ominix";

type TabGroup = "personal" | "agent" | "connections" | "system";

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof User;
  adminOnly?: boolean;
  group: TabGroup;
}

/** Settings rail groups (2026-08 UI audit #318): everyday items up
 *  top, admin-only surfaces grouped under System & Runtime. */
const TAB_GROUPS: Array<{ id: TabGroup; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "agent", label: "Agent" },
  { id: "connections", label: "Connections" },
  { id: "system", label: "System & Runtime" },
];

const TABS: TabDef[] = [
  { id: "profile", label: "Profile", icon: User, group: "personal" },
  { id: "appearance", label: "Appearance", icon: Palette, group: "personal" },
  { id: "voice", label: "Voice", icon: Volume2, group: "personal" },
  { id: "memory", label: "Memory", icon: Brain, group: "personal" },
  { id: "llm", label: "LLM", icon: Cpu, group: "agent" },
  { id: "api-keys", label: "API Keys", icon: KeyRound, group: "agent" },
  { id: "tools", label: "Tools", icon: Wrench, group: "agent" },
  { id: "skills", label: "Skills", icon: Puzzle, group: "agent" },
  { id: "channels", label: "Channels", icon: Radio, group: "connections" },
  { id: "smart-home", label: "Smart Home", icon: Home, group: "connections" },
  { id: "schedule", label: "Schedule", icon: AlarmClock, group: "system" },
  { id: "sandbox", label: "Sandbox", icon: Shield, group: "system" },
  { id: "authentication", label: "Authentication", icon: ShieldCheck, adminOnly: true, group: "system" },
  { id: "users", label: "Users", icon: Users, adminOnly: true, group: "system" },
  { id: "system", label: "System", icon: Activity, adminOnly: true, group: "system" },
  { id: "server", label: "Server", icon: Server, adminOnly: true, group: "system" },
  { id: "ominix", label: "OminiX", icon: Waves, adminOnly: true, group: "system" },
];

function asTabId(value: string | null): TabId | null {
  return TABS.some((tab) => tab.id === value) ? value as TabId : null;
}

function accessibleTabId(
  value: string | null,
  canAccessAdminPortal: boolean,
): TabId {
  const id = asTabId(value);
  if (!id) return "profile";
  const tab = TABS.find((entry) => entry.id === id);
  return tab?.adminOnly && !canAccessAdminPortal ? "profile" : id;
}

export function AdminSettingsPage() {
  const { portal } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canAccessAdminPortal = Boolean(portal?.can_access_admin_portal);
  const [activeTab, setActiveTab] = useState<TabId>(
    () => accessibleTabId(searchParams.get("tab"), canAccessAdminPortal),
  );
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  // Self-service `/api/my/*` routes are bound to the authenticated identity;
  // `X-Profile-Id` is not an authorized target selector. Keep this surface on
  // that identity unless it is migrated wholesale to explicit admin profile
  // endpoints, otherwise a dropdown can display one profile while saving
  // another.
  useEffect(() => {
    let cancelled = false;
    getMyProfile().then((data) => {
      if (!cancelled) {
        setProfile(data);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Render-phase adjustment (the docs' "adjusting state when props change"
  // pattern): adopt a ?tab= change from the URL exactly once per params
  // change, so back/forward and deep links work without effect cascades.
  const [lastTabAccessKey, setLastTabAccessKey] = useState<string | null>(null);
  const tabParam = searchParams.get("tab");
  const tabAccessKey = `${tabParam ?? ""}:${canAccessAdminPortal}`;
  if (tabAccessKey !== lastTabAccessKey) {
    setLastTabAccessKey(tabAccessKey);
    const nextTab = accessibleTabId(tabParam, canAccessAdminPortal);
    if (nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  }

  const selectTab = (id: TabId) => {
    setActiveTab(id);
    const next = new URLSearchParams(searchParams);
    if (id === "profile") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next, { replace: true });
  };

  const isAdminOnlyTab = activeTab === "authentication" || activeTab === "system" || activeTab === "server" || activeTab === "users" || activeTab === "ominix";

  // Rail search + grouping (2026-08 audit #318): the 17 flat tabs are
  // grouped into Personal / Agent / Connections / System & Runtime on
  // desktop; a filter input narrows by tab or group label.
  const [tabQuery, setTabQuery] = useState("");
  const q = tabQuery.trim().toLowerCase();
  const searching = q.length > 0;
  const accessibleTabs = TABS.filter(
    (t) => !t.adminOnly || portal?.can_access_admin_portal,
  );
  const matchedTabs = searching
    ? accessibleTabs.filter(
        (t) =>
          t.label.toLowerCase().includes(q) ||
          (TAB_GROUPS.find((g) => g.id === t.group)?.label ?? "")
            .toLowerCase()
            .includes(q),
      )
    : accessibleTabs;

  const renderTabButton = ({ id, label, icon: Icon, adminOnly }: TabDef) => (
    <button
      key={id}
      onClick={() => selectTab(id)}
      data-active={activeTab === id ? "true" : undefined}
      className="settings-tab-button flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition max-md:w-auto max-md:shrink-0 max-md:px-3"
    >
      <Icon size={16} className="shrink-0" />
      {label}
      {adminOnly && (
        <span className="ml-auto shrink-0">
          <WorkbenchStatusPill tone="accent">Admin</WorkbenchStatusPill>
        </span>
      )}
    </button>
  );

  return (
    <div className="studio-shell settings-shell flex h-screen flex-col overflow-hidden">
      <StudioTopbar
        // Predictable exit: /settings has no in-page navigation, so the
        // back affordance always returns to the workspace home instead of
        // relying on history (which can leave the app when deep-linked).
        onBack={() => navigate("/")}
        icon={SettingsIcon}
        context="Octos Control"
        title="Settings"
        subtitle="Profile, models, channels, operators, and local runtime"
        actions={
          <WorkbenchThemeButton />
        }
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden max-md:flex-col">
          <aside className="workbench-rail settings-rail w-60 shrink-0 overflow-y-auto px-3 py-4 max-md:w-full max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-r-0 max-md:py-2">
            <div className="px-1 pb-2">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted/60"
                />
                <input
                  data-testid="settings-tab-search"
                  value={tabQuery}
                  onChange={(e) => setTabQuery(e.target.value)}
                  placeholder="Find a setting..."
                  aria-label="Find a setting"
                  className="w-full rounded-[12px] border border-border bg-surface-container py-2 pl-8 pr-3 text-sm text-text outline-none placeholder:text-muted/60 focus:border-accent"
                />
              </div>
            </div>
            <div className="settings-tab-strip space-y-1 max-md:flex max-md:min-w-max max-md:gap-2 max-md:space-y-0">
              {matchedTabs.length === 0 ? (
                <div className="whitespace-nowrap px-3 py-4 text-xs text-muted/70">
                  No settings match "{tabQuery}"
                </div>
              ) : searching ? (
                matchedTabs.map(renderTabButton)
              ) : (
                TAB_GROUPS.map((group) => {
                  const groupTabs = matchedTabs.filter(
                    (t) => t.group === group.id,
                  );
                  if (groupTabs.length === 0) return null;
                  return (
                    <Fragment key={group.id}>
                      <div className="hidden pt-3 md:block">
                        <div className="shell-kicker px-2 pb-1">
                          {group.label}
                        </div>
                      </div>
                      {groupTabs.map(renderTabButton)}
                    </Fragment>
                  );
                })
              )}
            </div>
          </aside>

          <main className="settings-main min-w-0 flex-1 overflow-y-auto px-8 py-6 max-md:px-4 max-md:py-4">
            <div className={`mx-auto ${isAdminOnlyTab ? "max-w-4xl" : "max-w-3xl"}`}>
              {activeTab === "system" && portal?.can_access_admin_portal && <SystemTab />}
              {activeTab === "server" && portal?.can_access_admin_portal && <ServerTab />}
              {activeTab === "authentication" && portal?.can_access_admin_portal && <AuthenticationTab />}
              {activeTab === "users" && portal?.can_access_admin_portal && profile && <UsersTab profile={profile} />}
              {activeTab === "ominix" && portal?.can_access_admin_portal && <OminixTab />}

              {!isAdminOnlyTab && profile ? (
                <>
                  {activeTab === "profile" && (
                    <ProfileTab
                      profile={profile}
                      onProfileUpdated={setProfile}
                      canDeleteProfile={Boolean(portal?.can_access_admin_portal)}
                    />
                  )}
                  {activeTab === "appearance" && <AppearanceTab />}
                  {activeTab === "llm" && (
                    <LlmTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "api-keys" && (
                    <ApiKeysTab
                      key={profile.id}
                      profile={profile}
                      onProfileUpdated={setProfile}
                    />
                  )}
                  {activeTab === "voice" && (
                    <VoiceTab
                      key={profile.id}
                      profile={profile}
                      onProfileUpdated={setProfile}
                    />
                  )}
                  {activeTab === "memory" && <MemoryTab key={profile.id} />}
                  {activeTab === "schedule" && <CronTab key={profile.id} />}
                  {activeTab === "skills" && <SkillsTab />}
                  {activeTab === "channels" && <ChannelsTab profile={profile} onProfileUpdated={setProfile} />}
                  {activeTab === "smart-home" && (
                    <SmartHomeTab
                      key={profile.id}
                      profile={profile}
                      onProfileUpdated={setProfile}
                    />
                  )}
                  {activeTab === "sandbox" && (
                    <SandboxTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "tools" && (
                    <ToolsTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                </>
              ) : !isAdminOnlyTab ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <p className="text-sm text-muted">No profile available</p>
                  <p className="mt-1 text-xs text-muted/60">
                    Create a profile on the server to get started
                  </p>
                </div>
              ) : null}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
