import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptLearningSession,
  cleanupProvisionalLearningSessions,
  createProvisionalLearningSession,
  isSubstantiveLearningText,
  listLearningSessions,
  promoteLearningSession,
  removeLearningSession,
  resolveLearningEntrySession,
  updateLearningSession,
} from "./learning-session-store";

describe("learning session lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
  });

  it("hides a wake-only provisional session until substantive ASR arrives", () => {
    const record = createProvisionalLearningSession(100);
    expect(listLearningSessions()).toEqual([]);

    promoteLearningSession(record.id, "这道二次函数题我不会", 200);

    expect(listLearningSessions()).toEqual([
      expect.objectContaining({
        id: record.id,
        status: "active",
        title: "这道二次函数题我不会",
        updatedAt: 200,
      }),
    ]);
  });

  it("does not promote a pure wake phrase", () => {
    const record = createProvisionalLearningSession(100);
    expect(isSubstantiveLearningText("你好，小章鱼。")).toBe(false);
    promoteLearningSession(record.id, "你好，小章鱼。", 200);
    expect(listLearningSessions()).toEqual([]);
  });

  it("resumes the latest unfinished session but not a completed one", () => {
    const first = createProvisionalLearningSession(100);
    promoteLearningSession(first.id, "学习英语", 200);
    expect(resolveLearningEntrySession(300).id).toBe(first.id);

    updateLearningSession(first.id, { status: "completed" }, 400);
    expect(resolveLearningEntrySession(500).id).not.toBe(first.id);
  });

  it("preserves the current provisional session across refresh", () => {
    const provisional = createProvisionalLearningSession(100);

    expect(resolveLearningEntrySession(200)).toEqual(provisional);
    expect(
      listLearningSessions({ includeProvisional: true }).map(
        (record) => record.id,
      ),
    ).toEqual([provisional.id]);
  });

  it("cleans orphan provisional sessions after a false wake or crash", () => {
    const provisional = createProvisionalLearningSession(100);
    expect(cleanupProvisionalLearningSessions()).toEqual([provisional.id]);
    expect(listLearningSessions({ includeProvisional: true })).toEqual([]);
  });

  it("removes a learning session from the local index", () => {
    const record = createProvisionalLearningSession(100);
    promoteLearningSession(record.id, "学习物理", 200);
    expect(removeLearningSession(record.id)?.id).toBe(record.id);
    expect(listLearningSessions({ includeProvisional: true })).toEqual([]);
  });

  it("can rebuild a paused session discovered from the server", () => {
    adoptLearningSession({
      id: "learn-900-server",
      status: "paused",
      title: "几何证明",
      createdAt: 900,
      updatedAt: 950,
    });
    expect(listLearningSessions()).toEqual([
      expect.objectContaining({
        id: "learn-900-server",
        status: "paused",
        title: "几何证明",
      }),
    ]);
  });

  it("promotes a matching provisional entry when the server has a transcript", () => {
    const provisional = createProvisionalLearningSession(900);

    const reconciled = adoptLearningSession({
      ...provisional,
      status: "paused",
      title: "负数乘法",
      updatedAt: 950,
    });

    expect(reconciled).toEqual(
      expect.objectContaining({
        id: provisional.id,
        status: "paused",
        title: "负数乘法",
        updatedAt: 950,
      }),
    );
    expect(listLearningSessions()).toHaveLength(1);
  });
});
