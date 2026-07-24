export const LEARNING_PROTOCOL_VERSION = 3;

export interface LearningSessionContext {
  sessionId: string;
  entry: "wake-word" | "direct" | "session-list";
  provisional: boolean;
  preferredLanguage?: string;
}

export interface LearningTurnContext {
  sessionId: string;
  provisional?: boolean;
  currentFrame?: string;
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
  if (context.provisional !== undefined) {
    lines.push(line("provisional", context.provisional));
  }
  if (context.currentFrame) {
    lines.push(line("current_frame", context.currentFrame));
  }
  lines.push("[[/LEARNING_CONTEXT]]");
  return lines.join("\n");
}

/** Remove client protocol blocks from live and hydrated user-facing text. */
export function stripLearningContext(text: string): string {
  return text.replace(LEARNING_CONTEXT_BLOCK, "").trim();
}
