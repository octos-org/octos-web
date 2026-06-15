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

    expect(events).toEqual([
      {
        id: "ics-evt-1",
        title: "Dinner, home",
        date: "2026-06-15",
        time: "19:00",
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
