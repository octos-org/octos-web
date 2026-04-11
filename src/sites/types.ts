export type SitePreset = "learning" | "astro" | "nextjs" | "react";

export interface SitePresetDefinition {
  label: string;
  template: string;
  siteKind: string;
  title: string;
  description: string;
  slug: string;
}

export const SITE_PRESETS: Record<SitePreset, SitePresetDefinition> = {
  learning: {
    label: "Learning",
    template: "quarto-lesson",
    siteKind: "course",
    title: "Physics Learning Studio",
    description: "Lesson-first math and physics site scaffold.",
    slug: "physics-learning-studio",
  },
  astro: {
    label: "Astro",
    template: "astro-site",
    siteKind: "docs",
    title: "Signal Atlas",
    description: "Structured content and documentation site scaffold.",
    slug: "signal-atlas",
  },
  nextjs: {
    label: "Next.js",
    template: "nextjs-app",
    siteKind: "product",
    title: "Vision Forum",
    description: "App-like landing and product shell scaffold.",
    slug: "vision-forum",
  },
  react: {
    label: "React",
    template: "react-vite",
    siteKind: "tool",
    title: "React Lab",
    description: "Lean prototype and UI experiment scaffold.",
    slug: "react-lab",
  },
};

export interface SiteProject {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  profileId?: string;
  preset: SitePreset;
  template: string;
  siteKind: string;
  slug: string;
  scaffolded?: boolean;
  previewUrl?: string;
  scaffoldError?: string;
}
