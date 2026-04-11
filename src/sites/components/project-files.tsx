import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  FolderClosed,
  FolderOpen,
  Image as ImageIcon,
  RefreshCw,
  Upload,
} from "lucide-react";

import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";

import {
  inferContentCategory,
  listSiteFiles,
  siteFileToContentEntry,
  uploadSiteFiles,
  type SiteFileEntry,
} from "../api";

interface ProjectFilesProps {
  slug: string;
  title?: string;
  sessionId: string;
  profileId?: string;
  template?: string;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
  onRename?: (title: string) => void;
}

interface FolderNode {
  kind: "folder";
  key: string;
  name: string;
  relativePath: string;
  fileCount: number;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  key: string;
  name: string;
  relativePath: string;
  file: SiteFileEntry;
}

type TreeNode = FolderNode | FileNode;

function EditableTitle({ value, onSave }: { value: string; onSave?: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing && onSave) {
    return (
      <input
        defaultValue={value}
        className="mt-1 w-full rounded border border-accent/50 bg-surface-container px-1 py-0.5 text-[11px] text-muted outline-none"
        autoFocus
        onBlur={(event) => {
          const next = event.target.value.trim();
          if (next && next !== value) onSave(next);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      className="mt-1 cursor-pointer truncate text-[11px] text-muted/70 transition hover:text-accent"
      onClick={() => onSave && setEditing(true)}
      title="Click to rename"
    >
      {value}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fileIcon(file: SiteFileEntry) {
  const category = inferContentCategory(file);
  if (category === "image") return ImageIcon;
  if (isViewerFile(file.filename)) return FileText;
  return File;
}

function isViewerFile(filename: string) {
  return /\.(md|markdown|txt|js|jsx|ts|tsx|json|css|html|astro|qmd|yaml|yml|sh|mjs|cjs)$/i.test(
    filename,
  );
}

function defaultUploadTarget(template?: string): string {
  return template === "quarto-lesson" ? "images/uploads" : "public/uploads";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function relativePathForSite(file: SiteFileEntry, slug: string): string {
  const normalizedPath = file.path.replace(/\\/g, "/");
  const marker = `/sites/${slug}/`;
  const markerIndex = normalizedPath.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return normalizedPath.slice(markerIndex + marker.length);
  }

  const normalizedGroup = normalizePath(file.group);
  const rootGroup = `sites/${slug}`;
  if (normalizedGroup === rootGroup) {
    return file.filename;
  }
  if (normalizedGroup.startsWith(`${rootGroup}/`)) {
    return `${normalizedGroup.slice(rootGroup.length + 1)}/${file.filename}`;
  }

  return file.filename;
}

function ensureFolderPath(roots: TreeNode[], relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);
  let branch = roots;
  const folderParts: string[] = [];

  for (const part of parts) {
    folderParts.push(part);
    let existing = branch.find(
      (child): child is FolderNode => child.kind === "folder" && child.name === part,
    );
    if (!existing) {
      existing = {
        kind: "folder",
        key: `folder:${folderParts.join("/")}`,
        name: part,
        relativePath: folderParts.join("/"),
        fileCount: 0,
        children: [],
      };
      branch.push(existing);
    }
    branch = existing.children;
  }
}

function expectedFoldersForTemplate(template?: string): string[] {
  if (template === "quarto-lesson") {
    return ["images", "images/uploads"];
  }
  return ["public", "public/uploads"];
}

function buildTree(files: SiteFileEntry[], slug: string, template?: string): TreeNode[] {
  const roots: TreeNode[] = [];

  function getOrCreateFolder(children: TreeNode[], name: string, relativePath: string): FolderNode {
    const existing = children.find(
      (child): child is FolderNode => child.kind === "folder" && child.name === name,
    );
    if (existing) {
      return existing;
    }
    const folder: FolderNode = {
      kind: "folder",
      key: `folder:${relativePath}`,
      name,
      relativePath,
      fileCount: 0,
      children: [],
    };
    children.push(folder);
    return folder;
  }

  for (const file of files) {
    const relativePath = relativePathForSite(file, slug)
      .split("/")
      .filter(Boolean)
      .join("/");
    const parts = relativePath ? relativePath.split("/") : [file.filename];

    let branch = roots;
    const folderParts: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const isLeaf = index === parts.length - 1;
      if (isLeaf) {
        branch.push({
          kind: "file",
          key: file.path,
          name: part,
          relativePath: parts.join("/"),
          file,
        });
      } else {
        folderParts.push(part);
        const folder = getOrCreateFolder(branch, part, folderParts.join("/"));
        branch = folder.children;
      }
    }
  }

  for (const relativePath of expectedFoldersForTemplate(template)) {
    ensureFolderPath(roots, relativePath);
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes]
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "folder" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .map((node) => {
        if (node.kind === "file") return node;
        const children = sortNodes(node.children);
        const fileCount = children.reduce(
          (count, child) => count + (child.kind === "file" ? 1 : child.fileCount),
          0,
        );
        return { ...node, children, fileCount };
      });
  }

  return sortNodes(roots);
}

function defaultFolderOpen(name: string, depth: number) {
  return (
    depth < 1 ||
    ["src", "public", "images", "content", "dist", "out", "docs", "build"].includes(name)
  );
}

export function ProjectFiles({
  slug,
  title,
  sessionId,
  profileId,
  template,
  onOpenFile,
  onRename,
}: ProjectFilesProps) {
  const [files, setFiles] = useState<SiteFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useMemo(() => defaultUploadTarget(template), [template]);

  const triggerRefresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const nextFiles = await listSiteFiles(`sites/${slug}`, {
          sessionId,
          profileId,
          includeBuild: true,
        });
        if (!stopped) {
          setFiles(nextFiles);
          setError(null);
        }
      } catch (nextError) {
        if (!stopped) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load files");
        }
      } finally {
        if (!stopped) pollTimer = setTimeout(load, 2500);
      }
    }

    void load();

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [profileId, refreshTick, sessionId, slug]);

  useEffect(() => {
    function matchesSession(detail: unknown): boolean {
      return (
        !!detail &&
        typeof detail === "object" &&
        "sessionId" in detail &&
        detail.sessionId === sessionId
      );
    }

    function handleEvent(event: Event) {
      const detail =
        event instanceof CustomEvent ? (event.detail as unknown) : undefined;
      if (!matchesSession(detail)) return;
      triggerRefresh();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        triggerRefresh();
      }
    }

    window.addEventListener("focus", triggerRefresh);
    window.addEventListener("crew:file", handleEvent);
    window.addEventListener("crew:bg_tasks", handleEvent);
    window.addEventListener("crew:task_status", handleEvent);
    window.addEventListener("crew:tool_progress", handleEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", triggerRefresh);
      window.removeEventListener("crew:file", handleEvent);
      window.removeEventListener("crew:bg_tasks", handleEvent);
      window.removeEventListener("crew:task_status", handleEvent);
      window.removeEventListener("crew:tool_progress", handleEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sessionId, triggerRefresh]);

  useEffect(() => {
    if (!uploadNotice) return undefined;
    const timer = window.setTimeout(() => setUploadNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [uploadNotice]);

  const entries = useMemo(
    () => files.map((file) => siteFileToContentEntry(file, sessionId)),
    [files, sessionId],
  );

  const entryMap = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );

  const imageEntries = useMemo(
    () => entries.filter((entry) => entry.category === "image"),
    [entries],
  );

  const tree = useMemo(() => buildTree(files, slug, template), [files, slug, template]);

  const handleUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selectedFiles.length === 0) return;

    setUploading(true);
    setUploadError(null);
    try {
      const saved = await uploadSiteFiles(sessionId, slug, selectedFiles, {
        profileId,
        targetDir: uploadTarget,
      });
      setUploadNotice(
        `Uploaded ${saved.length} file${saved.length === 1 ? "" : "s"} to ${uploadTarget}`,
      );
      triggerRefresh();
    } catch (nextError) {
      setUploadError(nextError instanceof Error ? nextError.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [profileId, sessionId, slug, triggerRefresh, uploadTarget]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
        Failed to load project files: {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
        Project files will appear here after the backend scaffold finishes.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Project Files
            </div>
            <EditableTitle value={title || slug} onSave={onRename} />
            <div className="mt-1 truncate text-[10px] uppercase tracking-[0.14em] text-muted/50">
              upload target: {uploadTarget}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={handleUpload}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg p-2 text-muted transition hover:bg-surface-container hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              title={`Upload assets into ${uploadTarget}`}
              disabled={uploading}
            >
              <Upload size={15} />
            </button>
            <button
              onClick={triggerRefresh}
              className="rounded-lg p-2 text-muted transition hover:bg-surface-container hover:text-text"
              title="Refresh files"
            >
              <RefreshCw size={15} className={uploading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
        {uploadError && (
          <div className="mt-2 text-[11px] text-red-300">{uploadError}</div>
        )}
        {!uploadError && uploadNotice && (
          <div className="mt-2 text-[11px] text-emerald-300">{uploadNotice}</div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-1">
          {tree.map((node) => (
            <TreeNodeView
              key={node.key}
              node={node}
              depth={0}
              entryMap={entryMap}
              imageEntries={imageEntries}
              sessionId={sessionId}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  entryMap,
  imageEntries,
  sessionId,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  entryMap: Map<string, ContentEntry>;
  imageEntries: ContentEntry[];
  sessionId: string;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
}) {
  if (node.kind === "file") {
    return (
      <FileNodeView
        node={node}
        depth={depth}
        entryMap={entryMap}
        imageEntries={imageEntries}
        sessionId={sessionId}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <FolderNodeView
      node={node}
      depth={depth}
      entryMap={entryMap}
      imageEntries={imageEntries}
      sessionId={sessionId}
      onOpenFile={onOpenFile}
    />
  );
}

function FileNodeView({
  node,
  depth,
  entryMap,
  imageEntries,
  sessionId,
  onOpenFile,
}: {
  node: FileNode;
  depth: number;
  entryMap: Map<string, ContentEntry>;
  imageEntries: ContentEntry[];
  sessionId: string;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
}) {
  const file = node.file;
  const entry = entryMap.get(file.path) ?? siteFileToContentEntry(file, sessionId);
  const Icon = fileIcon(file);
  const category = inferContentCategory(file);
  const opensViewer = category === "image" || isViewerFile(file.filename);

  return (
    <button
      onClick={() => {
        if (opensViewer) {
          onOpenFile(entry, category === "image" ? imageEntries : [entry]);
        } else {
          void downloadContent(entry);
        }
      }}
      className="flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-container"
      style={{ paddingLeft: `${10 + depth * 16}px` }}
    >
      <div className="mt-0.5 shrink-0 text-muted">
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-strong">{file.filename}</div>
        <div className="truncate text-[10px] text-muted/65">{node.relativePath}</div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span>{formatSize(file.size)}</span>
          <span>{formatTime(file.modified)}</span>
          <span className="uppercase tracking-[0.14em] text-muted/60">{category}</span>
        </div>
      </div>
    </button>
  );
}

function FolderNodeView({
  node,
  depth,
  entryMap,
  imageEntries,
  sessionId,
  onOpenFile,
}: {
  node: FolderNode;
  depth: number;
  entryMap: Map<string, ContentEntry>;
  imageEntries: ContentEntry[];
  sessionId: string;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
}) {
  const [open, setOpen] = useState(() => defaultFolderOpen(node.name, depth));

  return (
    <div>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-text-strong hover:bg-surface-container"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {open ? (
          <>
            <ChevronDown size={14} className="shrink-0 text-muted" />
            <FolderOpen size={14} className="shrink-0 text-accent/70" />
          </>
        ) : (
          <>
            <ChevronRight size={14} className="shrink-0 text-muted" />
            <FolderClosed size={14} className="shrink-0 text-muted" />
          </>
        )}
        <span className="truncate">{node.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted/50">{node.fileCount}</span>
      </button>
      {open && (
        <div className="space-y-1">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.key}
              node={child}
              depth={depth + 1}
              entryMap={entryMap}
              imageEntries={imageEntries}
              sessionId={sessionId}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
