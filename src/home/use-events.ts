/**
 * useEvents — derives calendar views from profile-backed Home settings.
 */

import { useEffect, useMemo, useState } from "react";
import ICAL from "ical.js";
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

/** Convert a wall time with RFC 5545's DST disambiguation rules. */
function ianaDate(time: ICAL.Time, formatter: Intl.DateTimeFormat): Date {
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const renderedWall = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  };
  const offsets = new Set([-86400000, 0, 86400000].map((delta) => renderedWall(wall + delta) - (wall + delta)));
  const candidates = [...offsets].map((offset) => wall - offset);
  const exact = candidates.filter((candidate) => renderedWall(candidate) === wall);
  // RFC 5545: choose the first occurrence of a repeated wall time; a missing
  // wall time uses the offset before the gap (moves forward through the gap).
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates));
}

function installIanaZones(calendar: ICAL.Component): void {
  const embeddedZone = calendar.getTimeZoneByID.bind(calendar);
  const zones = new Map<string, ICAL.Timezone>();
  calendar.getTimeZoneByID = (tzid: string) => {
    const embedded = embeddedZone(tzid);
    if (embedded) return embedded;
    const existing = zones.get(tzid);
    if (existing) return existing;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const zone = new ICAL.Timezone({ tzid });
    zone.utcOffset = (time: ICAL.Time) => {
      const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
      return (wall - ianaDate(time, formatter).getTime()) / 1000;
    };
    zones.set(tzid, zone);
    return zone;
  };
}

export function parseIcsEvents(
  text: string,
  rangeStart = new Date(new Date().setHours(0, 0, 0, 0)),
  rangeEnd = new Date(new Date(rangeStart).setDate(rangeStart.getDate() + 4)),
): CalendarEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(text));
  if (calendar.name !== "vcalendar") throw new Error("Invalid calendar feed.");
  installIanaZones(calendar);
  const events = new Map<string, CalendarEvent>();
  let remaining = 50_000;
  const append = (event: ICAL.Event, start: ICAL.Time, recurrence?: ICAL.Time) => {
    if (event.component.getFirstPropertyValue("status") === "CANCELLED") return;
    const title = event.summary?.replace(/\s+/g, " ").trim();
    if (!title) return;
    const date = start.toJSDate();
    if (recurrence && (date < rangeStart || date >= rangeEnd)) return;
    const id = `ics-${event.uid || title}${recurrence ? `-${recurrence.toString()}` : ""}`;
    events.set(id, {
      id, title, date: fmtDate(date),
      time: start.isDate ? "00:00" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    });
  };
  for (const component of calendar.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(component);
    if (!component.hasProperty("dtstart")) continue;
    if (!event.isRecurring()) {
      append(event, event.startDate, event.isRecurrenceException() ? event.recurrenceId : undefined);
      continue;
    }
    const iterator = event.iterator();
    let occurrence: ICAL.Time | undefined;
    while ((occurrence = iterator.next())) {
      if (--remaining < 0) throw new Error("Calendar recurrence is too large to expand.");
      if (occurrence.toJSDate() >= rangeEnd) break;
      const detail = event.getOccurrenceDetails(occurrence);
      append(detail.item, detail.startDate, occurrence);
    }
  }
  return [...events.values()];
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
  const [today, setToday] = useState(() => fmtDate(new Date()));
  const [calendarFeedError, setCalendarFeedError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      const now = new Date();
      setToday(fmtDate(now));
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(tick, midnight.getTime() - now.getTime() + 10);
    };
    tick();
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  useEffect(() => {
    const url = calendarFeedUrl.trim();
    if (!url) {
      setFeedEvents([]);
      setCalendarFeedError(null);
      return;
    }

    let cancelled = false;
    let requestId = 0;
    const refresh = async () => {
      const current = ++requestId;
      try {
        const text = await fetchIcsText(url);
        if (cancelled || current !== requestId) return;
        setFeedEvents(parseIcsEvents(text));
        setCalendarFeedError(null);
      } catch (err) {
        if (cancelled || current !== requestId) return;
        setCalendarFeedError(
          err instanceof Error ? err.message : "Calendar feed failed",
        );
      }
    };
    // Drop the previous feed immediately; only retain cached entries on a
    // transient refresh failure for this same URL.
    setFeedEvents([]);
    void refresh();
    const timer = setInterval(() => void refresh(), 15 * 60 * 1000);
    const onResume = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [calendarFeedUrl, today]);

  const { todayEvents, upcomingEvents } = useMemo<EventsState>(() => {
    const now = new Date(`${today}T00:00:00`);
    const todayStr = today;
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
  }, [events, feedEvents, today]);

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
