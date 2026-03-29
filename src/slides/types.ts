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
  /** PNG preview URL (/api/files/{path}?token=) */
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
  /** Dedicated agent session for this deck */
  chatSessionId: string;
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
  /** Links back to StudioProject if created from studio */
  studioProjectId?: string;
  studioOutputId?: string;
}
