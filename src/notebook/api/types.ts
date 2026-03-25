// Notebook data types — matching Octos backend responses

export interface Notebook {
  id: string;
  title: string;
  description: string;
  cover_image?: string;
  source_count: number;
  note_count: number;
  sources: Source[];
  notes: Note[];
  shared_with: Share[];
  copyright_protected: boolean;
  book_meta?: BookMeta;
  created_at: string;
  updated_at: string;
  owner_id: string;
}

export interface Source {
  id: string;
  notebook_id: string;
  source_type: "pdf" | "url" | "text" | "docx" | "pptx" | "image";
  filename: string;
  status: "uploading" | "parsing" | "indexing" | "ready" | "error";
  error_message?: string;
  chunks: SourceChunk[];
  created_at: string;
}

export interface SourceChunk {
  id: string;
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

export interface Share {
  id: string;
  email: string;
  role: "viewer" | "editor";
  created_at: string;
}

export interface BookMeta {
  isbn?: string;
  marc_id?: string;
  classification?: string;
  author?: string;
  publisher?: string;
  publish_year?: number;
  subject?: string;
  cover_url?: string;
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
