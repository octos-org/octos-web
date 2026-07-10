import type { SkillActionDefinition } from "@/api/skill-actions";

import { STUDIO_SKILLS, type StudioSkill } from "./skills";

export function resolveStudioSkills(
  actions: readonly SkillActionDefinition[],
): StudioSkill[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return STUDIO_SKILLS.map((slot) => {
    if (!slot.actionId) return { ...slot };
    const action = byId.get(slot.actionId);
    if (action?.available) {
      return {
        ...slot,
        label: action.label || slot.label,
        unavailableReason: undefined,
      };
    }
    return {
      ...slot,
      actionId: undefined,
      unavailableReason:
        action?.unavailable_reason ??
        `${slot.label} is not installed or available in this session.`,
    };
  });
}
