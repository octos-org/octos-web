/**
 * thinking-store unit tests — per-session reasoning effort backing the
 * composer selector and the send path (TUI `/thinking` parity).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetThinkingStoreForTest,
  asReasoningEffortLevel,
  getThinkingEffort,
  setThinkingEffort,
} from "./thinking-store";

const SESSION = "sess-thinking-store";

afterEach(() => {
  __resetThinkingStoreForTest();
});

describe("thinking-store", () => {
  it("stores per-(session, topic) values independently", () => {
    setThinkingEffort(SESSION, "high");
    setThinkingEffort(SESSION, "low", "slides");
    expect(getThinkingEffort(SESSION)).toBe("high");
    expect(getThinkingEffort(SESSION, "slides")).toBe("low");
    expect(getThinkingEffort("other-session")).toBe(null);
  });

  it("clears with null", () => {
    setThinkingEffort(SESSION, "max");
    setThinkingEffort(SESSION, null);
    expect(getThinkingEffort(SESSION)).toBe(null);
  });

  it("asReasoningEffortLevel narrows wire values and rejects unknowns", () => {
    expect(asReasoningEffortLevel("low")).toBe("low");
    expect(asReasoningEffortLevel("medium")).toBe("medium");
    expect(asReasoningEffortLevel("high")).toBe("high");
    expect(asReasoningEffortLevel("max")).toBe("max");
    // Unknown future tier, null, undefined, non-strings → unset, so a
    // newer server cannot poison the selector state.
    expect(asReasoningEffortLevel("ultra")).toBe(null);
    expect(asReasoningEffortLevel(null)).toBe(null);
    expect(asReasoningEffortLevel(undefined)).toBe(null);
    expect(asReasoningEffortLevel(3)).toBe(null);
  });
});
