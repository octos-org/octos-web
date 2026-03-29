import type { SlideLayout } from "./types";

export const TEMPLATES = [
  { value: "business", label: "Business / Professional", color: "text-blue-400" },
  { value: "academic", label: "Academic / Research", color: "text-purple-400" },
  { value: "creative", label: "Creative / Storytelling", color: "text-pink-400" },
  { value: "minimal", label: "Minimal / Clean", color: "text-gray-400" },
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
  business: "bg-blue-500/20 text-blue-400",
  academic: "bg-purple-500/20 text-purple-400",
  creative: "bg-pink-500/20 text-pink-400",
  minimal: "bg-gray-500/20 text-gray-400",
};
