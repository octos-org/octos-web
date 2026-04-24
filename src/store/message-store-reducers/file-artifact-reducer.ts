import type { Message, MessageFile } from "../message-store";
import { displayFilenameFromPath } from "../../lib/utils";
import {
  findMessageIndexById,
  findMessageIndexByToolCallId,
  mergeMessageFiles,
  pathMatchKeys,
  TASK_COMPLETION_RE,
} from "./shared";

export interface AppendFileArtifactEvent {
  type: "append_file_artifact";
  message: Message;
  file: MessageFile;
}

export function addFileToMessage(message: Message, file: MessageFile): Message {
  if (message.files.some((existing) => existing.path === file.path)) return message;
  return { ...message, files: [...message.files, file] };
}

export function reduceAppendFileArtifactEvent(event: AppendFileArtifactEvent): Message {
  return addFileToMessage(event.message, event.file);
}

export function parseLegacyFileLine(line: string): MessageFile | null {
  const match = line.trim().match(/^\[file:([^\]]+)\]\s*(.*)$/u);
  if (!match) return null;

  const path = match[1]?.trim();
  if (!path) return null;

  const fallbackName = displayFilenameFromPath(path);
  const remainder = (match[2] || "").trim();
  if (!remainder) {
    return { filename: fallbackName, path, caption: "" };
  }

  const separator = " — ";
  const sepIdx = remainder.indexOf(separator);
  if (sepIdx === -1) {
    return { filename: remainder || fallbackName, path, caption: "" };
  }

  const filename = remainder.slice(0, sepIdx).trim() || fallbackName;
  const caption = remainder.slice(sepIdx + separator.length).trim();
  return { filename, path, caption };
}

export function parseLegacyFileDeliveries(content: string): {
  text: string;
  files: MessageFile[];
} {
  if (!content.includes("[file:")) {
    return { text: content, files: [] };
  }

  const files: MessageFile[] = [];
  const remainingLines: string[] = [];
  const seenPaths = new Set<string>();

  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseLegacyFileLine(line);
    if (!parsed) {
      remainingLines.push(line);
      continue;
    }

    if (seenPaths.has(parsed.path)) continue;
    seenPaths.add(parsed.path);
    files.push(parsed);
  }

  return {
    text: remainingLines.join("\n").trim(),
    files,
  };
}

export function findMessageIndexForFilePath(
  outputPathMessageIds: ReadonlyMap<string, string> | undefined,
  list: Message[],
  file: MessageFile,
): number {
  if (!outputPathMessageIds) return -1;

  for (const pathKey of pathMatchKeys(file.path)) {
    const messageId = outputPathMessageIds.get(pathKey);
    if (!messageId) continue;
    const index = findMessageIndexById(list, messageId);
    if (index !== -1) return index;
  }
  return -1;
}

export function shouldCoalesceFileResult(message: Message): boolean {
  if (message.role !== "assistant" || message.files.length === 0) return false;
  if (message.sourceToolCallId) return true;
  if (!message.text.trim()) return true;
  return TASK_COMPLETION_RE.test(message.text.trim());
}

export function findFileResultTargetIndex(
  outputPathMessageIds: ReadonlyMap<string, string> | undefined,
  list: Message[],
  fileResult: Message,
): number {
  if (!shouldCoalesceFileResult(fileResult)) return -1;

  const byToolCall = findMessageIndexByToolCallId(
    list,
    fileResult.sourceToolCallId,
  );
  if (byToolCall !== -1) return byToolCall;

  for (const file of fileResult.files) {
    const byPath = findMessageIndexForFilePath(outputPathMessageIds, list, file);
    if (byPath !== -1) return byPath;
  }

  const adjacent = findAdjacentFileResultTargetIndex(list, fileResult);
  if (adjacent !== -1) return adjacent;

  return -1;
}

export function findAdjacentFileResultTargetIndex(
  list: Message[],
  fileResult: Message,
): number {
  const fileText = fileResult.text.trim();
  const isMediaOnly = fileText.length === 0 || TASK_COMPLETION_RE.test(fileText);
  if (!isMediaOnly) return -1;
  const fileSeq = fileResult.historySeq;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (candidate.kind === "task_anchor") continue;
    if (candidate.role === "user" || candidate.role === "system") return -1;
    if (candidate.role !== "assistant") continue;
    if (!candidate.text.trim() && candidate.toolCalls.length === 0) continue;

    if (typeof fileSeq === "number" && typeof candidate.historySeq === "number") {
      return fileSeq === candidate.historySeq + 1 ? index : -1;
    }

    const delta = fileResult.timestamp - candidate.timestamp;
    if (delta < 0 || delta > 5 * 60_000) return -1;
    return index;
  }

  return -1;
}

export function mergeFileResultIntoTarget(target: Message, fileResult: Message): Message {
  const files = fileResult.files.map((file) => ({
    ...file,
    caption: file.caption || fileResult.text || "",
  }));

  return {
    ...target,
    text: target.text.trim() ? target.text : fileResult.text,
    files: mergeMessageFiles(files, target.files),
    toolCalls:
      target.toolCalls.length > 0 ? target.toolCalls : fileResult.toolCalls,
    sourceToolCallId: target.sourceToolCallId ?? fileResult.sourceToolCallId,
    historySeq:
      typeof target.historySeq === "number" && typeof fileResult.historySeq === "number"
        ? Math.max(target.historySeq, fileResult.historySeq)
        : (fileResult.historySeq ?? target.historySeq),
  };
}
