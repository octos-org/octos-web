import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  MessageSquare,
  Newspaper,
  Music,
  Home,
  CalendarDays,
  GripVertical,
} from "lucide-react";
import { useClock } from "./use-clock";
import { useWeather } from "./use-weather";
import { useHomeSettings } from "./home-settings-context";
import { useBurnInProtection } from "./use-burn-in-protection";
import { useNews, timeAgo } from "./use-news";
import { useEvents } from "./use-events";
import { useVoiceInput } from "./use-voice-input";
import { VoiceOrb } from "./voice-orb";
import { TimerWidget } from "./timer-widget";
import { PhotoFrame } from "./photo-frame";
import { SettingsGearButton, HomeSettingsPanel } from "./home-settings";
import type { WidgetConfig, WidgetType } from "./widget-registry";

const LS_LAYOUT_KEY = "octos_home_metro_layout";

interface MetroTileGridProps {
  onActivate: (prefill?: string) => void;
  nightActive: boolean;
}

interface TileLayout {
  col: number;
  row: number;
  w: number;
  h: number;
}

interface TileDef {
  id: string;
  widgetType: WidgetType | "quick-chat" | "quick-news" | "quick-music" | "quick-home";
  label: string;
  accent: string;
  defaultLayout: TileLayout;
}

const COLS = 6;
const MOBILE_COLS = 4;
const MAX_ROWS = 12;
const MOBILE_QUERY = "(max-width: 600px)";

const TILE_DEFS: TileDef[] = [
  { id: "clock", widgetType: "clock", label: "Clock", accent: "#16130f", defaultLayout: { col: 1, row: 1, w: 4, h: 2 } },
  { id: "weather", widgetType: "weather", label: "Weather", accent: "#2f453b", defaultLayout: { col: 5, row: 1, w: 2, h: 2 } },
  { id: "quick-chat", widgetType: "quick-chat", label: "Chat", accent: "#9f5a35", defaultLayout: { col: 1, row: 3, w: 1, h: 1 } },
  { id: "quick-news", widgetType: "quick-news", label: "News", accent: "#7c6545", defaultLayout: { col: 2, row: 3, w: 1, h: 1 } },
  { id: "quick-music", widgetType: "quick-music", label: "Music", accent: "#4f6d4c", defaultLayout: { col: 3, row: 3, w: 1, h: 1 } },
  { id: "quick-home", widgetType: "quick-home", label: "Home", accent: "#5c5145", defaultLayout: { col: 4, row: 3, w: 1, h: 1 } },
  { id: "voice", widgetType: "voice-orb", label: "Voice", accent: "#282119", defaultLayout: { col: 5, row: 3, w: 2, h: 2 } },
  { id: "news", widgetType: "news", label: "Headlines", accent: "#241c16", defaultLayout: { col: 1, row: 4, w: 4, h: 2 } },
  { id: "calendar", widgetType: "calendar", label: "Calendar", accent: "#26352f", defaultLayout: { col: 1, row: 6, w: 2, h: 2 } },
  { id: "timer", widgetType: "timer", label: "Timer", accent: "#463521", defaultLayout: { col: 3, row: 6, w: 2, h: 1 } },
  { id: "photo", widgetType: "photo-frame", label: "Photos", accent: "#201d18", defaultLayout: { col: 5, row: 5, w: 2, h: 2 } },
];

function loadLayouts(): Record<string, TileLayout> {
  const defaults = defaultLayouts();
  try {
    const raw = localStorage.getItem(LS_LAYOUT_KEY);
    if (raw) return normalizeLayouts(JSON.parse(raw), defaults);
  } catch { /* ignore */ }
  return defaults;
}

function defaultLayouts(): Record<string, TileLayout> {
  const out: Record<string, TileLayout> = {};
  for (const t of TILE_DEFS) out[t.id] = { ...t.defaultLayout };
  return out;
}

function normalizeLayouts(
  raw: unknown,
  defaults = defaultLayouts(),
): Record<string, TileLayout> {
  const record = raw && typeof raw === "object" ? raw as Record<string, Partial<TileLayout>> : {};
  const numberOr = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const out: Record<string, TileLayout> = {};
  for (const tile of TILE_DEFS) {
    const saved = record[tile.id] ?? {};
    out[tile.id] = {
      col: numberOr(saved.col, defaults[tile.id].col),
      row: numberOr(saved.row, defaults[tile.id].row),
      w: numberOr(saved.w, defaults[tile.id].w),
      h: numberOr(saved.h, defaults[tile.id].h),
    };
  }
  return out;
}

