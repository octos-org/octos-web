/**
 * autonomy-store unit tests — per-session loops + goal backing the
 * header autonomy chip.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { UiLoopRecord } from "@/runtime/ui-protocol-types";
import {
  __resetAutonomyStoreForTest,
  getAutonomyState,
  removeLoop,
  replaceLoops,
  setGoal,
  upsertLoop,
} from "./autonomy-store";

const SESSION = "sess-autonomy-store";

function makeLoop(partial: Partial<UiLoopRecord> & { loop_id: string }): UiLoopRecord {
  return {
    session_id: SESSION,
    prompt: "check the queue",
    mode: "interval",
    interval_seconds: 300,
    status: "active",
    expires_at_ms: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...partial,
  };
}

afterEach(() => {
  __resetAutonomyStoreForTest();
});

describe("autonomy-store", () => {
  it("scopes state per (session, topic)", () => {
    replaceLoops(SESSION, [makeLoop({ loop_id: "l1" })]);
    replaceLoops(SESSION, [makeLoop({ loop_id: "l2" })], "slides");
    expect(getAutonomyState(SESSION).loops.map((l) => l.loop_id)).toEqual([
      "l1",
    ]);
    expect(
      getAutonomyState(SESSION, "slides").loops.map((l) => l.loop_id),
    ).toEqual(["l2"]);
    expect(getAutonomyState("other").loops).toEqual([]);
  });

  it("upsertLoop inserts, replaces by id, and drops deleted tombstones", () => {
    upsertLoop(SESSION, makeLoop({ loop_id: "l1", status: "active" }));
    upsertLoop(SESSION, makeLoop({ loop_id: "l1", status: "paused" }));
    expect(getAutonomyState(SESSION).loops).toHaveLength(1);
    expect(getAutonomyState(SESSION).loops[0].status).toBe("paused");
    upsertLoop(SESSION, makeLoop({ loop_id: "l1", status: "deleted" }));
    expect(getAutonomyState(SESSION).loops).toHaveLength(0);
  });

  it("removeLoop drops by id; setGoal round-trips incl. null", () => {
    upsertLoop(SESSION, makeLoop({ loop_id: "l1" }));
    removeLoop(SESSION, "l1");
    expect(getAutonomyState(SESSION).loops).toHaveLength(0);
    setGoal(SESSION, {
      goal_id: "g1",
      objective: "ship it",
      status: "active",
      token_budget: 1000,
      tokens_used: 10,
      time_used_seconds: 5,
      created_at_ms: 1,
      updated_at_ms: 1,
    });
    expect(getAutonomyState(SESSION).goal?.goal_id).toBe("g1");
    setGoal(SESSION, null);
    expect(getAutonomyState(SESSION).goal).toBe(null);
  });
});
