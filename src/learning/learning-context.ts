export const LEARNING_PROTOCOL_VERSION = 4;

export interface LearningSessionContext {
  sessionId: string;
  entry: "wake-word" | "direct" | "session-list";
  provisional: boolean;
  preferredLanguage?: string;
}

export interface LearningTurnContext {
  sessionId: string;
  turnId?: string;
  provisional?: boolean;
  currentFrame?: string;
  focusedElement?: string;
  lastAppliedAction?: string;
  pendingGoal?: string;
  boardSummary?: string;
}

const LEARNING_CONTEXT_BLOCK =
  /\[\[LEARNING_(?:SESSION|CONTEXT)\]\][\s\S]*?\[\[\/LEARNING_(?:SESSION|CONTEXT)\]\]\s*/g;

function line(name: string, value: string | number | boolean): string {
  return `${name}: ${String(value).replace(/[\r\n]+/g, " ")}`;
}

/**
 * Application-owned context for the first learning turn. The server still
 * receives an ordinary text + media turn; the learning-coach Skill interprets
 * this compact block and the UI strips it from learner-visible transcripts.
 */
export function buildLearningSessionContext(
  context: LearningSessionContext,
): string {
  return [
    "[[LEARNING_SESSION]]",
    line("version", LEARNING_PROTOCOL_VERSION),
    line("session_id", context.sessionId),
    line("entry", context.entry),
    line("provisional", context.provisional),
    "mode: inferred",
    line("preferred_language", context.preferredLanguage ?? "zh-CN"),
    "[[/LEARNING_SESSION]]",
  ].join("\n");
}

/** Minimal per-turn marker, resilient to history compaction. */
export function buildLearningTurnContext(
  context: LearningTurnContext,
): string {
  const lines = [
    "[[LEARNING_CONTEXT]]",
    "active: true",
    line("session_id", context.sessionId),
  ];
  if (context.turnId) {
    lines.push(line("turn_id", context.turnId));
    lines.push("lesson_artifact_tool: oll_generate_lesson");
    lines.push("lesson_artifact_policy: tool_only");
    lines.push("direct_oll_json: forbidden");
  }
  if (context.provisional !== undefined) {
    lines.push(line("provisional", context.provisional));
  }
  if (context.currentFrame) {
    lines.push(line("current_frame", context.currentFrame));
  }
  if (context.focusedElement) {
    lines.push(line("focused_element", context.focusedElement));
  }
  if (context.lastAppliedAction) {
    lines.push(line("last_applied_action", context.lastAppliedAction));
  }
  if (context.pendingGoal) {
    lines.push(line("pending_goal", context.pendingGoal));
  }
  if (context.boardSummary) {
    lines.push(line("board_summary", context.boardSummary));
  }
  lines.push("[[/LEARNING_CONTEXT]]");
  return lines.join("\n");
}

/** Remove client protocol blocks from live and hydrated user-facing text. */
export function stripLearningContext(text: string): string {
  return text.replace(LEARNING_CONTEXT_BLOCK, "").trim();
}
