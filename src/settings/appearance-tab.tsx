import { Check, Moon, Palette, Sun } from "lucide-react";

import { useTheme, type UiStyle } from "@/hooks/use-theme";

const STYLE_OPTIONS: Array<{
  id: UiStyle;
  label: string;
  description: string;
  swatches: string[];
}> = [
  {
    id: "ivory-obsidian",
    label: "Ivory Obsidian",
    description: "The studio flagship — architectural ivory, obsidian ink, and bone accents.",
    swatches: ["#faf9f7", "#efeeec", "#1c1b1b", "#655d51"],
  },
  {
    id: "warm",
    label: "Warm Hearth",
    description: "Current family-console palette with restrained brown and sage accents.",
    swatches: ["#1a1714", "#252019", "#d4a574", "#94a36f"],
  },
  {
    id: "warm-sage",
    label: "Garden Sage",
    description: "Quieter green-led palette for a softer household console.",
    swatches: ["#151914", "#263126", "#c8a66f", "#8fb37e"],
  },
  {
    id: "warm-daylight",
    label: "Soft Daylight",
    description: "Lighter warm shell with clay and olive accents.",
    swatches: ["#f7f5ef", "#e5eadf", "#b97750", "#6f8b66"],
  },
  {
    id: "legacy-blue",
    label: "Legacy Blue",
    description: "The older deep-ocean Octos shell from the May workbench UI.",
    swatches: ["#081e3f", "#0c2444", "#3b82f6", "#00b4ef"],
  },
];

export function AppearanceTab() {
  const { theme, setTheme, toggleTheme, uiStyle, setUiStyle } = useTheme();

  const chooseStyle = (next: UiStyle) => {
    setUiStyle(next);
    if (next === "legacy-blue") {
      setTheme("dark");
    }
  };

  return (
    <div className="space-y-5">
      <section className="glass-section p-5">
        <div className="flex items-start gap-3">
          <div className="workbench-icon-tile flex h-10 w-10 shrink-0 items-center justify-center">
            <Palette size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-text-strong">Interface Style</h3>
            <p className="mt-1 text-sm text-muted">
              Choose the global Octos shell used by Home, Settings, and shared workbench surfaces.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {STYLE_OPTIONS.map((option) => {
            const active = uiStyle === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                aria-pressed={active}
                data-active={active ? "true" : undefined}
                onClick={() => chooseStyle(option.id)}
                className="workbench-card flex min-h-36 flex-col items-start justify-between gap-4 p-4 text-left"
              >
                <span className="flex w-full items-start justify-between gap-3">
                  <span>
                    <span className="block text-sm font-semibold text-text-strong">
                      {option.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted">
                      {option.description}
                    </span>
                  </span>
                  {active && (
                    <span className="workbench-status-pill" data-tone="accent">
                      <Check size={13} />
                      Active
                    </span>
                  )}
                </span>
                <span className="flex gap-2" aria-hidden="true">
                  {option.swatches.map((color) => (
                    <span
                      key={color}
                      className="h-7 w-7 rounded-md border border-border"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="glass-section p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-text-strong">Brightness</h3>
            <p className="mt-1 text-sm text-muted">
              The color family and light/dark preference are stored separately.
            </p>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="workbench-button flex items-center gap-2 px-4 text-sm font-semibold"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </section>
    </div>
  );
}
