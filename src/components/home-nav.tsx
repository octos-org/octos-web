import {
  WorkbenchBrand,
  WorkbenchRouteNav,
  WorkbenchThemeButton,
  WorkbenchUserActions,
} from "@/components/workbench-shell";

export function HomeNav() {
  return (
    <nav className="workbench-topbar shrink-0">
      <div className="workbench-topbar-inner flex min-h-16 items-center gap-3 px-5 py-3 max-sm:px-3">
        <WorkbenchBrand />
        <WorkbenchRouteNav compact />
        <div className="flex-1" />
        <WorkbenchThemeButton />
        <WorkbenchUserActions />
      </div>
    </nav>
  );
}
