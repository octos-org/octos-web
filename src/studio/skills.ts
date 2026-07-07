/**
 * Studio skills registry — prepared-prompt actions rendered as tiles
 * in the right-hand Studio rail. Plain .ts module (no components) so
 * react-refresh/only-export-components stays satisfied.
 */

import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Code2,
  Languages,
  Presentation,
  Telescope,
  Workflow,
} from "lucide-react";

export interface StudioSkill {
  id: string;
  label: string;
  icon: LucideIcon;
  prompt: string;
  /** Tile is disabled until at least one source is selected. */
  requiresSources?: boolean;
}

/** The Stitch design's six tiles, in its order. */
export const STUDIO_SKILLS: StudioSkill[] = [
  {
    id: "deep-research",
    label: "Deep Research",
    icon: Telescope,
    prompt:
      "Run a deep, structured research pass on this project's topic. Use any attached sources as primary grounding and cite what you used.",
  },
  {
    id: "generate-slides",
    label: "Generate Slides",
    icon: Presentation,
    prompt:
      "Draft a slide-deck outline (titles + bullet notes per slide) for this project, grounded in any attached sources. Ask before expanding to a full deck.",
  },
  {
    id: "workflow",
    label: "Workflow",
    icon: Workflow,
    prompt:
      "Lay out a concrete step-by-step workflow for this project: stages, deliverables per stage, and the immediate next action.",
  },
  {
    id: "code",
    label: "Code Assistant",
    icon: Code2,
    prompt:
      "Act as the coding copilot for this project. Inspect the sources if attached and propose the next concrete implementation step.",
  },
  {
    id: "data-viz",
    label: "Data Viz",
    icon: BarChart3,
    prompt:
      "Propose and produce the most insightful visualization(s) of the attached data sources. Explain what the chart shows.",
    requiresSources: true,
  },
  {
    id: "translate",
    label: "Language Translate",
    icon: Languages,
    prompt:
      "Translate the attached sources into English (or into Chinese if they are already English), preserving structure.",
    requiresSources: true,
  },
];
