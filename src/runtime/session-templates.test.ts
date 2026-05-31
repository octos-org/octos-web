import { describe, expect, it } from "vitest";

import {
  buildSessionTemplateStart,
  clearSessionTemplate,
  setSessionTemplate,
} from "./session-templates";

describe("session template helpers", () => {
  it("builds a topic-scoped slides scaffold command", () => {
    const start = buildSessionTemplateStart("slides", "Westlake Project");
    expect(start).toEqual({
      title: "Westlake Project",
      text: "/new slides westlake-project",
      historyTopic: "slides westlake-project",
    });
  });

  it("builds starter prompts for research and podcast templates", () => {
    expect(buildSessionTemplateStart("research", "EV Market")).toMatchObject({
      title: "EV Market",
    });
    expect(buildSessionTemplateStart("research", "EV Market").text).toContain(
      "deep research",
    );
    expect(buildSessionTemplateStart("podcast", "Rust async").text).toContain(
      "podcast episode",
    );
  });

  it("updates template maps immutably", () => {
    const next = setSessionTemplate({}, "web-1", {
      kind: "slides",
      title: "Deck",
      topic: "slides deck",
    });
    expect(next["web-1"]?.kind).toBe("slides");
    expect(clearSessionTemplate(next, "web-1")).toEqual({});
  });
});
