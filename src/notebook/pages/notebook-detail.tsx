import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, FileText, MessageSquare, StickyNote, Wand2,
  Upload, Plus, Trash2, Link, Type, File, Image, Globe, Check,
  BookmarkPlus, Edit3, X, Send,
} from "lucide-react";
import { listNotebooks } from "../api/notebooks";
import { listSources, addSource, deleteSource } from "../api/sources";
import { listNotes, createNote, updateNote, deleteNote } from "../api/notes";
import type { Notebook, Source, Note } from "../api/types";

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

// ─── Sources Panel ──────────────────────────────────────────

function SourcesPanel({ notebookId }: { notebookId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [adding, setAdding] = useState<"file" | "url" | "text" | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setSources(await listSources(notebookId));
  }, [notebookId]);

  useEffect(() => { load(); }, [load]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      const type = ({ pdf: "pdf", docx: "docx", pptx: "pptx", png: "image", jpg: "image", jpeg: "image" } as Record<string, Source["type"]>)[ext] || "text";
      await addSource(notebookId, { type, filename: f.name });
    }
    setAdding(null);
    load();
  };

  const handleUrlAdd = async () => {
    if (!urlInput.trim()) return;
    await addSource(notebookId, { type: "url", filename: urlInput.trim() });
    setUrlInput("");
    setAdding(null);
    load();
  };

  const handleTextAdd = async () => {
    if (!textInput.trim()) return;
    await addSource(notebookId, { type: "text", filename: textTitle.trim() || "Pasted text", content: textInput });
    setTextInput("");
    setTextTitle("");
    setAdding(null);
    load();
  };

  const handleDelete = async (sourceId: string) => {
    await deleteSource(notebookId, sourceId);
    load();
  };

  const typeIcon: Record<Source["type"], React.ReactNode> = {
    pdf: <File size={16} className="text-red-400" />,
    docx: <FileText size={16} className="text-blue-400" />,
    pptx: <FileText size={16} className="text-orange-400" />,
    url: <Globe size={16} className="text-green-400" />,
    text: <Type size={16} className="text-gray-400" />,
    image: <Image size={16} className="text-purple-400" />,
  };

  return (
    <div className="flex h-full flex-col p-4">
      {/* Add source buttons */}
      <div className="mb-4 flex gap-2">
        <button onClick={() => { setAdding("file"); setTimeout(() => fileRef.current?.click(), 100); }}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text hover:border-accent/50 transition">
          <Upload size={14} /> Upload File
        </button>
        <button onClick={() => setAdding("url")}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text hover:border-accent/50 transition">
          <Link size={14} /> Add URL
        </button>
        <button onClick={() => setAdding("text")}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text hover:border-accent/50 transition">
          <Type size={14} /> Paste Text
        </button>
        <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.pptx,.txt,.md,.png,.jpg,.jpeg" className="hidden" onChange={handleFileUpload} />
      </div>

      {/* URL input */}
      {adding === "url" && (
        <div className="mb-4 flex gap-2">
          <input autoFocus value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleUrlAdd(); if (e.key === "Escape") setAdding(null); }}
            placeholder="https://..." className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none" />
          <button onClick={handleUrlAdd} className="rounded-lg bg-accent px-3 py-2 text-sm text-white">Add</button>
          <button onClick={() => setAdding(null)} className="rounded-lg px-2 text-muted hover:text-text"><X size={16} /></button>
        </div>
      )}

      {/* Text input */}
      {adding === "text" && (
        <div className="mb-4 space-y-2">
          <input autoFocus value={textTitle} onChange={(e) => setTextTitle(e.target.value)}
            placeholder="Title (optional)" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none" />
          <textarea value={textInput} onChange={(e) => setTextInput(e.target.value)} rows={4}
            placeholder="Paste text content..." className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none resize-none" />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setAdding(null)} className="text-sm text-muted hover:text-text">Cancel</button>
            <button onClick={handleTextAdd} className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white">Add</button>
          </div>
        </div>
      )}

      {/* Source list */}
      <div className="flex-1 overflow-y-auto space-y-1">
        {sources.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center text-muted">
            <Upload size={36} className="mb-3 opacity-30" />
            <p>No sources yet</p>
            <p className="text-xs">Upload PDFs, paste URLs, or add text</p>
          </div>
        ) : (
          sources.map((s) => (
            <div key={s.id} className="group flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 hover:border-accent/30 transition">
              {typeIcon[s.type]}
              <span className="flex-1 truncate text-sm text-text">{s.filename}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${s.status === "ready" ? "bg-green-500/10 text-green-400" : s.status === "error" ? "bg-red-500/10 text-red-400" : "bg-yellow-500/10 text-yellow-400"}`}>
                {s.status}
              </span>
              <button onClick={() => handleDelete(s.id)}
                className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity">
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Chat Panel ─────────────────────────────────────────────

function ChatPanel({ notebookId }: { notebookId: string }) {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      // Use the existing chat API (will be replaced with notebook-specific RAG API)
      const token = localStorage.getItem("octos_session_token") || localStorage.getItem("octos_auth_token");
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message: userMsg, session_id: `notebook-${notebookId}` }),
      });
      const data = await resp.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.content || "No response" }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err}` }]);
    } finally {
      setLoading(false);
    }
  };

  if (messages.length === 0 && !loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex-1 flex flex-col items-center justify-center text-muted">
          <MessageSquare size={48} className="mb-4 opacity-30" />
          <p className="text-lg">Chat with your sources</p>
          <p className="mb-4 text-sm">Ask questions about the documents in this notebook</p>
        </div>
        <div className="border-t border-border p-4">
          <div className="flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Ask about your sources..." className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none" />
            <button onClick={handleSend} disabled={!input.trim() || loading}
              className="rounded-lg bg-accent px-3 py-2 text-white disabled:opacity-50"><Send size={16} /></button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
              m.role === "user"
                ? "bg-accent text-white"
                : "bg-surface-light text-text"
            }`}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-xl bg-surface-light px-4 py-2.5 text-sm text-muted animate-pulse">Thinking...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask about your sources..." className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none" />
          <button onClick={handleSend} disabled={!input.trim() || loading}
            className="rounded-lg bg-accent px-3 py-2 text-white disabled:opacity-50"><Send size={16} /></button>
        </div>
      </div>
    </div>
  );
}

// ─── Notes Panel ────────────────────────────────────────────

function NotesPanel({ notebookId }: { notebookId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [creating, setCreating] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    setNotes(await listNotes(notebookId));
  }, [notebookId]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newContent.trim()) return;
    await createNote(notebookId, { content: newContent.trim(), created_from: "manual" });
    setNewContent("");
    setCreating(false);
    load();
  };

  const handleUpdate = async (noteId: string) => {
    await updateNote(noteId, editContent);
    setEditingId(null);
    load();
  };

  const handleDelete = async (noteId: string) => {
    await deleteNote(noteId);
    load();
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-text-strong">{notes.length} Notes</h2>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 transition">
          <Plus size={14} /> New Note
        </button>
      </div>

      {creating && (
        <div className="mb-4 rounded-lg border border-accent/30 bg-surface-light p-3">
          <textarea autoFocus rows={3} value={newContent} onChange={(e) => setNewContent(e.target.value)}
            placeholder="Write a note..." className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none resize-none" />
          <div className="mt-2 flex gap-2 justify-end">
            <button onClick={() => setCreating(false)} className="text-sm text-muted">Cancel</button>
            <button onClick={handleCreate} className="rounded bg-accent px-3 py-1 text-sm text-white">Save</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {notes.length === 0 && !creating ? (
          <div className="flex h-48 flex-col items-center justify-center text-muted">
            <StickyNote size={36} className="mb-3 opacity-30" />
            <p>No notes yet</p>
            <p className="text-xs">Create notes or save chat replies</p>
          </div>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="group rounded-lg border border-border bg-surface p-3">
              {editingId === n.id ? (
                <>
                  <textarea rows={3} value={editContent} onChange={(e) => setEditContent(e.target.value)}
                    className="w-full rounded border border-border bg-surface-light px-2 py-1 text-sm text-text focus:border-accent focus:outline-none resize-none" />
                  <div className="mt-2 flex gap-2 justify-end">
                    <button onClick={() => setEditingId(null)} className="text-xs text-muted">Cancel</button>
                    <button onClick={() => handleUpdate(n.id)} className="rounded bg-accent px-2 py-0.5 text-xs text-white">Save</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-text whitespace-pre-wrap">{n.content}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-muted">{new Date(n.created_at).toLocaleDateString()}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => { setEditingId(n.id); setEditContent(n.content); }}
                        className="rounded p-1 text-muted hover:text-accent"><Edit3 size={12} /></button>
                      <button onClick={() => handleDelete(n.id)}
                        className="rounded p-1 text-muted hover:text-red-400"><Trash2 size={12} /></button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Studio Panel ───────────────────────────────────────────

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
