// Content Studio types

export interface StudioProject {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Backend session ID for this project's agent chat */
  chatSessionId: string;
  sources: StudioSource[];
  outputs: StudioOutput[];
  /** Set when forked from a chat research session */
  forkedFrom?: {
    sessionId: string;
    researchTitle: string;
  };
}

export interface StudioSource {
  id: string;
  type: "upload" | "research" | "url" | "text";
  title: string;
  addedAt: number;
  /** Server-side file path (for uploads) */
  serverPath?: string;
  /** URL to crawl */
  url?: string;
  /** Inline content (research markdown, crawled text) */
  content?: string;
  /** Inline text (user-pasted) */
  text?: string;
  /** Whether this source is selected for generation */
  selected: boolean;
  meta?: Record<string, string | number>;
}

export type OutputType =
  | "summary"
  | "report"
  | "podcast"
  | "slides"
  | "infographic"
  | "comic"
  | "website";

export type OutputStatus = "pending" | "generating" | "complete" | "error";

export interface StudioOutput {
  id: string;
  type: OutputType;
  title: string;
  createdAt: number;
  status: OutputStatus;
  /** Separate session ID for this generation run */
  generationSessionId: string;
  fileUrl?: string;
  filePath?: string;
  filename?: string;
  /** Preview text or summary */
  preview?: string;
  error?: string;
  options?: GenerationOptions;
}

export interface GenerationOptions {
  style?: string;
  length?: "short" | "medium" | "long";
  language?: string;
  voice?: string;
  format?: string;
  template?: string;
  depth?: number;
  [key: string]: unknown;
}
