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
  /** Set when the scaffold turn failed or the artifact never landed.
   *  Mirrors `SiteProject.scaffoldError`: lets the SlidesChat UI surface
   *  a retry prompt and keeps `scaffolded` honest about the actual
   *  on-disk state. */
  scaffoldError?: string;
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
  /** Legacy: previously linked back to a `StudioProject` for slides
   *  generated from the deprecated Studio feature. The Studio feature
   *  was removed in M9-β-2 along with the `studio/*` route stub; these
   *  fields are kept on the type to avoid breaking older
   *  localStorage-persisted slides records, but are no longer
   *  populated by any code path. Safe to drop in a future schema
   *  migration. */
  studioProjectId?: string;
  studioOutputId?: string;
}
