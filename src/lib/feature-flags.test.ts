/**
 * Unit tests for the M12 Phase D-4 follow-up: flag opt-out token
 * semantics.
 *
 * Pre-follow-up `readAuxRestToWsV1FromStorage()` returned `raw === "1"`,
 * which meant ANY persisted value other than exact `"1"` was treated
 * as OFF — including `"true"`, `"yes"`, `"enabled"`, `" 1 "`. That
 * silently stranded stale experimental values on REST.
 *
 * New semantics (positive match on disable tokens):
 *   - "0", "false", "off" (case-insensitive, whitespace trimmed) → OFF
 *   - anything else (including "true", "yes", "1", garbage)        → ON
 *   - UNSET (null)                                                 → ON
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUX_REST_TO_WS_V1_FLAG_KEY,
  __clearAuxRestToWsV1ForTests,
  isAuxRestToWsV1Enabled,
} from "@/lib/feature-flags";

function setRaw(value: string): void {
  localStorage.setItem(AUX_REST_TO_WS_V1_FLAG_KEY, value);
  // Reset the cache so the next read picks up `value`.
  __clearAuxRestToWsV1ForTests();
  // __clearAuxRestToWsV1ForTests also removes the key, so write it
  // back AFTER the reset.
  localStorage.setItem(AUX_REST_TO_WS_V1_FLAG_KEY, value);
}

afterEach(() => {
  localStorage.clear();
  __clearAuxRestToWsV1ForTests();
});

describe("isAuxRestToWsV1Enabled — opt-out token semantics", () => {
  it('UNSET → ON (default)', () => {
    __clearAuxRestToWsV1ForTests();
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  // -------------------------------------------------------------------
  // OFF: positive matches on known disable tokens
  // -------------------------------------------------------------------

  it('"0" → OFF', () => {
    setRaw("0");
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  it('"false" → OFF', () => {
    setRaw("false");
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  it('"off" → OFF', () => {
    setRaw("off");
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  it('"FALSE" (uppercase) → OFF', () => {
    setRaw("FALSE");
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  it('" 0 " (whitespace-padded) → OFF', () => {
    setRaw(" 0 ");
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  it('"  False  " (mixed case + whitespace) → OFF', () => {
    setRaw("  False  ");
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  // -------------------------------------------------------------------
  // ON: anything that isn't a known disable token stays ON
  // -------------------------------------------------------------------

  it('"1" → ON', () => {
    setRaw("1");
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it('"true" → ON (no longer silently OFF as pre-follow-up)', () => {
    setRaw("true");
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it('"yes" → ON', () => {
    setRaw("yes");
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it('"enabled" → ON', () => {
    setRaw("enabled");
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it('garbage value → ON', () => {
    setRaw("hunter2");
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it('empty string → ON (not a disable token)', () => {
    setRaw("");
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it("warns once when localStorage changes after the flag has been latched", () => {
    setRaw("1");
    expect(isAuxRestToWsV1Enabled()).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(AUX_REST_TO_WS_V1_FLAG_KEY, "0");

    expect(isAuxRestToWsV1Enabled()).toBe(true);
    expect(isAuxRestToWsV1Enabled()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[octos] ${AUX_REST_TO_WS_V1_FLAG_KEY} changed mid-session; ` +
        "the new value is ignored until reload to keep wrapper " +
        "routing consistent across the page load.",
    );
  });
});
