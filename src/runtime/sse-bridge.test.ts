/**
 * sse-bridge unit tests — overflow-stress regression (#680 follow-up).
 *
 * Covers the per-thread text accumulator added to fix the cross-talk
 * Codex flagged in PR review: pre-fix, the bridge had a single `rawText`
 * accumulator per stream closure, so concurrent same-chat turns clobbered
 * each other's text every time `replaceAssistantText(tid, rawText)` fired
 * with the wrong tid's accumulated content.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __getRawTextByThreadMapForTest,
  __resetSessionStateForTest,
  applyPerThreadTextEvent,
} from "./sse-bridge";

afterEach(() => {
  __resetSessionStateForTest();
});

describe("applyPerThreadTextEvent", () => {
  it("appends token to the matching thread only", () => {
    const acc = new Map<string, string>();
    expect(applyPerThreadTextEvent(acc, "cmid-A", "token", "Hello")).toBe(
      "Hello",
    );
    expect(applyPerThreadTextEvent(acc, "cmid-B", "token", "Hi")).toBe("Hi");
    // A's next token must extend A only, not B's text.
    expect(applyPerThreadTextEvent(acc, "cmid-A", "token", " world")).toBe(
      "Hello world",
    );
    expect(acc.get("cmid-A")).toBe("Hello world");
    expect(acc.get("cmid-B")).toBe("Hi");
  });

  it("replace overwrites the matching thread only", () => {
    const acc = new Map<string, string>();
    applyPerThreadTextEvent(acc, "cmid-A", "token", "Hello");
    applyPerThreadTextEvent(acc, "cmid-B", "token", "Hi");
    // B's `replace` must NOT touch A's accumulator.
    expect(applyPerThreadTextEvent(acc, "cmid-B", "replace", "Greetings")).toBe(
      "Greetings",
    );
    expect(acc.get("cmid-A")).toBe("Hello");
    expect(acc.get("cmid-B")).toBe("Greetings");
  });

  it("interleaved concurrent streams keep their text isolated", () => {
    // The exact production scenario: two turns on the same chat send
    // tokens in interleaved order. Each thread's accumulator must only
    // ever hold its own text.
    const acc = new Map<string, string>();
    applyPerThreadTextEvent(acc, "cmid-A", "token", "The answer ");
    applyPerThreadTextEvent(acc, "cmid-B", "token", "Beijing weather: ");
    applyPerThreadTextEvent(acc, "cmid-A", "token", "is 2.");
    applyPerThreadTextEvent(acc, "cmid-B", "token", "20 degrees.");
    expect(acc.get("cmid-A")).toBe("The answer is 2.");
    expect(acc.get("cmid-B")).toBe("Beijing weather: 20 degrees.");
  });

  it("five concurrent threads with prefix-overlapping tokens stay isolated", () => {
    // The overflow-stress soak: 5 turns whose first chunks all happen to
    // start with "Reply" — pre-fix the bridge's single `rawText` would
    // appear to "extend" from each turn into the next. Per-thread
    // accumulators give each turn its own independent state.
    const acc = new Map<string, string>();
    for (let i = 1; i <= 5; i++) {
      applyPerThreadTextEvent(acc, `cmid-${i}`, "token", "Reply ");
    }
    for (let i = 1; i <= 5; i++) {
      applyPerThreadTextEvent(acc, `cmid-${i}`, "token", `for thread ${i}.`);
    }
    for (let i = 1; i <= 5; i++) {
      expect(acc.get(`cmid-${i}`)).toBe(`Reply for thread ${i}.`);
    }
  });
});

describe("session-scoped rawTextByThread map", () => {
  // Codex 2nd-opinion follow-up regression: a turn's `replace` arrives
  // on connection 1, then `token` deltas arrive on connection 2 (page
  // reload, retry-fetch, multi-tab). The per-thread accumulator MUST
  // be session-scoped — NOT per-bridge-closure — so the second closure
  // sees the prefix written by the first and a token ` there` appends
  // correctly to "Hello" rather than overwriting ThreadStore with just
  // " there".
  const SESSION = "sess-X";

  it("accumulator persists across bridge closures via session scope", () => {
    // Closure 1: replace seeds "Hello" for cmid-A.
    const c1 = __getRawTextByThreadMapForTest(SESSION);
    applyPerThreadTextEvent(c1, "cmid-A", "replace", "Hello");

    // Closure 2 (page reload, retry-fetch, etc.) — re-reads the SAME
    // session-scoped map. The prior accumulated text must still be
    // there.
    const c2 = __getRawTextByThreadMapForTest(SESSION);
    expect(
      c2.get("cmid-A"),
      "session-scoped accumulator must survive bridge closure churn",
    ).toBe("Hello");

    // A `token` delta on the new closure extends correctly.
    expect(
      applyPerThreadTextEvent(c2, "cmid-A", "token", " there"),
    ).toBe("Hello there");
  });

  it("accumulator is keyed by (session, topic) so concurrent topics stay isolated", () => {
    const main = __getRawTextByThreadMapForTest(SESSION);
    const topicA = __getRawTextByThreadMapForTest(SESSION, "topic-A");
    applyPerThreadTextEvent(main, "cmid-X", "replace", "main");
    applyPerThreadTextEvent(topicA, "cmid-X", "replace", "topic");
    expect(main.get("cmid-X")).toBe("main");
    expect(topicA.get("cmid-X")).toBe("topic");
  });
});
