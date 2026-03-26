import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, BookOpen, Trash2, Search, FileText, Clock, Layout } from "lucide-react";
import { listNotebooks, createNotebook, deleteNotebook } from "../api/notebooks";
import type { Notebook } from "../api/types";

export function NotebookListPage() {
  const navigate = useNavigate();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(async () => {
    const list = await listNotebooks();
    setNotebooks(list);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    const nb = await createNotebook(newTitle.trim());
    setNewTitle("");
    setCreating(false);
    navigate(`/notebooks/${nb.id}`);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteNotebook(id);
    load();
  };

  const filtered = notebooks.filter(
    (n) =>
      n.title.toLowerCase().includes(search.toLowerCase()) ||
      n.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-text-strong">MoFa 笔记本</h1>
          <p className="text-sm text-muted">上传资料，与 AI 对话，一键生成课件</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition"
        >
          <Plus size={16} />
          新建笔记本
        </button>
      </div>

      {/* Search */}
      <div className="px-6 py-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="搜索笔记本..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface py-2 pl-10 pr-4 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Create dialog */}
      {creating && (
        <div className="mx-6 mb-3 rounded-lg border border-accent/30 bg-surface-light p-4">
          <input
            autoFocus
            type="text"
            placeholder="笔记本标题..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") setCreating(false);
            }}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex gap-2 justify-end">
            <button
              onClick={() => setCreating(false)}
              className="rounded px-3 py-1 text-sm text-muted hover:text-text"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim()}
              className="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
            >
              创建
            </button>
          </div>
        </div>
      )}

      {/* Templates (Issue #41) */}
      <TemplateSection onUseTemplate={async (title) => {
        const nb = await createNotebook(title);
        navigate(`/notebooks/${nb.id}`);
      }} />

      {/* Notebook grid */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center text-muted">
            <BookOpen size={48} className="mb-4 opacity-30" />
            <p className="text-lg">
              {notebooks.length === 0
                ? "暂无笔记本"
                : "未找到匹配的笔记本"}
            </p>
            <p className="text-sm">
              {notebooks.length === 0
                ? "创建你的第一个笔记本"
                : "试试其他搜索词"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((nb) => (
              <div
                key={nb.id}
                onClick={() => navigate(`/notebooks/${nb.id}`)}
                className="group cursor-pointer rounded-xl border border-border bg-surface p-4 transition hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5"
              >
                {/* Cover */}
                <div className="mb-3 flex h-24 items-center justify-center rounded-lg bg-surface-light">
                  <BookOpen size={32} className="text-muted/30" />
                </div>

                {/* Title */}
                <h3 className="mb-1 truncate font-medium text-text-strong group-hover:text-accent transition">
                  {nb.title}
                </h3>

                {/* Description */}
                {nb.description && (
                  <p className="mb-2 line-clamp-2 text-xs text-muted">
                    {nb.description}
                  </p>
                )}

                {/* Meta */}
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <FileText size={12} />
                    {nb.source_count} 个来源
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {new Date(nb.updated_at).toLocaleDateString()}
                  </span>
                </div>

                {/* Delete */}
                <button
                  onClick={(e) => handleDelete(e, nb.id)}
                  className="absolute right-3 top-3 rounded p-1 text-muted opacity-0 hover:bg-red-600/20 hover:text-red-400 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Templates (Issue #41) ──────────────────────────────────

const TEMPLATES = [
  { title: "物理入门模板", description: "涵盖力学、热力学和光学的物理入门课程笔记模板。", sourceCount: 12 },
  { title: "文献综述模板", description: "包含摘要、分析和综合部分的学术文献综述结构化模板。", sourceCount: 8 },
  { title: "实验报告模板", description: "包含假设、方法、结果和结论的标准实验报告格式。", sourceCount: 5 },
  { title: "历史时间线模板", description: "按时间线组织的学习模板，包含关键事件、人物和主题联系。", sourceCount: 15 },
];

function TemplateSection({ onUseTemplate }: { onUseTemplate: (title: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="px-6 pb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="mb-2 flex items-center gap-2 text-sm font-medium text-muted hover:text-text transition"
      >
        <Layout size={14} />
        模板
        <span className="text-xs">({TEMPLATES.length})</span>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATES.map((t) => (
            <div key={t.title} className="rounded-xl border border-border bg-surface p-4 transition hover:border-accent/50">
              <div className="mb-2 flex h-12 items-center justify-center rounded-lg bg-accent/10">
                <Layout size={20} className="text-accent/50" />
              </div>
              <h4 className="mb-1 text-sm font-medium text-text-strong">{t.title}</h4>
              <p className="mb-2 text-xs text-muted line-clamp-2">{t.description}</p>
              <div className="mb-3 text-xs text-muted">
                <FileText size={12} className="mr-1 inline" />
                {t.sourceCount} 个来源
              </div>
              <button
                onClick={() => onUseTemplate(t.title)}
                className="w-full rounded-lg border border-accent/30 px-3 py-1.5 text-sm text-accent hover:bg-accent/10 transition"
              >
                使用模板
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