function saveLayouts(layouts: Record<string, TileLayout>) {
  try {
    localStorage.setItem(LS_LAYOUT_KEY, JSON.stringify(layouts));
  } catch { /* quota exceeded or unavailable */ }
}

function tilesOverlap(a: TileLayout, b: TileLayout): boolean {
  return !(
    a.col + a.w <= b.col ||
    b.col + b.w <= a.col ||
    a.row + a.h <= b.row ||
    b.row + b.h <= a.row
  );
}

function hasCollision(
  id: string,
  candidate: TileLayout,
  allLayouts: Record<string, TileLayout>,
  visibleIds: Set<string>,
  cols: number,
): boolean {
  const clamped = clampLayoutForCols(candidate, cols);
  for (const otherId of visibleIds) {
    if (otherId === id) continue;
    const other = allLayouts[otherId];
    if (!other) continue;
    if (tilesOverlap(clamped, clampLayoutForCols(other, cols))) return true;
  }
  return false;
}

function compactLayouts(
  layouts: Record<string, TileLayout>,
  visibleIds: Set<string>,
  cols: number,
): Record<string, TileLayout> {
  const sorted = [...visibleIds]
    .map(id => ({ id, layout: clampLayoutForCols(layouts[id] ?? { col: 1, row: 1, w: 1, h: 1 }, cols) }))
    .sort((a, b) => a.layout.row - b.layout.row || a.layout.col - b.layout.col);

  const result = { ...layouts };
  for (const { id, layout } of sorted) {
    let bestRow = 1;
    for (let tryRow = 1; tryRow <= layout.row; tryRow++) {
      const candidate = { ...layout, row: tryRow };
      const occupied = new Set(visibleIds);
      let fits = true;
      for (const otherId of occupied) {
        if (otherId === id) continue;
        const other = result[otherId];
        if (!other) continue;
        if (tilesOverlap(candidate, clampLayoutForCols(other, cols))) {
          fits = false;
          break;
        }
      }
      if (fits) { bestRow = tryRow; break; }
    }
    result[id] = { ...layout, row: bestRow };
  }
  return result;
}

function getGridMetrics(gridEl: HTMLElement) {
  const rect = gridEl.getBoundingClientRect();
  const style = getComputedStyle(gridEl);
  const cols = Math.max(
    1,
    style.gridTemplateColumns.split(" ").filter(Boolean).length || COLS,
  );
  const gap = parseFloat(style.gap) || 0;
  const stepX = (rect.width + gap) / cols;
  const autoRows = parseFloat(style.gridAutoRows) || 90;
  const stepY = autoRows + gap;
  return { cols, stepX, stepY };
}

function clampLayoutForCols(layout: TileLayout, cols: number): TileLayout {
  const w = Math.max(1, Math.min(cols, layout.w));
  const h = Math.max(1, Math.min(MAX_ROWS, layout.h));
  const col = Math.max(1, Math.min(cols - w + 1, layout.col));
  const row = Math.max(1, Math.min(MAX_ROWS - h + 1, layout.row));
  return { ...layout, col, w, row, h };
}

function useMetroGridColumns() {
  const getCols = useCallback(() => {
    if (typeof window === "undefined") return COLS;
    return window.matchMedia(MOBILE_QUERY).matches ? MOBILE_COLS : COLS;
  }, []);
  const [cols, setCols] = useState(getCols);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setCols(getCols());
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [getCols]);

  return cols;
}

function isWidgetOn(widgets: WidgetConfig[], type: WidgetType): boolean {
  const w = widgets.find((w) => w.type === type);
  return w ? w.enabled : true;
}

function shouldShowTile(tile: TileDef, widgets: WidgetConfig[], nightActive: boolean): boolean {
  if (nightActive && tile.id !== "clock") return false;
  const wt = tile.widgetType;
  if (wt === "quick-chat" || wt === "quick-news" || wt === "quick-music" || wt === "quick-home") {
    return isWidgetOn(widgets, "quick-actions");
  }
  if (wt === "voice-orb" || wt === "weather" || wt === "news" || wt === "calendar" || wt === "timer" || wt === "photo-frame" || wt === "clock") {
    return isWidgetOn(widgets, wt);
  }
  return true;
}

