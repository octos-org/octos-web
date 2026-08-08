import { describe, expect, it } from "vitest";

import type { SkillActionDefinition } from "@/api/skill-actions";

import { resolveStudioSkills } from "./action-catalog";

function action(
  id: string,
  available = true,
  unavailableReason?: string,
): SkillActionDefinition {
  return {
    id,
    skill_id: "test-skill",
    label: id,
    tags: ["notebook"],
    surfaces: ["studio.skills"],
    input_schema: {},
    execution: "background",
    available,
    unavailable_reason: unavailableReason,
  };
}

describe("Studio action catalog", () => {
  it("enables fixed visual slots only when their manifest action is available", () => {
    const skills = resolveStudioSkills([
      action("quiz.generate"),
      action("reports.generate", false, "missing model credentials"),
    ]);

    expect(skills.find((skill) => skill.id === "quiz")?.actionId).toBe("quiz.generate");
    expect(skills.find((skill) => skill.id === "reports")?.actionId).toBeUndefined();
    expect(skills.find((skill) => skill.id === "reports")?.unavailableReason).toBe(
      "missing model credentials",
    );
    expect(skills.find((skill) => skill.id === "mind-map")?.actionId).toBeUndefined();
  });

  it("does not enable NotebookLM placeholders without installed actions", () => {
    const skills = resolveStudioSkills([]);

    expect(skills).toHaveLength(9);
    expect(skills.every((skill) => !skill.actionId)).toBe(true);
  });
});
