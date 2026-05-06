/**
 * session-context tests — Bug A (M10 follow-up).
 *
 * The sidebar dropped newly-created chats once a user accumulated more than
 * ~20 prior sessions: `refreshSessions` capped the API list with
 * `.slice(0, 20)` *before* merging, so a brand-new session at the top of the
 * list pushed an old one out — which would have been fine, except `_local`
 * was cleared by the first successful merge, so on a later refresh (when
 * clock-skewed concurrent activity bumped the new session out of the top
 * 20) it vanished entirely. Deleting any visible session "revealed
 * previously hidden ones" because the slice window then had room.
 *
 * These tests cover the pure {@link mergeSessionLists} helper.
 */

import { describe, expect, it } from "vitest";
import {
  mergeSessionLists,
  sessionTimestamp,
  SESSION_LIST_RENDER_CAP,
  type SessionWithTitle,
} from "./session-context";
import type { SessionInfo } from "@/api/types";

const NO_TITLES: Record<string, string> = {};
const NO_DELETES = new Set<string>();

// `sessionTimestamp` rejects ms timestamps < 1700000000000 (~Nov 2023) so
// fixtures need a realistic base.
const TS_BASE = 1_777_700_000_000;

function webSession(
  offsetMs: number,
  msgs = 2,
  suffix = "abc",
): SessionInfo {
  return { id: `web-${TS_BASE + offsetMs}-${suffix}`, message_count: msgs };
}

function idAt(offsetMs: number, suffix = "abc"): string {
  return `web-${TS_BASE + offsetMs}-${suffix}`;
}

describe("sessionTimestamp", () => {
  it("parses web-{ms}-{rand} format", () => {
    expect(
      sessionTimestamp({ id: "web-1777707464648-i3tb33", message_count: 1 }),
    ).toBe(1777707464648);
  });

  it("returns 0 for non-numeric prefixes", () => {
    expect(
      sessionTimestamp({ id: "web-codex-probe-1", message_count: 1 }),
    ).toBe(0);
  });

  it("returns 0 for sub-threshold (pre-2023) timestamps", () => {
    // Anything below 1700000000000 (~Nov 2023) is treated as bogus to keep
    // legacy/test artifacts from sorting above real sessions.
    expect(sessionTimestamp({ id: "web-1000-abc", message_count: 1 })).toBe(0);
  });
});

describe("mergeSessionLists", () => {
  it("returns all eligible sessions sorted newest-first", () => {
    const list: SessionInfo[] = [
      webSession(1000),
      webSession(3000),
      webSession(2000),
    ];
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([
      idAt(3000),
      idAt(2000),
      idAt(1000),
    ]);
  });

  it("filters out non-web sessions", () => {
    const list: SessionInfo[] = [
      webSession(1000),
      { id: "test-foo", message_count: 5 },
      { id: "smoke-bar", message_count: 5 },
    ];
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([idAt(1000)]);
  });

  it("filters out sessions with no persisted messages", () => {
    const list: SessionInfo[] = [
      webSession(1000, 0),
      webSession(2000, 1),
      webSession(3000, 0),
    ];
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([idAt(2000)]);
  });

  it("filters out tombstoned sessions", () => {
    const list: SessionInfo[] = [webSession(1000), webSession(2000)];
    const deleted = new Set([idAt(2000)]);
    const merged = mergeSessionLists([], list, deleted, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([idAt(1000)]);
  });

  it("hydrates titles from cache by id", () => {
    const list: SessionInfo[] = [webSession(1000)];
    const titles = { [idAt(1000)]: "first chat" };
    const merged = mergeSessionLists([], list, NO_DELETES, titles);
    expect(merged[0].title).toBe("first chat");
  });

  it("preserves local-only sessions not yet visible in the API list", () => {
    // Brand-new chat: createSession bumped `currentSessionId`, the user sent
    // their first message, `markSessionActive` marked it `_local: true`, but
    // the very next `refreshSessions` runs before the server has indexed it.
    const local: SessionWithTitle = {
      id: idAt(9999, "fresh"),
      message_count: 1,
      _local: true,
      title: "draft",
    };
    const list: SessionInfo[] = [webSession(1000), webSession(2000)];
    const merged = mergeSessionLists([local], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([
      idAt(9999, "fresh"),
      idAt(2000),
      idAt(1000),
    ]);
  });

  it("drops local-only sessions once the API echoes them", () => {
    const local: SessionWithTitle = {
      id: idAt(2000),
      message_count: 1,
      _local: true,
      title: "draft",
    };
    const list: SessionInfo[] = [webSession(2000, 4)];
    const titles = { [idAt(2000)]: "from server" };
    const merged = mergeSessionLists([local], list, NO_DELETES, titles);
    // Single entry, server-canonical (no `_local`, has the API message_count
    // and the cached title).
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(idAt(2000));
    expect(merged[0]._local).toBeUndefined();
    expect(merged[0].message_count).toBe(4);
    expect(merged[0].title).toBe("from server");
  });

  it("renders well over the legacy 20-session cap (Bug A regression guard)", () => {
    // Build 50 sessions — the previous slice(0, 20) hard-capped here.
    const list: SessionInfo[] = Array.from({ length: 50 }, (_, i) =>
      webSession(i, 2, `s${i}`),
    );
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged).toHaveLength(50);
    // Newest first.
    expect(merged[0].id).toBe(idAt(49, "s49"));
    expect(merged[49].id).toBe(idAt(0, "s0"));
  });

  it("respects the soft render cap for pathological session counts", () => {
    const cap = SESSION_LIST_RENDER_CAP;
    const total = cap + 25;
    const list: SessionInfo[] = Array.from({ length: total }, (_, i) =>
      webSession(i, 2, `s${i}`),
    );
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged).toHaveLength(cap);
    // The cap drops the OLDEST entries, not the newest — so the most recent
    // session is still present.
    expect(merged[0].id).toBe(idAt(total - 1, `s${total - 1}`));
  });

  it("regression: freshly-sent chat survives a follow-up refresh even when many other sessions exist", () => {
    // Simulate the user's reported flow under the old code:
    //   1. User has 25 prior sessions visible on the sidebar.
    //   2. User creates session #26 and sends a message.
    //   3. After `markSessionActive`, prev contains the new session as
    //      `_local: true`.
    //   4. `refreshSessions` runs: API returns all 26 sessions including
    //      the newest. Under the old slice(0, 20) the newest was kept, but
    //      `_local` was stripped on merge — fine for this refresh.
    //   5. Some concurrent activity (or just clock skew) means there are
    //      now 30+ sessions ahead of the user's chat in the sorted list.
    //   6. Under the old slice(0, 20), our new session would sit at
    //      position 21+ and be sliced out, vanishing from the sidebar
    //      entirely. Deleting any visible session would reveal the
    //      previously-hidden one — exactly the user's symptom.
    //
    // After the fix the cap is large enough that this no longer happens.
    const others = Array.from({ length: 30 }, (_, i) =>
      webSession(1_000 + i, 4, `o${i}`),
    );
    const userNew: SessionInfo = {
      id: idAt(500, "mine"),
      message_count: 2,
    };
    const list = [...others, userNew];

    // After step 4, `_local` was already stripped from prev.
    const prev: SessionWithTitle[] = [
      { ...userNew, title: "my chat" },
      ...others.map((s) => ({ ...s })),
    ];

    const merged = mergeSessionLists(prev, list, NO_DELETES, {
      [idAt(500, "mine")]: "my chat",
    });
    const ids = merged.map((s) => s.id);
    expect(ids).toContain(idAt(500, "mine"));
    expect(merged).toHaveLength(31);
  });
});
