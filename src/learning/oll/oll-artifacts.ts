import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import type { SessionFileInfo } from "@/api/sessions";
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

export interface OllLessonTopic {
  id: string;
  title: string;
  stepIds: string[];
}

const OLL_ARTIFACT_SUFFIX = ".octos-lesson.json";

export function ollArtifactIdentity(
  artifact: Pick<OllLessonArtifactRef, "filename">,
): string {
  // The live projection exposes an absolute path while session/files.list
  // returns an opaque pf/... handle. The turn-scoped filename is the one
  // durable identifier shared by both representations.
  const filename = artifact.filename.replaceAll("\\", "/").split("/").at(-1);
  return encodeURIComponent(filename ?? artifact.filename);
}

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
        if (!isOllLessonArtifact(file)) continue;
        const artifact = {
          id: `${message.id}:${file.path}`,
          filename: file.filename,
          path: file.path,
          threadId: thread.id,
          turnId: thread.turnId ?? thread.id,
        };
        const identity = ollArtifactIdentity(artifact);
        if (seen.has(identity)) continue;
        seen.add(identity);
        artifacts.push(artifact);
      }
    }
  }
  return artifacts;
}

export function mergeOllLessonArtifacts(
  ...groups: OllLessonArtifactRef[][]
): OllLessonArtifactRef[] {
  const artifacts: OllLessonArtifactRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const artifact of group) {
      const identity = ollArtifactIdentity(artifact);
      if (seen.has(identity)) continue;
      seen.add(identity);
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

/**
 * Rebuild OLL artifact references from the durable session workspace.
 * Live projection file events are intentionally not the source of truth:
 * they may not be replayed after a browser refresh or a session switch.
 */
export function collectPersistedOllLessonArtifacts(
  files: SessionFileInfo[],
): OllLessonArtifactRef[] {
  return files
    .filter((file) => isOllLessonArtifact(file))
    .sort((left, right) => {
      const byTime =
        Date.parse(left.modified_at) - Date.parse(right.modified_at);
      return Number.isFinite(byTime) && byTime !== 0
        ? byTime
        : left.path.localeCompare(right.path);
    })
    .map((file) => {
      const turnId = file.filename.slice(0, -OLL_ARTIFACT_SUFFIX.length);
      return {
        id: `persisted:${file.path}`,
        filename: file.filename,
        path: file.path,
        threadId: turnId,
        turnId,
      };
    });
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
    const artifactIdentity = ollArtifactIdentity(artifact);
    const events = normalizeAuthoringLesson(authoring, {
      lessonId: `learn-${sessionId}-${artifactIdentity}`,
      boardId: `learning-board-${sessionId}`,
      baseRevision: 0,
      regionIntent: "new_topic",
      regionId: `topic-${artifactIdentity}`,
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
  let activeRegionId = firstOpen.board?.region_id ?? firstOpen.lesson_id;
  for (const lesson of lessons) {
    const open = lesson.find((event) => event.event === "lesson.open");
    if (open?.board?.region_intent === "new_topic") {
      activeRegionId = open.board.region_id ?? open.lesson_id;
    } else if (open?.board?.region_id) {
      activeRegionId = open.board.region_id;
    }
    for (const event of lesson) {
      if (event.event !== "lesson.step") continue;
      const stepEvent = {
        ...structuredClone(event),
        lesson_id: lessonId,
        sequence: result.length,
      };
      for (const beat of stepEvent.step?.beats ?? []) {
        for (const stage of Object.values(beat.stage)) {
          for (const action of stage) {
            if (action.op === "board.create" && action.node) {
              action.node.region_id ??= activeRegionId;
            }
          }
        }
      }
      result.push(stepEvent);
    }
  }
  return result;
}

export function buildOllLessonTopics(
  lessons: CanonicalEvent[][],
): OllLessonTopic[] {
  return lessons.flatMap((events, index) => {
    const open = events.find((event) => event.event === "lesson.open");
    const stepIds = events.flatMap((event) =>
      event.event === "lesson.step" && event.step ? [event.step.id] : [],
    );
    if (!open || stepIds.length === 0) return [];
    return [{
      id: open.board?.region_id ?? open.lesson_id,
      title: open.lesson?.title ?? `课程主题 ${index + 1}`,
      stepIds,
    }];
  });
}
