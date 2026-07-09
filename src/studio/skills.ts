/**
 * Studio skills registry — NotebookLM-style prepared-prompt actions rendered
 * as tiles in the Studio rail. Plain .ts module (no components) so
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
  prompt: string;
  badge?: string;
  /** Tile is disabled until at least one source is selected. */
  requiresSources?: boolean;
}

const NOTEBOOK_SOURCE_SCOPE =
  "Use the current Octos Studio project's imported notebook sources as grounding. If the runtime exposes selected source IDs, limit the request to those selected sources; otherwise use all imported notebook sources. Do not ask the user to upload attachments in the chat composer.";

function notebookPrompt(body: string): string {
  return `${NOTEBOOK_SOURCE_SCOPE}\n\n${body}\n\nAfter the skill finishes, summarize the generated artifact paths and mention any source-grounding limitations.`;
}

/** NotebookLM-style Studio actions, mapped to the installed local skills. */
export const STUDIO_SKILLS: StudioSkill[] = [
  {
    id: "audio-overview",
    label: "Audio Overview",
    icon: AudioLines,
    prompt: notebookPrompt(
      [
        "Create a NotebookLM-style spoken audio overview from the notebook sources.",
        "Use source_search/source_lookup from mofa-notebook-grounding when you need exact grounded excerpts.",
        "Then use the installed mofa-podcast skill and call podcast_generate to render the final multi-speaker audio.",
        "Keep the script concise, conversational, and source-grounded.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "slide-deck",
    label: "Slide Deck",
    icon: Presentation,
    badge: "BETA",
    prompt: notebookPrompt(
      [
        "Create a source-grounded slide deck from the notebook sources.",
        "Use the installed mofa-slides skill; call mofa_list_styles before choosing a style, then call mofa_slides to generate a PPTX.",
        "Prefer an editable, concise deck with clear citations or source notes where useful.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "video-overview",
    label: "Video Overview",
    icon: Video,
    prompt: notebookPrompt(
      [
        "Create a NotebookLM-style video overview from the notebook sources.",
        "Use the installed mofa-notebook-video-overview skill and call video_overview_generate.",
        "Use the default video rendering behavior unless quota or credentials are unavailable; if rendering cannot run, produce the grounded script and scene plan artifacts.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "mind-map",
    label: "Mind Map",
    icon: ChartNetwork,
    prompt: notebookPrompt(
      [
        "Generate a source-grounded mind map from the notebook sources.",
        "Use the installed mofa-notebook-mindmap skill and call mindmap_generate.",
        "Choose a clear focus automatically from the project title and selected sources unless the user has already provided one.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "reports",
    label: "Reports",
    icon: FileText,
    prompt: notebookPrompt(
      [
        "Generate a source-grounded report or study guide from the notebook sources.",
        "Use the installed mofa-notebook-study skill and call study_guide_generate.",
        "Structure the output as a concise report with headings, key findings, and citations to source chunks.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "flashcards",
    label: "Flashcards",
    icon: Layers,
    prompt: notebookPrompt(
      [
        "Generate source-grounded flashcards from the notebook sources.",
        "Use the installed mofa-notebook-study skill and call flashcards_generate.",
        "Prefer compact question/answer cards that are useful for review and cite the supporting source chunks.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "quiz",
    label: "Quiz",
    icon: FileQuestion,
    prompt: notebookPrompt(
      [
        "Generate a source-grounded quiz from the notebook sources.",
        "Use the installed mofa-notebook-study skill and call quiz_generate.",
        "Include answer keys and cite the source chunks used to support each answer.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "infographic",
    label: "Infographic",
    icon: Image,
    badge: "BETA",
    prompt: notebookPrompt(
      [
        "Create a visual infographic from the notebook sources.",
        "First synthesize the key points from the sources, then use the installed mofa-infographic skill and call mofa_infographic.",
        "Use a relative output path and keep the visual structure concise enough for a single infographic artifact.",
      ].join(" "),
    ),
    requiresSources: true,
  },
  {
    id: "data-table",
    label: "Data Table",
    icon: Table,
    prompt: notebookPrompt(
      [
        "Generate a cited comparison table or structured dataset from the notebook sources.",
        "Use the installed mofa-notebook-data-table skill and call data_table_generate.",
        "Let the skill validate cell-level citations and export the JSON, Markdown, CSV table, and citation CSV artifacts.",
      ].join(" "),
    ),
    requiresSources: true,
  },
];
