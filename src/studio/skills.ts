/**
 * Studio skills registry — NotebookLM-style manifest actions rendered as
 * tiles in the Studio rail. Plain .ts module (no components) so
 * react-refresh/only-export-components stays satisfied.
 */

import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  ChartNetwork,
  FileQuestion,
  FileText,
  Image,
  Layers,
  Presentation,
  Table,
  Video,
} from "lucide-react";

export interface StudioSkill {
  id: string;
  label: string;
  icon: LucideIcon;
  actionId?: string;
  badge?: string;
  /** Tile is disabled until at least one source is selected. */
  requiresSources?: boolean;
  unavailableReason?: string;
}

/** NotebookLM-style Studio actions, mapped to manifest-declared skill actions. */
export const STUDIO_SKILLS: StudioSkill[] = [
  {
    id: "audio-overview",
    label: "Audio Overview",
    icon: AudioLines,
    requiresSources: true,
    unavailableReason: "Audio Overview needs a notebook-aware action manifest.",
  },
  {
    id: "slide-deck",
    label: "Slide Deck",
    icon: Presentation,
    badge: "BETA",
    requiresSources: true,
    unavailableReason: "Slide Deck needs a notebook-aware action manifest.",
  },
  {
    id: "video-overview",
    label: "Video Overview",
    icon: Video,
    actionId: "video_overview.generate",
    requiresSources: true,
  },
  {
    id: "mind-map",
    label: "Mind Map",
    icon: ChartNetwork,
    actionId: "mindmap.generate",
    requiresSources: true,
  },
  {
    id: "reports",
    label: "Reports",
    icon: FileText,
    actionId: "reports.generate",
    requiresSources: true,
  },
  {
    id: "flashcards",
    label: "Flashcards",
    icon: Layers,
    actionId: "flashcards.generate",
    requiresSources: true,
  },
  {
    id: "quiz",
    label: "Quiz",
    icon: FileQuestion,
    actionId: "quiz.generate",
    requiresSources: true,
  },
  {
    id: "infographic",
    label: "Infographic",
    icon: Image,
    badge: "BETA",
    requiresSources: true,
    unavailableReason: "Infographic needs a notebook-aware action manifest.",
  },
  {
    id: "data-table",
    label: "Data Table",
    icon: Table,
    actionId: "data_table.generate",
    requiresSources: true,
  },
];

export const STUDIO_SKILL_ACTION_IDS = new Set(
  STUDIO_SKILLS.map((skill) => skill.actionId).filter(
    (actionId): actionId is string => Boolean(actionId),
  ),
);

export const STUDIO_SKILL_LABEL_BY_ACTION_ID = new Map(
  STUDIO_SKILLS.flatMap((skill) =>
    skill.actionId ? [[skill.actionId, skill.label] as const] : [],
  ),
);
