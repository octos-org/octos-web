export type LearningSessionStatus =
  | "provisional"
  | "active"
  | "paused"
  | "completed";

export interface LearningSessionRecord {
  id: string;
  status: LearningSessionStatus;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const STORE_KEY = "octos_learning_sessions_v1";
const CURRENT_KEY = "octos_learning_current_session";
const WAKE_ONLY = /^(你好[,，\s]*小章鱼|你好小章鱼)[。！!,.，\s]*$/;

function readRecords(): LearningSessionRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is LearningSessionRecord =>
        item !== null &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        item.id.startsWith("learn-") &&
        ["provisional", "active", "paused", "completed"].includes(item.status) &&
        typeof item.title === "string" &&
        typeof item.createdAt === "number" &&
        typeof item.updatedAt === "number",
    );
  } catch {
    return [];
  }
}

function writeRecords(records: LearningSessionRecord[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(records));
}

function generateSessionId(now: number): string {
  return `learn-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listLearningSessions(options?: {
  includeProvisional?: boolean;
}): LearningSessionRecord[] {
  const includeProvisional = options?.includeProvisional ?? false;
  return readRecords()
    .filter((record) => includeProvisional || record.status !== "provisional")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getLearningSession(id: string): LearningSessionRecord | null {
  return readRecords().find((record) => record.id === id) ?? null;
}

export function createProvisionalLearningSession(
  now = Date.now(),
): LearningSessionRecord {
  const record: LearningSessionRecord = {
    id: generateSessionId(now),
    status: "provisional",
    title: "新的学习",
    createdAt: now,
    updatedAt: now,
  };
  writeRecords([record, ...readRecords()]);
  localStorage.setItem(CURRENT_KEY, record.id);
  return record;
}

/**
 * Natural entry resumes the latest unfinished learning session. A completed
 * session always starts a fresh provisional conversation.
 */
export function resolveLearningEntrySession(
  now = Date.now(),
): LearningSessionRecord {
  const records = readRecords();
  const currentId = localStorage.getItem(CURRENT_KEY);
  const current = records.find((record) => record.id === currentId);
  // A provisional session is a real in-progress whiteboard entry, even before
  // it has enough content to appear in the sidebar. Preserve it across refresh
  // and React remounts; explicit Back/New/Delete actions own its cleanup.
  if (
    current &&
    (current.status === "provisional" ||
      current.status === "active" ||
      current.status === "paused")
  ) {
    return current;
  }
  if (current?.status === "completed") {
    return createProvisionalLearningSession(now);
  }
  const resumable = records
    .filter((record) => record.status === "active" || record.status === "paused")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (resumable) {
    localStorage.setItem(CURRENT_KEY, resumable.id);
    return resumable;
  }
  return createProvisionalLearningSession(now);
}

export function updateLearningSession(
  id: string,
  patch: Partial<Pick<LearningSessionRecord, "status" | "title">>,
  now = Date.now(),
): LearningSessionRecord | null {
  let updated: LearningSessionRecord | null = null;
  const records = readRecords().map((record) => {
    if (record.id !== id) return record;
    updated = { ...record, ...patch, updatedAt: now };
    return updated;
  });
  if (!updated) return null;
  writeRecords(records);
  localStorage.setItem(CURRENT_KEY, id);
  return updated;
}

export function removeLearningSession(id: string): LearningSessionRecord | null {
  const records = readRecords();
  const removed = records.find((record) => record.id === id) ?? null;
  if (!removed) return null;
  writeRecords(records.filter((record) => record.id !== id));
  if (localStorage.getItem(CURRENT_KEY) === id) {
    localStorage.removeItem(CURRENT_KEY);
  }
  return removed;
}

export function adoptLearningSession(
  record: LearningSessionRecord,
): LearningSessionRecord {
  const records = readRecords();
  const existing = records.find((item) => item.id === record.id);
  if (existing) {
    // The server transcript is authoritative evidence that a provisional
    // client entry became a real learning session. This also repairs the
    // local index after a refresh that happened before the input callback
    // could promote it.
    const reconciled: LearningSessionRecord = {
      ...existing,
      status:
        existing.status === "provisional" && record.status !== "provisional"
          ? record.status
          : existing.status,
      title:
        existing.status === "provisional" || existing.title === "新的学习"
          ? record.title
          : existing.title,
      createdAt: Math.min(existing.createdAt, record.createdAt),
      updatedAt: Math.max(existing.updatedAt, record.updatedAt),
    };
    writeRecords(
      records.map((item) => (item.id === record.id ? reconciled : item)),
    );
    return reconciled;
  }
  writeRecords([record, ...records]);
  return record;
}

export function isSubstantiveLearningText(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0 && !WAKE_ONLY.test(normalized);
}

export function titleFromLearningText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 28 ? normalized : `${normalized.slice(0, 28)}…`;
}

export function promoteLearningSession(
  id: string,
  firstSubstantiveText: string,
  now = Date.now(),
): LearningSessionRecord | null {
  if (!isSubstantiveLearningText(firstSubstantiveText)) return getLearningSession(id);
  return updateLearningSession(
    id,
    {
      status: "active",
      title: titleFromLearningText(firstSubstantiveText),
    },
    now,
  );
}

/** Remove client-only wake sessions left behind by false wakes or crashes. */
export function cleanupProvisionalLearningSessions(): string[] {
  const records = readRecords();
  const removed = records
    .filter((record) => record.status === "provisional")
    .map((record) => record.id);
  if (removed.length === 0) return [];
  writeRecords(records.filter((record) => record.status !== "provisional"));
  const current = localStorage.getItem(CURRENT_KEY);
  if (current && removed.includes(current)) localStorage.removeItem(CURRENT_KEY);
  return removed;
}
