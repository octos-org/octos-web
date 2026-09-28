import { describe, expect, it } from "vitest";
import { parseIcsEvents } from "./use-events";

const calendar = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;
const event = (start: string, extra = "") => `BEGIN:VEVENT\nUID:meeting\n${start}\nSUMMARY:Meeting\n${extra}\nEND:VEVENT`;
function local(iso: string) {
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` };
}

describe("calendar timezone and recurrence semantics", () => {
  it("converts an IANA TZID without an embedded VTIMEZONE", () => {
    const [entry] = parseIcsEvents(calendar(event("DTSTART;TZID=Asia/Tokyo:20260911T090000")));
    expect(entry).toMatchObject(local("2026-09-11T00:00:00Z"));
  });
  it("uses the first occurrence of an ambiguous DST wall time", () => {
    const [entry] = parseIcsEvents(calendar(event("DTSTART;TZID=America/New_York:20261101T013000")));
    expect(entry).toMatchObject(local("2026-11-01T05:30:00Z"));
  });
  it("moves nonexistent DST wall times forward through the gap", () => {
    const [entry] = parseIcsEvents(calendar(event("DTSTART;TZID=America/New_York:20260308T023000")));
    expect(entry).toMatchObject(local("2026-03-08T07:30:00Z"));
  });
  it("preserves floating and all-day dates", () => {
    const [floating] = parseIcsEvents(calendar(event("DTSTART:20260911T090000")));
    const [allDay] = parseIcsEvents(calendar(event("DTSTART;VALUE=DATE:20260911")));
    expect(floating).toMatchObject({ date: "2026-09-11", time: "09:00" });
    expect(allDay).toMatchObject({ date: "2026-09-11", time: "00:00" });
  });
  it("expands recurrence with exclusions and moved exceptions inside the display window", () => {
    const text = calendar(event("DTSTART:20260907T130000Z", "RRULE:FREQ=DAILY;COUNT=4\nEXDATE:20260908T130000Z")
      + "\nBEGIN:VEVENT\nUID:meeting\nRECURRENCE-ID:20260909T130000Z\nDTSTART:20260909T160000Z\nSUMMARY:Moved meeting\nEND:VEVENT");
    const entries = parseIcsEvents(text, new Date("2026-09-07T00:00:00Z"), new Date("2026-09-12T00:00:00Z"));
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.title === "Moved meeting")).toMatchObject(local("2026-09-09T16:00:00Z"));
    expect(entries.map((entry) => entry.time)).toContain(local("2026-09-07T13:00:00Z").time);
  });
});
