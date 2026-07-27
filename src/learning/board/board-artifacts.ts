import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import type { Thread } from "@/store/thread-store";
import {
  parseLessonPacket,
  type LessonPacketV1,
} from "./lesson-packet";

export interface BoardArtifactRef {
  id: string;
  filename: string;
  path: string;
  threadId: string;
  turnId: string;
}

const BOARD_ARTIFACT_SUFFIX = ".octos-board.json";

export function isBoardArtifact(
  file: { filename?: string; path?: string },
): boolean {
  return [file.filename, file.path].some(
    (value) =>
      typeof value === "string" &&
      value.toLowerCase().endsWith(BOARD_ARTIFACT_SUFFIX),
  );
}

export function collectBoardArtifacts(
  threads: Thread[],
): BoardArtifactRef[] {
  const artifacts: BoardArtifactRef[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    const messages = [
      ...thread.responses,
      ...(thread.pendingAssistant ? [thread.pendingAssistant] : []),
    ];
    for (const message of messages) {
      for (const file of message.files) {
        if (!isBoardArtifact(file) || seen.has(file.path)) continue;
        seen.add(file.path);
        artifacts.push({
          id: `${message.id}:${file.path}`,
          filename: file.filename,
          path: file.path,
          threadId: thread.id,
          turnId: thread.turnId ?? thread.id,
        });
      }
    }
  }
  return artifacts;
}

export async function loadBoardArtifact(
  artifact: BoardArtifactRef,
  sessionId: string,
  signal?: AbortSignal,
): Promise<LessonPacketV1> {
  const response = await fetch(
    buildFileUrl(artifact.path, { sessionId }),
    {
      headers: buildApiHeaders(),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`白板内容读取失败 (${response.status})`);
  }
  const raw: unknown = await response.json();
  const result = parseLessonPacket(raw);
  if (!result.packet) {
    throw new Error(`白板内容格式无效：${result.errors.join("；")}`);
  }
  return result.packet;
}
