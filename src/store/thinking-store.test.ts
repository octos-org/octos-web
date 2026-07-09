/**
 * thinking-store unit tests — per-session reasoning effort backing the
 * composer selector and the send path (TUI `/thinking` parity).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetThinkingStoreForTest,
  asStoredEffort,
  getThinkingEffort,
  markThinkingSeeded,
  setThinkingEffort,
  whenThinkingSeeded,
} from "./thinking-store";

const SESSION = "sess-thinking-store";

afterEach(() => {
  __resetThinkingStoreForTest();
  vi.useRealTimers();
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

  it("asStoredEffort keeps known AND unknown tiers, rejects empties", () => {
    expect(asStoredEffort("low")).toBe("low");
    expect(asStoredEffort("max")).toBe("max");
    // codex #261 P2: an unknown tier from a NEWER server must be
    // preserved — narrowing it to null would omit the field on the next
    // send, and user-turn omission clears the server's stored override.
    expect(asStoredEffort("ultra")).toBe("ultra");
    expect(asStoredEffort("  high  ")).toBe("high");
    expect(asStoredEffort("")).toBe(null);
    expect(asStoredEffort("   ")).toBe(null);
    expect(asStoredEffort(null)).toBe(null);
    expect(asStoredEffort(undefined)).toBe(null);
    expect(asStoredEffort(3)).toBe(null);
  });

  it("whenThinkingSeeded resolves immediately for a seeded scope", async () => {
    markThinkingSeeded(SESSION);
    await expect(whenThinkingSeeded(SESSION, undefined, 50)).resolves.toBe(
      undefined,
    );
  });

  it("whenThinkingSeeded resolves when the seed arrives later", async () => {
    const waiter = whenThinkingSeeded(SESSION, undefined, 5000);
    let resolved = false;
    void waiter.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // A value-seed (session/open ack) marks the scope seeded.
    setThinkingEffort(SESSION, "medium");
    await waiter;
    expect(resolved).toBe(true);
  });

  it("whenThinkingSeeded fails open after the timeout", async () => {
    vi.useFakeTimers();
    const waiter = whenThinkingSeeded(SESSION, undefined, 100);
    vi.advanceTimersByTime(101);
    await expect(waiter).resolves.toBe(undefined);
  });

  it("seeding is scope-precise", async () => {
    markThinkingSeeded(SESSION, "slides");
    // Root scope remains unseeded.
    vi.useFakeTimers();
    let rootResolved = false;
    void whenThinkingSeeded(SESSION, undefined, 100).then(() => {
      rootResolved = true;
    });
    await Promise.resolve();
    expect(rootResolved).toBe(false);
    vi.advanceTimersByTime(101);
    await Promise.resolve();
    expect(rootResolved).toBe(true);
  });
});
