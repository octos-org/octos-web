import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Download, FileText, Image, Music, Table, Video } from "lucide-react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import { sendMessage } from "@/runtime/ui-protocol-send";
import { useAllFiles } from "@/store/file-store";

import { STUDIO_SKILLS } from "./skills";
import { relativeTime, sourceKind, type SourceKind } from "./source-media";

interface Props {
  sessionId: string;
  historyTopic?: string;
  /**
   * Notebook source ids currently selected in the Sources pane. Their
   * count gates source-dependent skills; the sources are already imported
   * into the session workspace, so skill sends do not attach them as media.
   */
  selectedSources: string[];
}

const KIND_ICONS: Record<SourceKind, LucideIcon> = {
  image: Image,
  audio: Music,
  video: Video,
  table: Table,
  text: FileText,
};

const ASSET_LIST_CAP = 20;

/**
 * Header-authenticated blob download: keeps the bearer token out of the
 * DOM (an <a href> with ?token= is copyable/leakable via "Copy Link").
 */
async function downloadAsset(filePath: string, filename: string): Promise<void> {
  const response = await fetch(buildFileUrl(filePath), {
    headers: buildApiHeaders(),
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.click();
  } finally {
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }
}

export function StudioRail({ sessionId, historyTopic, selectedSources }: Props) {
  const allFiles = useAllFiles();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const assets = useMemo(
    () =>
      allFiles
        .filter((f) => f.sessionId === sessionId)
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, ASSET_LIST_CAP),
    [allFiles, sessionId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <h2 className="studio-headline shrink-0 text-2xl font-bold">Studio</h2>

      <section className="flex shrink-0 flex-col gap-3">
        <h3 className="text-lg font-medium text-text-strong">Skills</h3>
        <div className="grid grid-cols-2 gap-3">
          {STUDIO_SKILLS.map((skill) => {
            const disabled =
              skill.requiresSources === true && selectedSources.length === 0;
            const Icon = skill.icon;
            return (
              <button
                key={skill.id}
                type="button"
                disabled={disabled}
                aria-disabled={disabled}
                className={`studio-skill-tile${disabled ? " opacity-50" : ""}`}
                title={
                  disabled
                    ? `${skill.label} needs at least one selected source`
                    : skill.label
                }
                onClick={() => {
                  if (disabled) return;
                  sendMessage({
                    sessionId,
                    historyTopic,
                    text: skill.prompt,
                    media: [],
                  });
                }}
              >
                <span className="studio-skill-tile-icon">
                  <Icon size={18} />
                </span>
                <span className="studio-skill-tile-label">{skill.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-lg font-medium text-text-strong">Generated Assets</h3>
        {downloadError && (
          <p className="text-xs text-red-500" role="alert">
            {downloadError}
          </p>
        )}
        {assets.length === 0 ? (
          <div className="studio-empty-state text-xs">
            Assets your assistant produces will appear here.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {assets.map((file) => {
              const Icon = KIND_ICONS[sourceKind(file.filename)];
              return (
                <li
                  key={file.id}
                  className="studio-list-row studio-card !rounded-xl p-3"
                >
                  <Icon size={16} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm leading-tight"
                      title={file.filename}
                    >
                      {file.filename}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {relativeTime(file.timestamp)}
                    </span>
                  </span>
                  {file.status === "generating" ? (
                    <span
                      className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
                      role="status"
                      aria-label={`${file.filename} is generating`}
                    />
                  ) : (
                    <button
                      type="button"
                      className="studio-ghost-button studio-asset-action shrink-0 p-1"
                      aria-label={`Download ${file.filename}`}
                      onClick={() => {
                        setDownloadError(null);
                        downloadAsset(file.filePath, file.filename).catch(
                          (err: unknown) => {
                            setDownloadError(
                              err instanceof Error
                                ? err.message
                                : "Download failed",
                            );
                          },
                        );
                      }}
                    >
                      <Download size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
