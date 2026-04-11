// Mofa Slides types

export type SlideLayout =
  | "title"
  | "content"
  | "two-column"
  | "image-full"
  | "agenda"
  | "conclusion";

export interface Slide {
  index: number;
  title: string;
  notes: string;
  /** Server file path for the PNG preview image. */
  thumbnailUrl?: string;
  layout: SlideLayout;
}

export interface SlideVersion {
  commitSha: string;
  message: string;
  timestamp: number;
}

export interface SlidesProject {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** True once the backend `/new slides ...` scaffold has been created. */
  scaffolded?: boolean;
  /** Backend directory slug under `slides/`. */
  slug?: string;
  slides: Slide[];
  /** Server path to current PPTX */
  pptxPath?: string;
  /** Download URL for PPTX */
  pptxUrl?: string;
  /** Template style */
  template: string;
  /** Auto-generated tags for CMS (template, topic, date) */
  tags: string[];
  category?: string;
  /** Server path to git repo */
  gitRepoPath?: string;
  currentCommit?: string;
  versions: SlideVersion[];
  /** Manifest generatedAt — used to detect content changes when file paths stay the same */
  manifestGeneratedAt?: string;
  /** Links back to StudioProject if created from studio */
  studioProjectId?: string;
  studioOutputId?: string;
}
