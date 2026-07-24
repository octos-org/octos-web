import { beforeEach, describe, expect, it } from "vitest";
import {
  clearWakeAudio,
  consumeWakeAudio,
  storeWakeAudio,
} from "./wake-audio-handoff";

describe("wake audio handoff", () => {
  beforeEach(clearWakeAudio);

  it("can be consumed exactly once", () => {
    const audio = new Blob(["wake"], { type: "audio/wav" });
    storeWakeAudio(audio);
    expect(consumeWakeAudio()).toBe(audio);
    expect(consumeWakeAudio()).toBeNull();
  });
});
