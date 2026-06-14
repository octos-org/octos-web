/**
 * useEvents — derives calendar views from profile-backed Home settings.
 */

import { useMemo } from "react";
import { useHomeSettings, type CalendarEvent } from "./home-settings-context";

export type { CalendarEvent };

export interface EventsState {
  todayEvents: CalendarEvent[];
  upcomingEvents: CalendarEvent[];
}

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

export function useEvents() {
  const { events, addEvent, removeEvent } = useHomeSettings();

  const { todayEvents, upcomingEvents } = useMemo<EventsState>(() => {
    const now = new Date();
    const todayStr = fmtDate(now);
    const todayList: CalendarEvent[] = [];
    const upcomingList: CalendarEvent[] = [];

    const upcomingDates: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      upcomingDates.push(fmtDate(d));
    }

    for (const event of events) {
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
  }, [events]);

  return { todayEvents, upcomingEvents, allEvents: events, addEvent, removeEvent };
}
