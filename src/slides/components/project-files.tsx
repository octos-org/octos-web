import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  FolderClosed,
  FolderOpen,
  Image as ImageIcon,
  Presentation,
} from "lucide-react";

import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";

import {
  fetchSlidesManifest,
  inferContentCategory,
  listSlidesFiles,
  slidesFileToContentEntry,
  type SlidesRenderManifest,
  type SlidesFileEntry,
} from "../api";

interface ProjectFilesProps {
  slug: string;
  title?: string;
  sessionId: string;
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
  file: SlidesFileEntry;
}

type TreeNode = FolderNode | FileNode;

function EditableTitle({ value, onSave }: { value: string; onSave?: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing && onSave) {
    return (
      <input
        defaultValue={value}
        className="mt-2 w-full rounded-[12px] border border-accent/50 bg-surface-container px-3 py-2 text-lg font-semibold tracking-tight text-text outline-none"
        autoFocus
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== value) onSave(v);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      className="mt-2 cursor-pointer truncate text-[1.45rem] font-semibold tracking-tight text-text-strong transition hover:text-accent"
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

function relativePathForSlides(file: SlidesFileEntry, slug: string): string {
  const normalizedPath = file.path.replace(/\\/g, "/");
  const slidesMarker = `/slides/${slug}/`;
  const slidesIndex = normalizedPath.lastIndexOf(slidesMarker);
  if (slidesIndex !== -1) {
    return `slides/${slug}/${normalizedPath.slice(slidesIndex + slidesMarker.length)}`;
  }

  const skillOutputMarker = "/skill-output/";
  const skillOutputIndex = normalizedPath.lastIndexOf(skillOutputMarker);
  if (skillOutputIndex !== -1) {
    return `skill-output/${normalizedPath.slice(skillOutputIndex + skillOutputMarker.length)}`;
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

function expectedFolders(slug: string): string[] {
  return [
    `slides/${slug}`,
    `slides/${slug}/output`,
    `slides/${slug}/history`,
    "skill-output",
  ];
}

function buildTree(files: SlidesFileEntry[], slug: string): TreeNode[] {
  const roots: TreeNode[] = [];

  function getOrCreateFolder(children: TreeNode[], name: string, relativePath: string): FolderNode {
    const existing = children.find(
      (child): child is FolderNode => child.kind === "folder" && child.name === name,
    );
    if (existing) return existing;
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
    const relativePath = relativePathForSlides(file, slug)
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

  for (const relativePath of expectedFolders(slug)) {
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
    depth < 2 ||
    ["slides", "skill-output", "output", "imgs", "frames", "history"].includes(name)
  );
}

function isViewerFile(filename: string) {
  return /\.(md|markdown|txt|js|jsx|ts|tsx|json)$/i.test(filename);
}

function fileIcon(file: SlidesFileEntry) {
  const category = inferContentCategory(file);
  if (category === "slides") return Presentation;
  if (category === "image") return ImageIcon;
  if (isViewerFile(file.filename)) return FileText;
  return File;
}

export function ProjectFiles({ slug, title, sessionId, onOpenFile, onRename }: ProjectFilesProps) {
  const [files, setFiles] = useState<SlidesFileEntry[]>([]);
  const [manifest, setManifest] = useState<SlidesRenderManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const requestedDirs = useMemo(() => [`slides/${slug}`, "skill-output"], [slug]);

  const triggerRefresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const nextFiles = await listSlidesFiles(requestedDirs, { sessionId });
        const nextManifest = await fetchSlidesManifest(slug, nextFiles);
        if (!stopped) {
          setFiles(nextFiles);
          setManifest(nextManifest);
          setError(null);
        }
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : "Failed to load files");
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
  }, [refreshTick, requestedDirs, sessionId, slug]);

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

  const entries = useMemo(
    () => files.map((file) => slidesFileToContentEntry(file)),
    [files],
  );

  const entryMap = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );

  const manifestImageEntries = useMemo(
    () =>
      manifest?.slides.map((slide) => {
        const existing = entryMap.get(slide.path);
        if (existing) return existing;

        return {
          id: slide.path,
          filename: slide.filename,
          path: slide.path,
          category: "image" as const,
          size_bytes: 0,
          created_at: manifest.generatedAt,
          thumbnail_path: null,
          session_id: null,
          tool_name: null,
          caption: "output/imgs",
        };
      }) ?? [],
    [entryMap, manifest],
  );

  const manifestImagePaths = useMemo(
    () => new Set(manifestImageEntries.map((entry) => entry.path)),
    [manifestImageEntries],
  );

  const tree = useMemo(() => buildTree(files, slug), [files, slug]);

  if (error) {
    return (
      <div className="shell-empty-state flex h-full items-center justify-center rounded-[12px] px-4 text-center text-sm text-muted">
        Failed to load project files: {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="shell-empty-state flex h-full items-center justify-center rounded-[12px] px-4 text-center text-sm text-muted">
        Project files will appear here after the backend scaffold finishes.
      </div>
    );
  }

  return (
    <div className="glass-panel flex h-full flex-col overflow-hidden rounded-[16px]">
      <div className="px-3 pt-3">
        <div className="glass-toolbar rounded-[14px] px-4 py-4">
          <div className="shell-kicker">Project Files</div>
          <EditableTitle value={title || slug} onSave={onRename} />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 pt-2">
        <div className="space-y-1">
          {tree.map((node) => (
            <TreeNodeView
              key={node.key}
              node={node}
              depth={0}
              entryMap={entryMap}
              manifestImageEntries={manifestImageEntries}
              manifestImagePaths={manifestImagePaths}
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
  manifestImageEntries,
  manifestImagePaths,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  entryMap: Map<string, ContentEntry>;
  manifestImageEntries: ContentEntry[];
  manifestImagePaths: Set<string>;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
}) {
  if (node.kind === "file") {
    const file = node.file;
    const entry = entryMap.get(file.path) ?? slidesFileToContentEntry(file);
    const Icon = fileIcon(file);
    const category = inferContentCategory(file);
    const opensViewer = category === "image" || isViewerFile(file.filename);

    return (
      <button
        onClick={() => {
          if (opensViewer) {
            onOpenFile(
              entry,
              category === "image" && manifestImagePaths.has(entry.path)
                ? manifestImageEntries
                : [entry],
            );
          } else {
            void downloadContent(entry);
          }
        }}
        className="glass-file-row flex w-full items-start gap-2 rounded-[12px] px-2 py-2 text-left transition-colors hover:bg-surface-elevated/70"
        style={{ paddingLeft: `${10 + depth * 16}px` }}
      >
        <div className="glass-pill mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted">
          <Icon size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-strong">
            {file.filename}
          </div>
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
              manifestImageEntries={manifestImageEntries}
              manifestImagePaths={manifestImagePaths}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
