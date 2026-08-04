import type { BoardAction, LessonPacketV1 } from "./lesson-packet";

export interface LearningBoardContext {
  lastAppliedAction?: string;
  boardSummary?: string;
}

/**
 * Combine turn-scoped packets into one session-scoped canvas. Segments stay in
 * teaching order, so revealing a later turn never removes earlier work.
 */
export function mergeSessionBoardPackets(
  sessionId: string,
  packets: LessonPacketV1[],
): LessonPacketV1 {
  const latest = packets.at(-1);
  return {
    version: 1,
    lessonId: sessionId,
    turnId: latest?.turnId ?? sessionId,
    title: packets[0]?.title ?? "新的学习白板",
    segments: packets.flatMap((packet) =>
      packet.segments.map((segment) => ({
        ...segment,
        id: `${packet.turnId}:${segment.id}`,
      })),
    ),
  };
}

function actionSummary(action: BoardAction): string | null {
  switch (action.type) {
    case "write_text":
      return action.text;
    case "write_formula":
      return action.latex;
    case "draw_axes":
      return `坐标系 x∈[${action.xDomain.join(",")}], y∈[${action.yDomain.join(",")}]`;
    case "plot_function":
      return `二次函数图像 ${action.function.coefficients.join(",")}`;
    case "mark_point":
      return `${action.label}(${action.point.join(",")})`;
    case "group":
      return action.summary
        ? `${action.title}：${action.summary}`
        : action.title;
    default:
      return null;
  }
}

/** Minimal context for the next turn; no question/checkpoint state machine. */
export function buildLearningBoardContext(
  packet: LessonPacketV1,
  segmentIndex = packet.segments.length - 1,
): LearningBoardContext {
  if (segmentIndex < 0) return {};
  const actions = packet.segments
    .slice(0, segmentIndex + 1)
    .flatMap((segment) => segment.actions);
  const summaries = actions
    .map(actionSummary)
    .filter((value): value is string => Boolean(value))
    .slice(-8);
  return {
    lastAppliedAction: actions.at(-1)?.id,
    boardSummary:
      summaries.length > 0
        ? summaries.join("；").slice(0, 600)
        : undefined,
  };
}