/* ─── Individual Tile Content Components ─── */

function ClockTile({ nightActive }: { nightActive: boolean }) {
  const clock = useClock();
  const { strings, clockFormat } = useHomeSettings();
  const displayHours = (() => {
    const h = clock.date.getHours();
    if (clockFormat === "12h") return String(h % 12 || 12).padStart(2, "0");
    return clock.hours;
  })();
  const ampm = clockFormat === "12h" ? (clock.date.getHours() >= 12 ? "PM" : "AM") : null;
  const dateStr = `${strings.weekdays[clock.date.getDay()]}, ${strings.months[clock.date.getMonth()]} ${clock.date.getDate()}`;

  return (
    <div className="metro-tile-clock">
      <div className={`metro-clock-time ${nightActive ? "metro-clock-night" : ""}`}>
        <span>{displayHours}</span>
        <span className="metro-clock-colon">:</span>
        <span>{clock.minutes}</span>
        {ampm && <span className="metro-clock-ampm">{ampm}</span>}
      </div>
      <div className="metro-clock-date">{dateStr}</div>
    </div>
  );
}

function WeatherTile() {
  const weather = useWeather();
  const { strings, tempUnit } = useHomeSettings();
  const formatTemp = useCallback((tempC: number) => tempUnit === "F" ? Math.round(tempC * 9 / 5 + 32) : tempC, [tempUnit]);
  if (weather.loading) return <div className="metro-tile-loading"><div className="metro-pulse" /></div>;
  if (weather.error) return <span className="metro-tile-muted">{strings.weatherUnavailable}</span>;
  return (
    <div className="metro-tile-weather">
      <div className="metro-weather-main">
        <span className="metro-weather-emoji">{weather.emoji}</span>
        <div>
          <div className="metro-weather-temp">{formatTemp(weather.temperature)}&deg;{tempUnit}</div>
          <div className="metro-weather-label">{weather.label}</div>
        </div>
      </div>
      {weather.hourly.length > 0 && (
        <div className="metro-weather-forecast">
          {weather.hourly.slice(0, 4).map((item, i) => (
            <div key={i} className="metro-forecast-item">
              <span className="metro-forecast-hour">{item.hour}</span>
              <span className="metro-forecast-emoji">{item.emoji}</span>
              <span className="metro-forecast-temp">{formatTemp(item.temp)}&deg;</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuickActionTile({ icon: Icon, label, color, onClick }: { icon: typeof MessageSquare; label: string; color: string; onClick: () => void }) {
  return (
    <button className="metro-quick-action" onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <Icon size={28} className={color} />
      <span className="metro-quick-label">{label}</span>
    </button>
  );
}

function NewsTile({ onActivate }: { onActivate: (prefill: string) => void }) {
  const { strings, newsFeedUrl } = useHomeSettings();
  const news = useNews(newsFeedUrl);
  return (
    <div className="metro-tile-news">
      <div className="metro-tile-header">
        <Newspaper size={14} className="opacity-60" />
        <span>{strings.newsHeadlines}</span>
      </div>
      {news.loading && news.items.length === 0 ? (
        <div className="metro-tile-loading"><div className="metro-pulse" /></div>
      ) : news.error ? (
        <span className="metro-tile-muted">{news.error}</span>
      ) : (
        <div className="metro-news-list">
          {news.items.slice(0, 4).map((item, i) => (
            <button key={i} className="metro-news-item" onClick={(e) => { e.stopPropagation(); onActivate(`Tell me more about: ${item.title}`); }}>
              <p className="metro-news-title">{item.title}</p>
              <span className="metro-news-time">{timeAgo(item.pubDate)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarTile() {
  const { strings } = useHomeSettings();
  const events = useEvents();
  const clock = useClock();
  return (
    <div className="metro-tile-calendar">
      <div className="metro-tile-header">
        <CalendarDays size={14} className="opacity-60" />
        <span>{strings.calendarToday}</span>
      </div>
      {events.todayEvents.length === 0 ? (
        <span className="metro-tile-muted">{strings.calendarNoEvents}</span>
      ) : (
        <div className="metro-calendar-list">
          {events.todayEvents.slice(0, 3).map((ev) => {
            const [h, m] = ev.time.split(":").map(Number);
            const evMin = h * 60 + m;
            const nowMin = clock.date.getHours() * 60 + clock.date.getMinutes();
            const isUpcoming = evMin >= nowMin && evMin - nowMin <= 120;
            return (
              <div key={ev.id} className={`metro-calendar-event ${isUpcoming ? "metro-event-upcoming" : ""}`}>
                <span className="metro-event-time">{ev.time}</span>
                <span className="metro-event-title">{ev.title}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VoiceTile({ onActivate, lang }: { onActivate: (text?: string) => void; lang: string }) {
  const voice = useVoiceInput({ onResult: (text) => onActivate(text), lang: lang === "zh" ? "zh-CN" : "en-US" });
  const handleClick = useCallback(() => {
    if (!voice.isSupported) { onActivate(); return; }
    if (voice.orbState === "listening") voice.stop();
    else if (voice.orbState === "idle") voice.start();
  }, [voice, onActivate]);
  return (
    <div className="metro-tile-voice" onClick={(e) => e.stopPropagation()}>
      <VoiceOrb state={voice.orbState} onClick={handleClick} />
      {voice.orbState === "listening" && voice.transcript && (
        <p className="metro-voice-transcript">{voice.transcript}</p>
      )}
    </div>
  );
}

/* ─── Drag handler for edit mode ─── */
function useTileDrag(
  layouts: Record<string, TileLayout>,
  setLayouts: (fn: (prev: Record<string, TileLayout>) => Record<string, TileLayout>) => void,
  editMode: boolean,
  visibleIds: Set<string>,
) {
  const layoutsRef = useRef(layouts);
  const visibleIdsRef = useRef(visibleIds);
  const dragRef = useRef<{ id: string; startCol: number; startRow: number; startX: number; startY: number; stepX: number; stepY: number; cols: number } | null>(null);

  useEffect(() => {
    layoutsRef.current = layouts;
    visibleIdsRef.current = visibleIds;
  }, [layouts, visibleIds]);

  const onPointerDown = useCallback((e: React.PointerEvent, tileId: string, gridEl: HTMLElement | null) => {
    if (!editMode || !gridEl) return;
    e.preventDefault();
    const { cols, stepX, stepY } = getGridMetrics(gridEl);
    const rawLayout = layoutsRef.current[tileId];
    if (!rawLayout) return;
    const layout = clampLayoutForCols(rawLayout, cols);
    dragRef.current = { id: tileId, startCol: layout.col, startRow: layout.row, startX: e.clientX, startY: e.clientY, stepX, stepY, cols };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [editMode]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { id, startCol, startRow, startX, startY, stepX, stepY, cols } = dragRef.current;
    const dx = Math.round((e.clientX - startX) / stepX);
    const dy = Math.round((e.clientY - startY) / stepY);
    const w = Math.min(cols, layoutsRef.current[id]?.w ?? 1);
    const h = layoutsRef.current[id]?.h ?? 1;
    const newCol = Math.max(1, Math.min(cols - w + 1, startCol + dx));
    const newRow = Math.max(1, Math.min(MAX_ROWS - h + 1, startRow + dy));
    const candidate = { ...layoutsRef.current[id], col: newCol, row: newRow };
    if (hasCollision(id, candidate, layoutsRef.current, visibleIdsRef.current, cols)) return;
    setLayouts(prev => ({ ...prev, [id]: { ...prev[id], col: newCol, row: newRow } }));
  }, [setLayouts]);

  const onPointerUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
      saveLayouts(layoutsRef.current);
    }
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}

/* ─── Resize handler for edit mode ─── */
function useTileResize(
  layouts: Record<string, TileLayout>,
  setLayouts: (fn: (prev: Record<string, TileLayout>) => Record<string, TileLayout>) => void,
  editMode: boolean,
  visibleIds: Set<string>,
) {
  const layoutsRef = useRef(layouts);
  const visibleIdsRef = useRef(visibleIds);
  const resizeRef = useRef<{
    id: string;
    startW: number;
    startH: number;
    startX: number;
    startY: number;
    stepX: number;
    stepY: number;
    maxW: number;
    cols: number;
  } | null>(null);

  useEffect(() => {
    layoutsRef.current = layouts;
    visibleIdsRef.current = visibleIds;
  }, [layouts, visibleIds]);

  const onResizePointerDown = useCallback((e: React.PointerEvent, tileId: string, gridEl: HTMLElement | null) => {
    if (!editMode || !gridEl) return;
    e.preventDefault();
    e.stopPropagation();

    const { cols, stepX, stepY } = getGridMetrics(gridEl);
    const rawLayout = layoutsRef.current[tileId];
    if (!rawLayout) return;
    const layout = clampLayoutForCols(rawLayout, cols);

    resizeRef.current = {
      id: tileId,
      startW: layout.w,
      startH: layout.h,
      startX: e.clientX,
      startY: e.clientY,
      stepX,
      stepY,
      maxW: cols - layout.col + 1,
      cols,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [editMode]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { id, startW, startH, startX, startY, stepX, stepY, maxW, cols } = resizeRef.current;
    const dw = Math.round((e.clientX - startX) / stepX);
    const dh = Math.round((e.clientY - startY) / stepY);
    const row = layoutsRef.current[id]?.row ?? 1;
    const maxH = MAX_ROWS - row + 1;
    const newW = Math.max(1, Math.min(maxW, startW + dw));
    const newH = Math.max(1, Math.min(maxH, startH + dh));
    setLayouts(prev => {
      const cur = prev[id];
      if (!cur) return prev;
      if (cur.w === newW && cur.h === newH) return prev;
      const candidate = { ...cur, w: newW, h: newH };
      if (hasCollision(id, candidate, prev, visibleIdsRef.current, cols)) return prev;
      return { ...prev, [id]: candidate };
    });
  }, [setLayouts]);

  const onResizePointerUp = useCallback(() => {
    if (resizeRef.current) {
      resizeRef.current = null;
      saveLayouts(layoutsRef.current);
    }
  }, []);

  const onResizeKeyDown = useCallback((e: React.KeyboardEvent, tileId: string, gridEl: HTMLElement | null) => {
    if (!editMode || !gridEl) return;
    const delta = { w: 0, h: 0 };
    if (e.key === "ArrowRight") delta.w = 1;
    else if (e.key === "ArrowLeft") delta.w = -1;
    else if (e.key === "ArrowDown") delta.h = 1;
    else if (e.key === "ArrowUp") delta.h = -1;
    else return;
    e.preventDefault();
    const { cols } = getGridMetrics(gridEl);
    setLayouts(prev => {
      const cur = prev[tileId];
      if (!cur) return prev;
      const maxW = cols - cur.col + 1;
      const maxH = MAX_ROWS - cur.row + 1;
      const newW = Math.max(1, Math.min(maxW, cur.w + delta.w));
      const newH = Math.max(1, Math.min(maxH, cur.h + delta.h));
      if (cur.w === newW && cur.h === newH) return prev;
      const candidate = { ...cur, w: newW, h: newH };
      if (hasCollision(tileId, candidate, prev, visibleIdsRef.current, cols)) return prev;
      const next = { ...prev, [tileId]: candidate };
      saveLayouts(next);
      return next;
    });
  }, [editMode, setLayouts]);

  return { onResizePointerDown, onResizePointerMove, onResizePointerUp, onResizeKeyDown };
}

/* ─── Main Metro Tile Grid ─── */

export function MetroTileGrid({ onActivate, nightActive }: MetroTileGridProps) {
  const [layouts, setLayouts] = useState(loadLayouts);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const { strings, widgets, lang } = useHomeSettings();
  const burnIn = useBurnInProtection();
  const gridRef = useRef<HTMLDivElement>(null);
  const gridCols = useMetroGridColumns();

  const visibleTiles = useMemo(
    () => TILE_DEFS.filter(t => shouldShowTile(t, widgets, nightActive)),
    [widgets, nightActive],
  );
  const visibleIds = useMemo(() => new Set(visibleTiles.map(t => t.id)), [visibleTiles]);

  const effectiveLayouts = useMemo(
    () => compactLayouts(layouts, visibleIds, gridCols),
    [layouts, visibleIds, gridCols],
  );

  const drag = useTileDrag(effectiveLayouts, setLayouts, editMode, visibleIds);
  const resize = useTileResize(effectiveLayouts, setLayouts, editMode, visibleIds);

  const handleClick = useCallback(() => {
    if (!settingsOpen && !editMode) onActivate();
  }, [onActivate, settingsOpen, editMode]);

  const resetLayout = useCallback(() => {
    const fresh = defaultLayouts();
    setLayouts(fresh);
    saveLayouts(fresh);
  }, []);

  const renderTile = useCallback((tile: TileDef): ReactNode => {
    switch (tile.id) {
      case "clock": return <ClockTile nightActive={nightActive} />;
      case "weather": return <WeatherTile />;
      case "quick-chat": return <QuickActionTile icon={MessageSquare} label={strings.cardChat} color="text-[#E8B87C]" onClick={() => onActivate(strings.cardChatPrefill)} />;
      case "quick-news": return <QuickActionTile icon={Newspaper} label={strings.cardNews} color="text-[#C4A882]" onClick={() => onActivate(strings.cardNewsPrefill)} />;
      case "quick-music": return <QuickActionTile icon={Music} label={strings.cardMusic} color="text-[#8BAF7B]" onClick={() => onActivate(strings.cardMusicPrefill)} />;
      case "quick-home": return <QuickActionTile icon={Home} label={strings.cardHome} color="text-[#C8A088]" onClick={() => onActivate(strings.cardHomePrefill)} />;
      case "voice": return <VoiceTile onActivate={onActivate} lang={lang} />;
      case "news": return <NewsTile onActivate={onActivate} />;
      case "calendar": return <CalendarTile />;
      case "timer": return <TimerWidget />;
      case "photo": return <PhotoFrame />;
      default: return null;
    }
  }, [nightActive, strings, lang, onActivate]);

  return (
    <div
      className={`metro-grid-container ${burnIn.dimmed ? "home-dimmed" : ""} ${editMode ? "metro-edit-mode" : ""}`}
      onClick={handleClick}
      onMouseMove={() => burnIn.onActivity()}
      onTouchStart={() => burnIn.onActivity()}
    >
      {/* Top bar */}
      <div className="metro-top-bar">
        {editMode && (
          <button className="metro-edit-toggle" onClick={(e) => { e.stopPropagation(); resetLayout(); }}>
            Reset
          </button>
        )}
        <button
          className={`metro-edit-toggle ${editMode ? "metro-edit-active" : ""}`}
          onClick={(e) => { e.stopPropagation(); setEditMode(!editMode); }}
        >
          {editMode ? "Done" : "Edit"}
        </button>
        <SettingsGearButton onClick={() => setSettingsOpen(true)} />
      </div>

      {/* Tile grid */}
      <div
        ref={gridRef}
        className="metro-grid"
        onPointerMove={(e) => { drag.onPointerMove(e); resize.onResizePointerMove(e); }}
        onPointerUp={() => { drag.onPointerUp(); resize.onResizePointerUp(); }}
      >
        {visibleTiles.map(tile => {
          const layout = clampLayoutForCols(
            effectiveLayouts[tile.id] ?? tile.defaultLayout,
            gridCols,
          );
          return (
            <div
              key={tile.id}
              className={`metro-tile ${editMode ? "metro-tile-editing" : ""}`}
              style={{
                gridColumn: `${layout.col} / span ${layout.w}`,
                gridRow: `${layout.row} / span ${layout.h}`,
                backgroundColor: tile.accent,
              }}
              data-tile-id={tile.id}
              onPointerDown={editMode ? (e) => drag.onPointerDown(e, tile.id, gridRef.current) : undefined}
            >
              <div className="metro-tile-content">
                {renderTile(tile)}
              </div>
              {editMode && (
                <>
                  <div className="metro-tile-edit-overlay">
                    <GripVertical size={14} className="opacity-40" />
                    <span className="metro-tile-edit-label">{tile.label}</span>
                  </div>
                  <button
                    type="button"
                    className="metro-resize-handle"
                    aria-label={`Resize ${tile.label}`}
                    tabIndex={0}
                    onPointerDown={(e) => resize.onResizePointerDown(e, tile.id, gridRef.current)}
                    onKeyDown={(e) => resize.onResizeKeyDown(e, tile.id, gridRef.current)}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>

      <HomeSettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
