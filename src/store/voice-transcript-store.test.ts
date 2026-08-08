import { afterEach, describe, expect, it, vi } from "vitest";
import * as VoiceTranscriptStore from "./voice-transcript-store";

afterEach(() => {
  VoiceTranscriptStore.__resetVoiceTranscriptStoreForTests();
});

describe("voice transcript receive store", () => {
  it("retains a transcript for consumers that subscribe later", () => {
    VoiceTranscriptStore.upsert(
      "voice-session",
      undefined,
      "turn-1",
      "先到达的识别文字",
    );

    expect(
      VoiceTranscriptStore.getSnapshot("voice-session").transcripts.get(
        "turn-1",
      ),
    ).toBe("先到达的识别文字");
    expect(
      VoiceTranscriptStore.getSnapshot("voice-session").turnIds,
    ).toEqual(["turn-1"]);
  });

  it("notifies subscribers and isolates session/topic scopes", () => {
    const listener = vi.fn();
    const unsubscribe = VoiceTranscriptStore.subscribe(listener);

    VoiceTranscriptStore.upsert("voice-session", "lesson", "turn-1", "一");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      VoiceTranscriptStore.getSnapshot("voice-session", "lesson").transcripts,
    ).toEqual(new Map([["turn-1", "一"]]));
    expect(
      VoiceTranscriptStore.getSnapshot("voice-session").transcripts,
    ).toEqual(new Map());

    unsubscribe();
  });

  it("does not collide when a session id contains the topic separator", () => {
    VoiceTranscriptStore.upsert("voice#lesson", undefined, "turn-1", "甲");
    VoiceTranscriptStore.upsert("voice", "lesson", "turn-2", "乙");

    expect(
      VoiceTranscriptStore.getSnapshot("voice#lesson").transcripts,
    ).toEqual(new Map([["turn-1", "甲"]]));
    expect(
      VoiceTranscriptStore.getSnapshot("voice", "lesson").transcripts,
    ).toEqual(new Map([["turn-2", "乙"]]));
  });
});
