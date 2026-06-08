import { describe, expect, it } from "vitest";

import { eventMatchesScope, eventSessionId, eventTopic } from "./event-scope";

describe("event scope helpers", () => {
  it("parses a topic suffix carried in session_id", () => {
    const event = { session_id: "site-123#site learning" };

    expect(eventSessionId(event)).toBe("site-123");
    expect(eventTopic(event)).toBe("site learning");
    expect(eventMatchesScope(event, "site-123", "site learning")).toBe(true);
  });
});
