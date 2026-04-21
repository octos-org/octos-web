function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function normalizeTopic(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseSessionKey(value: unknown): {
  sessionId?: string;
  topic?: string;
} {
  if (typeof value !== "string" || !value.trim()) return {};

  const [base, topic] = value.split("#", 2);
  const parts = base.split(":").filter(Boolean);
  const sessionId = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return {
    sessionId,
    topic: normalizeTopic(topic),
  };
}

export function eventSessionId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  for (const key of ["sessionId", "session_id", "chatId", "chat_id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  const fromSessionKey = parseSessionKey(record.session_key);
  if (fromSessionKey.sessionId) return fromSessionKey.sessionId;

  const task = asRecord(record.task);
  const fromTaskSessionKey = parseSessionKey(task?.session_key);
  return fromTaskSessionKey.sessionId;
}

export function eventTopic(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  for (const key of ["topic", "historyTopic", "history_topic"]) {
    const candidate = normalizeTopic(record[key]);
    if (candidate) return candidate;
  }

  const fromSessionKey = parseSessionKey(record.session_key);
  if (fromSessionKey.topic) return fromSessionKey.topic;

  const task = asRecord(record.task);
  const fromTaskSessionKey = parseSessionKey(task?.session_key);
  return fromTaskSessionKey.topic;
}

export function eventMatchesScope(
  value: unknown,
  sessionId: string,
  topic?: string,
): boolean {
  const scopedSessionId = eventSessionId(value);
  if (!scopedSessionId || scopedSessionId !== sessionId) return false;

  const scopedTopic = eventTopic(value);
  const currentTopic = normalizeTopic(topic);
  return scopedTopic === currentTopic;
}

