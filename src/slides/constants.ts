import type { SlideLayout } from "./types";

export const TEMPLATES = [
  { value: "business", label: "Business / Professional", color: "text-accent" },
  { value: "academic", label: "Academic / Research", color: "text-heading-accent" },
  { value: "creative", label: "Creative / Storytelling", color: "text-link" },
  { value: "minimal", label: "Minimal / Clean", color: "text-muted" },
] as const;

export const LAYOUTS: { value: SlideLayout; label: string }[] = [
  { value: "title", label: "Title Slide" },
  { value: "content", label: "Content" },
  { value: "two-column", label: "Two Column" },
  { value: "image-full", label: "Full Image" },
  { value: "agenda", label: "Agenda" },
  { value: "conclusion", label: "Conclusion" },
];

export const SLIDE_ASPECT_RATIO = 16 / 9;

export const TEMPLATE_COLORS: Record<string, string> = {
  business: "bg-accent/12 text-accent",
  academic: "bg-heading-accent/12 text-heading-accent",
  creative: "bg-link/12 text-link",
  minimal: "bg-surface-container text-muted",
};
