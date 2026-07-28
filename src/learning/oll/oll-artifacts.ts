import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import type { Thread } from "@/store/thread-store";
import {
  normalizeAuthoringLesson,
  reduceCanonicalEvents,
  type AuthoringLesson,
  type CanonicalEvent,
} from "octos-lesson-language";

export interface OllLessonArtifactRef {
  id: string;
  filename: string;
  path: string;
  threadId: string;
  turnId: string;
}

const OLL_ARTIFACT_SUFFIX = ".octos-lesson.json";

export function isOllLessonArtifact(
  file: { filename?: string; path?: string },
): boolean {
  return [file.filename, file.path].some(
    (value) =>
      typeof value === "string" &&
      value.toLowerCase().endsWith(OLL_ARTIFACT_SUFFIX),
  );
}

export function collectOllLessonArtifacts(
  threads: Thread[],
): OllLessonArtifactRef[] {
  const artifacts: OllLessonArtifactRef[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    const messages = [
      ...thread.responses,
      ...(thread.pendingAssistant ? [thread.pendingAssistant] : []),
    ];
    for (const message of messages) {
      for (const file of message.files) {
        if (!isOllLessonArtifact(file) || seen.has(file.path)) continue;
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

export async function loadOllLessonArtifact(
  artifact: OllLessonArtifactRef,
  sessionId: string,
  signal?: AbortSignal,
): Promise<CanonicalEvent[]> {
  const response = await fetch(buildFileUrl(artifact.path, { sessionId }), {
    headers: buildApiHeaders(),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OLL 课程读取失败 (${response.status})`);
  }
  const authoring = (await response.json()) as AuthoringLesson;
  try {
    const events = normalizeAuthoringLesson(authoring, {
      lessonId: `learn-${sessionId}-${artifact.turnId}`,
      boardId: `learning-board-${sessionId}`,
      baseRevision: 0,
      regionIntent: "new_topic",
    });
    reduceCanonicalEvents(events);
    return events;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "未知格式错误";
    throw new Error(`OLL 课程格式无效：${message}`);
  }
}

export function composeOllClassroomEvents(
  lessons: CanonicalEvent[][],
  sessionId: string,
): CanonicalEvent[] {
  const firstOpen = lessons[0]?.find((event) => event.event === "lesson.open");
  if (!firstOpen) return [];
  const lessonId = `learning-session-${sessionId}`;
  const result: CanonicalEvent[] = [{
    ...structuredClone(firstOpen),
    lesson_id: lessonId,
    sequence: 0,
    board: {
      board_id: `learning-board-${sessionId}`,
      base_revision: 0,
      region_intent: "new_topic",
    },
  }];
  for (const lesson of lessons) {
    for (const event of lesson) {
      if (event.event !== "lesson.step") continue;
      result.push({
        ...structuredClone(event),
        lesson_id: lessonId,
        sequence: result.length,
      });
    }
  }
  return result;
}
