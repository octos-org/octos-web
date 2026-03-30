import { useState, useRef, useCallback } from "react";
import { useStudio } from "../context/studio-context";
import {
  FileText,
  Globe,
  Type,
  Upload,
  Trash2,
  CheckSquare,
  Square,
} from "lucide-react";
import { uploadFiles } from "@/api/chat";

type AddMode = null | "upload" | "url" | "text";

export function SourcePanel() {
  const { project, addSource, removeSource, toggleSource, selectAllSources } =
    useStudio();
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [urlInput, setUrlInput] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sources = project?.sources ?? [];
  const allSelected = sources.length > 0 && sources.every((s) => s.selected);

  const handleUpload = useCallback(
    async (files: FileList) => {
      setUploading(true);
      try {
        const paths = await uploadFiles(Array.from(files));
        for (let i = 0; i < files.length; i++) {
          addSource({
            type: "upload",
            title: files[i].name,
            serverPath: paths[i],
            meta: { size: files[i].size },
          });
        }
      } catch {
        // upload failed
      } finally {
        setUploading(false);
        setAddMode(null);
      }
    },
    [addSource],
  );

  const handleAddUrl = useCallback(() => {
    if (!urlInput.trim()) return;
    addSource({ type: "url", title: urlInput.trim(), url: urlInput.trim() });
    setUrlInput("");
    setAddMode(null);
  }, [urlInput, addSource]);

  const handleAddText = useCallback(() => {
    if (!textContent.trim()) return;
    addSource({
      type: "text",
      title: textTitle.trim() || "Pasted text",
      text: textContent.trim(),
    });
    setTextTitle("");
    setTextContent("");
    setAddMode(null);
  }, [textTitle, textContent, addSource]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-medium text-text-strong">Sources</h2>
        {sources.length > 0 && (
          <button
            onClick={() => selectAllSources(!allSelected)}
            className="text-xs text-muted hover:text-text"
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        )}
      </div>

      {/* Source list */}
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {sources.length === 0 && addMode === null && (
          <div className="flex flex-col items-center py-8 text-center">
            <FileText size={24} className="mb-2 text-muted/40" />
            <p className="text-xs text-muted/60">No sources yet</p>
            <p className="mt-1 text-[10px] text-muted/40">Add files, URLs, or paste text</p>
          </div>
        )}

        {sources.map((s) => {
          const Icon = s.type === "url" ? Globe : s.type === "text" ? Type : FileText;
          return (
            <div
              key={s.id}
              className="group mb-1 flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-surface-container"
            >
              <button onClick={() => toggleSource(s.id)} className="shrink-0 text-muted">
                {s.selected ? (
                  <CheckSquare size={16} className="text-accent" />
                ) : (
                  <Square size={16} />
                )}
              </button>
              <Icon size={14} className="shrink-0 text-muted/60" />
              <span className="flex-1 truncate text-xs text-text">{s.title}</span>
              <button
                onClick={() => removeSource(s.id)}
                className="shrink-0 rounded-lg p-1 text-muted opacity-0 hover:text-red-400 group-hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}

        {/* Add source inline forms */}
        {addMode === "url" && (
          <div className="mt-2 rounded-xl bg-surface-container p-3">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddUrl()}
              placeholder="https://example.com"
              className="w-full rounded-lg bg-surface px-3 py-2 text-xs text-text placeholder-muted/50 outline-none"
              autoFocus
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                onClick={() => setAddMode(null)}
                className="rounded-lg px-2.5 py-1 text-xs text-muted hover:bg-surface"
              >
                Cancel
              </button>
              <button
                onClick={handleAddUrl}
                disabled={!urlInput.trim()}
                className="rounded-lg bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-dim disabled:opacity-30"
              >
                Add
              </button>
            </div>
          </div>
        )}

        {addMode === "text" && (
          <div className="mt-2 rounded-xl bg-surface-container p-3">
            <input
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
              placeholder="Title (optional)"
              className="mb-2 w-full rounded-lg bg-surface px-3 py-2 text-xs text-text placeholder-muted/50 outline-none"
              autoFocus
            />
            <textarea
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="Paste your text here..."
              rows={4}
              className="w-full rounded-lg bg-surface px-3 py-2 text-xs text-text placeholder-muted/50 outline-none resize-none"
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                onClick={() => setAddMode(null)}
                className="rounded-lg px-2.5 py-1 text-xs text-muted hover:bg-surface"
              >
                Cancel
              </button>
              <button
                onClick={handleAddText}
                disabled={!textContent.trim()}
                className="rounded-lg bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-dim disabled:opacity-30"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add source buttons */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleUpload(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="flex gap-1.5 px-3 pb-3">
        <button
          onClick={() => {
            setAddMode(null);
            fileInputRef.current?.click();
          }}
          disabled={uploading}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-container py-2.5 text-xs text-text hover:bg-surface-elevated disabled:opacity-50"
        >
          {uploading ? (
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text border-t-transparent" />
          ) : (
            <Upload size={14} />
          )}
          File
        </button>
        <button
          onClick={() => setAddMode(addMode === "url" ? null : "url")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs ${
            addMode === "url"
              ? "bg-accent-container text-accent"
              : "bg-surface-container text-text hover:bg-surface-elevated"
          }`}
        >
          <Globe size={14} />
          URL
        </button>
        <button
          onClick={() => setAddMode(addMode === "text" ? null : "text")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs ${
            addMode === "text"
              ? "bg-accent-container text-accent"
              : "bg-surface-container text-text hover:bg-surface-elevated"
          }`}
        >
          <Type size={14} />
          Text
        </button>
      </div>
    </div>
  );
}
