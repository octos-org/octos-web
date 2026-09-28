import { describe, expect, it } from "vitest";

import { parseIcsEvents } from "./use-events";

describe("parseIcsEvents", () => {
  it("parses basic VEVENT entries from an iCal feed", () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-1
DTSTART:20260615T190000Z
SUMMARY:Dinner\\, home
END:VEVENT
BEGIN:VEVENT
UID:evt-2
DTSTART;VALUE=DATE:20260616
SUMMARY:All-day planning
END:VEVENT
END:VCALENDAR`);

    const local = new Date("2026-06-15T19:00:00Z");
    expect(events).toEqual([
      {
        id: "ics-evt-1",
        title: "Dinner, home",
        date: `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`,
        time: `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`,
      },
      {
        id: "ics-evt-2",
        title: "All-day planning",
        date: "2026-06-16",
        time: "00:00",
      },
    ]);
  });
});
