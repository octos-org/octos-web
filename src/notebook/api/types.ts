// Notebook data types

export interface Notebook {
  id: string;
  title: string;
  description: string;
  cover_image?: string;
  source_count: number;
  note_count: number;
  created_at: string;
  updated_at: string;
}

export interface Source {
  id: string;
  notebook_id: string;
  type: "pdf" | "url" | "text" | "docx" | "pptx" | "image";
  filename: string;
  status: "uploading" | "parsing" | "indexing" | "ready" | "error";
  error_message?: string;
  chunk_count: number;
  created_at: string;
}

export interface SourceChunk {
  id: string;
  source_id: string;
  content: string;
  start_offset: number;
  end_offset: number;
}

export interface Note {
  id: string;
  notebook_id: string;
  content: string;
  source_refs: string[];
  created_from: "manual" | "chat_reply";
  created_at: string;
  updated_at: string;
}

export interface StudioOutput {
  id: string;
  notebook_id: string;
  type: "slides" | "quiz" | "flashcards" | "mindmap" | "audio" | "infographic" | "comic" | "report" | "research";
  status: "generating" | "done" | "error";
  file_path?: string;
  config?: Record<string, unknown>;
  created_at: string;
}
