/**
 * useEvents — derives calendar views from profile-backed Home settings.
 */

import { useEffect, useMemo, useState } from "react";
import { useHomeSettings, type CalendarEvent } from "./home-settings-context";

export type { CalendarEvent };

export interface EventsState {
  todayEvents: CalendarEvent[];
  upcomingEvents: CalendarEvent[];
}

const ICAL_PROXY_PREFIX = "https://r.jina.ai/http://";

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

function matchesDate(event: CalendarEvent, target: string): boolean {
  if (event.date === target) return true;
  if (!event.recurring) return false;
  if (event.date > target) return false;
  if (event.recurring === "daily") return true;
  if (event.recurring === "weekly") return dayOfWeek(event.date) === dayOfWeek(target);
  return false;
}

function sortByTime(a: CalendarEvent, b: CalendarEvent): number {
  return a.time.localeCompare(b.time);
}

function unfoldIcs(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);
}

function icsValue(line: string): string {
  const idx = line.indexOf(":");
  return idx >= 0 ? line.slice(idx + 1).trim() : "";
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

function parseIcsDateTime(value: string): { date: string; time: string } | null {
  const compact = value.trim();
  const match = compact.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!match) return null;

  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: match[4] && match[5] ? `${match[4]}:${match[5]}` : "00:00",
  };
}

export function parseIcsEvents(text: string): CalendarEvent[] {
  const lines = unfoldIcs(text);
  const events: CalendarEvent[] = [];
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const startLine = Object.entries(current).find(([key]) =>
          key.startsWith("DTSTART"),
        );
        const parsed = startLine ? parseIcsDateTime(startLine[1]) : null;
        const title = unescapeIcsText(current.SUMMARY ?? "");
        if (parsed && title) {
          events.push({
            id: `ics-${current.UID ?? `${parsed.date}-${parsed.time}-${title}`}`,
            title,
            date: parsed.date,
            time: parsed.time,
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const key = line.split(":", 1)[0];
    if (key.startsWith("DTSTART")) {
      current[key] = icsValue(line);
    } else if (key === "SUMMARY" || key === "UID") {
      current[key] = icsValue(line);
    }
  }

  return events;
}

async function fetchIcsText(url: string): Promise<string> {
  try {
    const direct = await fetch(url);
    if (direct.ok) return direct.text();
  } catch {
    // Fall through to the reader proxy for public feeds without CORS.
  }

  const proxied = await fetch(`${ICAL_PROXY_PREFIX}${url}`);
  if (!proxied.ok) throw new Error(`Calendar feed HTTP ${proxied.status}`);
  return proxied.text();
}

export function useEvents() {
  const { events, addEvent, removeEvent, calendarFeedUrl } = useHomeSettings();
  const [feedEvents, setFeedEvents] = useState<CalendarEvent[]>([]);
  const [calendarFeedError, setCalendarFeedError] = useState<string | null>(null);

  useEffect(() => {
    const url = calendarFeedUrl.trim();
    if (!url) {
      setFeedEvents([]);
      setCalendarFeedError(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const text = await fetchIcsText(url);
        if (cancelled) return;
        setFeedEvents(parseIcsEvents(text));
        setCalendarFeedError(null);
      } catch (err) {
        if (cancelled) return;
        setFeedEvents([]);
        setCalendarFeedError(
          err instanceof Error ? err.message : "Calendar feed failed",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [calendarFeedUrl]);

  const { todayEvents, upcomingEvents } = useMemo<EventsState>(() => {
    const now = new Date();
    const todayStr = fmtDate(now);
    const todayList: CalendarEvent[] = [];
    const upcomingList: CalendarEvent[] = [];
    const combined = [...events, ...feedEvents];

    const upcomingDates: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      upcomingDates.push(fmtDate(d));
    }

    for (const event of combined) {
      if (matchesDate(event, todayStr)) todayList.push(event);
      for (const date of upcomingDates) {
        if (matchesDate(event, date)) {
          upcomingList.push({ ...event, date });
          break;
        }
      }
    }

    todayList.sort(sortByTime);
    upcomingList.sort((a, b) => a.date.localeCompare(b.date) || sortByTime(a, b));

    return { todayEvents: todayList, upcomingEvents: upcomingList };
  }, [events, feedEvents]);

  return {
    todayEvents,
    upcomingEvents,
    allEvents: events,
    feedEvents,
    calendarFeedError,
    addEvent,
    removeEvent,
  };
}
