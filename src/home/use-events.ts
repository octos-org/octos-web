/**
 * useEvents — manual calendar events stored in localStorage.
 *
 * Events are keyed under `octos_home_events`.  Supports daily/weekly
 * recurrence.  Exposes today's events and the upcoming 3-day window.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

// ── Types ───────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  /** "HH:MM" */
  time: string;
  /** "YYYY-MM-DD" */
  date: string;
  recurring?: "daily" | "weekly";
}

export interface EventsState {
  todayEvents: CalendarEvent[];
  upcomingEvents: CalendarEvent[];
}

// ── Storage helpers ─────────────────────────────────────────────

const LS_KEY = "octos_home_events";

function readEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEvents(events: CalendarEvent[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(events));
  // Notify all useSyncExternalStore subscribers.
  window.dispatchEvent(new Event("octos-events-change"));
}

/** Generate a short pseudo-random id. */
function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Subscribe / snapshot (for useSyncExternalStore) ─────────────

function subscribe(cb: () => void) {
  window.addEventListener("octos-events-change", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("octos-events-change", cb);
    window.removeEventListener("storage", cb);
  };
}

// Cache the snapshot by raw localStorage string so the returned reference is
// stable across renders when the stored data hasn't changed. `readEvents()`
// parses JSON into a fresh array every call; handing that straight to
// `useSyncExternalStore` made `getSnapshot` return a new reference each render
// → "getSnapshot should be cached" → infinite re-render loop (Maximum update
// depth). Recompute only when the underlying raw string actually changes.
let snapshotRaw: string | null | undefined;
let snapshotValue: CalendarEvent[] = [];

function getSnapshot(): CalendarEvent[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch {
    raw = null;
  }
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      snapshotValue = Array.isArray(parsed) ? parsed : [];
    } catch {
      snapshotValue = [];
    }
  }
  return snapshotValue;
}

// ── Date helpers ────────────────────────────────────────────────

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayOfWeek(dateStr: string): number {
  return new Date(dateStr + "T00:00:00").getDay();
}

function matchesDate(event: CalendarEvent, target: string): boolean {
  if (event.date === target) return true;
  if (!event.recurring) return false;
  // Only match if event date <= target date.
  if (event.date > target) return false;
  if (event.recurring === "daily") return true;
  if (event.recurring === "weekly") return dayOfWeek(event.date) === dayOfWeek(target);
  return false;
}

function sortByTime(a: CalendarEvent, b: CalendarEvent): number {
  return a.time.localeCompare(b.time);
}

// ── Hook ────────────────────────────────────────────────────────

export function useEvents() {
  const events = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const { todayEvents, upcomingEvents } = useMemo<EventsState>(() => {
    const now = new Date();
    const todayStr = fmtDate(now);

    const todayList: CalendarEvent[] = [];
    const upcomingList: CalendarEvent[] = [];

    // Build date strings for upcoming 3 days (excluding today).
    const upcomingDates: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      upcomingDates.push(fmtDate(d));
    }

    for (const ev of events) {
      if (matchesDate(ev, todayStr)) todayList.push(ev);
      for (const ud of upcomingDates) {
        if (matchesDate(ev, ud)) {
          upcomingList.push({ ...ev, date: ud });
          break; // only first match per event in upcoming window
        }
      }
    }

    todayList.sort(sortByTime);
    upcomingList.sort((a, b) => a.date.localeCompare(b.date) || sortByTime(a, b));

    return { todayEvents: todayList, upcomingEvents: upcomingList };
  }, [events]);

  const addEvent = useCallback(
    (event: Omit<CalendarEvent, "id">) => {
      const all = readEvents();
      all.push({ ...event, id: makeId() });
      writeEvents(all);
    },
    [],
  );

  const removeEvent = useCallback((id: string) => {
    writeEvents(readEvents().filter((e) => e.id !== id));
  }, []);

  return { todayEvents, upcomingEvents, allEvents: events, addEvent, removeEvent };
}
