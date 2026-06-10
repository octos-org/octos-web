/**
 * Home Settings — slide-in panel from the right.
 *
 * Provides controls for city, temperature unit, clock format, idle
 * timeout, night mode, and language. All values are persisted to
 * localStorage via the HomeSettingsContext.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings, X, ChevronUp, ChevronDown, Clock, CloudSun, Zap, Mic, MessageCircle } from "lucide-react";
import {
  useHomeSettings,
  type ClockFormat,
  type Lang,
  type NightMode,
  type TempUnit,
} from "./home-settings-context";
import type { WidgetType } from "./widget-registry";

// ── Gear button (placed in standby view) ───────────────────────

export function SettingsGearButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="home-settings-gear absolute right-4 top-4 z-30 flex items-center justify-center rounded-xl"
      aria-label="Settings"
    >
      <Settings size={22} className="text-white/40 hover:text-white/80 transition-colors" />
    </button>
  );
}

// ── Panel ───────────────────────────────────────────────────────

interface HomeSettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function HomeSettingsPanel({ open, onClose }: HomeSettingsPanelProps) {
  const s = useHomeSettings();
  const panelRef = useRef<HTMLDivElement>(null);
  // Reset draft each time the panel opens so it picks up the latest value.
  const [cityDraft, setCityDraft] = useState(s.city);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open && !prevOpen) {
    setCityDraft(s.city);
  }
  if (open !== prevOpen) {
    setPrevOpen(open);
  }

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Commit city on blur / Enter
  const commitCity = useCallback(() => {
    const trimmed = cityDraft.trim();
    if (trimmed !== s.city) {
      s.update({ city: trimmed });
    }
  }, [cityDraft, s]);

  const t = s.strings;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 transition-opacity duration-300 ${
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
        style={{ background: "rgba(0,0,0,0.5)" }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={`home-settings-panel fixed right-0 top-0 bottom-0 z-50 flex w-80 max-w-[85vw] flex-col transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-lg font-semibold text-white">{t.settingsTitle}</h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center rounded-lg p-1.5 hover:bg-white/10 transition-colors"
            aria-label={t.settingsClose}
          >
            <X size={20} className="text-white/60" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-6">
          {/* City */}
          <SettingsField label={t.settingsCity}>
            <input
              type="text"
              value={cityDraft}
              onChange={(e) => setCityDraft(e.target.value)}
              onBlur={commitCity}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCity();
              }}
              placeholder={t.settingsCityPlaceholder}
              className="home-settings-input"
            />
          </SettingsField>

          {/* Temperature unit */}
          <SettingsField label={t.settingsTempUnit}>
            <SegmentedPicker
              options={["C", "F"] as TempUnit[]}
              value={s.tempUnit}
              onChange={(v) => s.update({ tempUnit: v })}
            />
          </SettingsField>

          {/* Clock format */}
          <SettingsField label={t.settingsClockFormat}>
            <SegmentedPicker
              options={["12h", "24h"] as ClockFormat[]}
              value={s.clockFormat}
              onChange={(v) => s.update({ clockFormat: v })}
            />
          </SettingsField>

          {/* Idle seconds */}
          <SettingsField label={t.settingsIdleSeconds}>
            <input
              type="number"
              min={10}
              max={300}
              step={5}
              value={s.idleSeconds}
              onChange={(e) =>
                s.update({ idleSeconds: Number(e.target.value) })
              }
              className="home-settings-input w-24 text-center"
            />
          </SettingsField>

          {/* Night mode */}
          <SettingsField label={t.settingsNightMode}>
            <SegmentedPicker
              options={["auto", "on", "off"] as NightMode[]}
              labels={[t.settingsNightAuto, t.settingsNightOn, t.settingsNightOff]}
              value={s.nightMode}
              onChange={(v) => s.update({ nightMode: v })}
            />
          </SettingsField>

          {/* Language */}
          <SettingsField label={t.settingsLanguage}>
            <SegmentedPicker
              options={["en", "zh"] as Lang[]}
              labels={["EN", "\u4E2D\u6587"]}
              value={s.lang}
              onChange={(v) => s.update({ lang: v })}
            />
          </SettingsField>

          {/* Widgets */}
          <SettingsField label={t.settingsWidgets}>
            <div className="space-y-1">
              {[...s.widgets].sort((a, b) => a.order - b.order).map((w) => (
                <WidgetRow
                  key={w.type}
                  type={w.type}
                  enabled={w.enabled}
                  label={widgetLabel(w.type, t)}
                  onToggle={() => s.toggleWidget(w.type)}
                  onMoveUp={() => s.moveWidget(w.type, "up")}
                  onMoveDown={() => s.moveWidget(w.type, "down")}
                />
              ))}
            </div>
          </SettingsField>
        </div>
      </div>
    </>
  );
}

// ── Small helpers ───────────────────────────────────────────────

function SettingsField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-white/50">
        {label}
      </label>
      {children}
    </div>
  );
}

function SegmentedPicker<T extends string>({
  options,
  labels,
  value,
  onChange,
}: {
  options: T[];
  labels?: string[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="home-settings-segmented flex rounded-lg overflow-hidden">
      {options.map((opt, i) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
            value === opt
              ? "bg-blue-500/30 text-blue-300 border-blue-500/40"
              : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70"
          }`}
        >
          {labels?.[i] ?? opt}
        </button>
      ))}
    </div>
  );
}

// ── Widget helpers ─────────────────────────────────────

const WIDGET_ICONS: Record<WidgetType, typeof Clock> = {
  clock: Clock,
  weather: CloudSun,
  "quick-actions": Zap,
  "voice-orb": Mic,
  greeting: MessageCircle,
};

function widgetLabel(type: WidgetType, t: ReturnType<typeof useHomeSettings>["strings"]): string {
  const map: Record<WidgetType, string> = {
    clock: t.widgetClock,
    weather: t.widgetWeather,
    "quick-actions": t.widgetQuickActions,
    "voice-orb": t.widgetVoiceOrb,
    greeting: t.widgetGreeting,
  };
  return map[type];
}

function WidgetRow({
  type,
  enabled,
  label,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  type: WidgetType;
  enabled: boolean;
  label: string;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const Icon = WIDGET_ICONS[type];
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors">
      <Icon size={16} className="text-white/40 shrink-0" />
      <span className="flex-1 text-sm text-white/70">{label}</span>
      <button
        onClick={onMoveUp}
        className="p-1 rounded hover:bg-white/10 transition-colors active:scale-90"
        aria-label="Move up"
      >
        <ChevronUp size={14} className="text-white/40" />
      </button>
      <button
        onClick={onMoveDown}
        className="p-1 rounded hover:bg-white/10 transition-colors active:scale-90"
        aria-label="Move down"
      >
        <ChevronDown size={14} className="text-white/40" />
      </button>
      <button
        onClick={onToggle}
        className={`w-9 h-5 rounded-full transition-colors relative ${
          enabled ? "bg-blue-500/60" : "bg-white/10"
        }`}
        aria-label={`Toggle ${label}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
