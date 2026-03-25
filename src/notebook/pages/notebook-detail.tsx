import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, FileText, MessageSquare, StickyNote, Wand2, Upload, Plus } from "lucide-react";
import { listNotebooks } from "../api/notebooks";
import type { Notebook } from "../api/types";

type Tab = "sources" | "chat" | "notes" | "studio";

export function NotebookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chat");

  useEffect(() => {
    listNotebooks().then((nbs) => {
      const nb = nbs.find((n) => n.id === id);
      if (nb) setNotebook(nb);
      else navigate("/notebooks");
    });
  }, [id, navigate]);

  if (!notebook) return null;

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "sources", label: "Sources", icon: <FileText size={16} /> },
    { key: "chat", label: "Chat", icon: <MessageSquare size={16} /> },
    { key: "notes", label: "Notes", icon: <StickyNote size={16} /> },
    { key: "studio", label: "Studio", icon: <Wand2 size={16} /> },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={() => navigate("/notebooks")}
          className="rounded-lg p-1.5 text-muted hover:bg-surface-light hover:text-text transition"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-semibold text-text-strong">{notebook.title}</h1>

        {/* Tabs */}
        <div className="ml-auto flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                activeTab === t.key
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-surface-light hover:text-text"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "sources" && <SourcesPanel notebookId={notebook.id} />}
        {activeTab === "chat" && <ChatPanel notebookId={notebook.id} />}
        {activeTab === "notes" && <NotesPanel notebookId={notebook.id} />}
        {activeTab === "studio" && <StudioPanel notebookId={notebook.id} />}
      </div>
    </div>
  );
}

// --- Placeholder panels (will be implemented in subsequent milestones) ---

function SourcesPanel({ notebookId }: { notebookId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted">
      <Upload size={48} className="mb-4 opacity-30" />
      <p className="text-lg">No sources yet</p>
      <p className="mb-4 text-sm">Upload PDFs, paste URLs, or add text to get started</p>
      <button className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 transition">
        <Plus size={16} />
        Add Source
      </button>
    </div>
  );
}

function ChatPanel({ notebookId }: { notebookId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted">
      <MessageSquare size={48} className="mb-4 opacity-30" />
      <p className="text-lg">Chat with your sources</p>
      <p className="text-sm">Add sources first, then ask questions about them</p>
    </div>
  );
}

function NotesPanel({ notebookId }: { notebookId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted">
      <StickyNote size={48} className="mb-4 opacity-30" />
      <p className="text-lg">No notes yet</p>
      <p className="text-sm">Save chat replies or create notes manually</p>
    </div>
  );
}

function StudioPanel({ notebookId }: { notebookId: string }) {
  const outputs = [
    { key: "slides", label: "Slides", emoji: "📊", desc: "Generate PPT courseware" },
    { key: "quiz", label: "Quiz", emoji: "❓", desc: "Generate test questions" },
    { key: "flashcards", label: "Flashcards", emoji: "🃏", desc: "Generate study cards" },
    { key: "mindmap", label: "Mind Map", emoji: "🧠", desc: "Visualize key concepts" },
    { key: "audio", label: "Audio", emoji: "🎙️", desc: "Generate podcast overview" },
    { key: "infographic", label: "Infographic", emoji: "📈", desc: "Generate visual summary" },
    { key: "comic", label: "Comic", emoji: "💬", desc: "Explain with comics" },
    { key: "report", label: "Report", emoji: "📄", desc: "Generate Word/Excel report" },
    { key: "research", label: "Research", emoji: "🔬", desc: "Deep research from web" },
  ];

  return (
    <div className="p-6">
      <h2 className="mb-4 text-lg font-semibold text-text-strong">Studio</h2>
      <p className="mb-6 text-sm text-muted">Generate courseware and study materials from your sources</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {outputs.map((o) => (
          <button
            key={o.key}
            className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface p-4 text-center transition hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5"
          >
            <span className="text-2xl">{o.emoji}</span>
            <span className="text-sm font-medium text-text-strong">{o.label}</span>
            <span className="text-xs text-muted">{o.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
