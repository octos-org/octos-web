/**
 * M9-γ-2 projection tests.
 *
 * Three property tests (determinism, ordering, idempotency) plus the
 * `turn_completed` barrier and one focused unit test per payload variant.
 *
 * The "shuffled-within-thread" property is checked via permutation of
 * cross-thread interleavings while preserving per-thread seq monotonicity
 * — exactly the invariant the spec promises (§ 14.1: `seq` is strictly
 * monotonic WITHIN a thread; cross-thread ordering is not specified).
 */

import { beforeEach, describe, expect, it } from "vitest";

import type {
  Envelope,
  EnvelopeTokenUsage,
  FileRef,
  MessageMeta,
  Payload,
} from "../runtime/ui-protocol-types";

import {
  __resetProjectionCacheForTesting,
  project,
  projectWithMetrics,
} from "./projection";

beforeEach(() => {
  // Per-thread ThreadView cache is module-scoped; reset between
  // tests so re-used thread ids (`t1`, `t2`) don't return stale refs.
  __resetProjectionCacheForTesting();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

const META: MessageMeta = {
  message_id: "01900000-0000-7000-8000-000000000001",
  persisted_at: "2026-05-09T18:30:01Z",
};

function env(
  thread_id: string,
  seq: number,
  payload: Payload,
  client_message_id?: string,
): Envelope {
  return client_message_id !== undefined
    ? { thread_id, seq, payload, client_message_id }
    : { thread_id, seq, payload };
}

const uMsg = (text: string, files: FileRef[] = []): Payload => ({
  type: "user_message",
  data: { text, files },
});

const aDelta = (text: string): Payload => ({
  type: "assistant_delta",
  data: { text },
});

const aPersisted = (text: string, meta: MessageMeta = META): Payload => ({
  type: "assistant_persisted",
  data: { text, meta },
});

const tStart = (id: string, name: string): Payload => ({
  type: "tool_start",
  data: { tool_call_id: id, name },
});

const tProgress = (id: string, message: string): Payload => ({
  type: "tool_progress",
  data: { tool_call_id: id, message },
});

const tEnd = (
  id: string,
  status: "complete" | "error",
  error?: string,
): Payload =>
  status === "error"
    ? {
        type: "tool_end",
        data: { tool_call_id: id, status, ...(error !== undefined ? { error } : {}) },
      }
    : { type: "tool_end", data: { tool_call_id: id, status } };

const fAttached = (
  path: string,
  mime: string,
  size_bytes: number,
): Payload => ({
  type: "file_attached",
  data: { path, mime, size_bytes },
});

const tCompleted = (token_usage: EnvelopeTokenUsage = {}): Payload => ({
  type: "turn_completed",
  data: { token_usage },
});

/** Generate every interleaving of multiple per-thread streams that
 *  preserves each stream's internal order. Matches the "permutation
 *  that respects per-thread seq monotonicity" promise in the brief. */
function* interleavings<T>(streams: ReadonlyArray<ReadonlyArray<T>>): Generator<T[]> {
  const indices = streams.map(() => 0);

  function* recur(prefix: T[]): Generator<T[]> {
    let allDone = true;
    for (let i = 0; i < streams.length; i += 1) {
      if (indices[i] < streams[i].length) {
        allDone = false;
        const next = streams[i][indices[i]];
        indices[i] += 1;
        prefix.push(next);
        yield* recur(prefix);
        prefix.pop();
        indices[i] -= 1;
      }
    }
    if (allDone) yield prefix.slice();
  }

  yield* recur([]);
}

// Deep-equality JSON compare — `toEqual` is fine, but we want a
// byte-stable signature to prove determinism literally.
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v instanceof Map) {
      return Object.fromEntries(v.entries());
    }
    return v;
  });
}

// ─── Property: determinism ─────────────────────────────────────────────────

describe("project — determinism", () => {
  it("should produce byte-identical output across repeated calls on the same input", () => {
    const log: Envelope[] = [
      env("t1", 0, aDelta("Hello "), "u-1"),
      env("t1", 1, aDelta("world")),
      env("t1", 2, tStart("tc-1", "shell")),
      env("t1", 3, tProgress("tc-1", "running…")),
      env("t1", 4, tEnd("tc-1", "complete")),
      env("t1", 5, fAttached("/tmp/a.md", "text/markdown", 100)),
      env("t1", 6, aPersisted("Hello world")),
      env("t1", 7, tCompleted({ input_tokens: 10, output_tokens: 20 })),
    ];

    const a = project(log);
    const b = project(log);
    const c = project([...log]); // fresh array, same envelopes

    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toBe(fingerprint(c));
  });
});

// ─── Property: ordering by seq ─────────────────────────────────────────────

describe("project — ordering by seq", () => {
  it("should produce identical view-models for any cross-thread interleaving that preserves per-thread seq monotonicity", () => {
    // Two independent thread streams, each in seq order.
    const t1: Envelope[] = [
      env("t1", 0, aDelta("hi"), "u-t1"),
      env("t1", 1, aPersisted("hi")),
      env("t1", 2, tCompleted()),
    ];
    const t2: Envelope[] = [
      env("t2", 0, aDelta("yo"), "u-t2"),
      env("t2", 1, aDelta("!")),
      env("t2", 2, tStart("tc-x", "web")),
      env("t2", 3, tEnd("tc-x", "complete")),
    ];

    const reference = project([...t1, ...t2]);
    const refFp = fingerprint(reference);

    let count = 0;
    for (const interleave of interleavings([t1, t2])) {
      const got = project(interleave);
      // Per-thread state must match.
      const byThread = new Map(got.threads.map((t) => [t.thread_id, t]));
      const refByThread = new Map(reference.threads.map((t) => [t.thread_id, t]));
      expect(byThread.size).toBe(refByThread.size);
      for (const [tid, refThread] of refByThread) {
        expect(byThread.get(tid)).toEqual(refThread);
      }
      // The cross-thread `threads` array order is determined by
      // first-seen seq, which depends on the interleave — so we don't
      // demand byte-identity on the OUTER fingerprint.
      count += 1;
    }
    // Sanity: we generated more than one permutation.
    expect(count).toBeGreaterThan(1);
    // And the canonical (concatenated) ordering is itself a valid
    // permutation, so the reference exists.
    expect(refFp.length).toBeGreaterThan(0);
  });

  it("should preserve thread row order = first-seen seq across threads", () => {
    // t2 introduces first; t1 follows.
    const log: Envelope[] = [
      env("t2", 0, aDelta("first")),
      env("t1", 0, aDelta("second")),
    ];
    const view = project(log);
    expect(view.threads.map((t) => t.thread_id)).toEqual(["t2", "t1"]);
  });
});

// ─── Property: idempotency ────────────────────────────────────────────────

describe("project — idempotency", () => {
  it("should ignore an exact-duplicate (thread_id, seq) envelope", () => {
    const base: Envelope[] = [
      env("t1", 0, aDelta("Hello "), "u-1"),
      env("t1", 1, aDelta("world")),
      env("t1", 2, aPersisted("Hello world")),
    ];
    const dup = env("t1", 1, aDelta("ZZZ")); // same (thread_id, seq) as base[1]
    const withDup = [...base, dup];

    const a = projectWithMetrics(base);
    const b = projectWithMetrics(withDup);

    expect(b.view).toEqual(a.view);
    expect(b.metrics.duplicates).toBe(1);
    expect(a.metrics.duplicates).toBe(0);
  });

  it("should buffer out-of-order envelopes and apply them once the gap fills (codex BLOCK 1)", () => {
    // seq 0,2,1 — pre-fix dropped seq=1 permanently.
    const log: Envelope[] = [
      env("t1", 0, aDelta("a")),
      env("t1", 2, aDelta("c")),
      env("t1", 1, aDelta("b")),
    ];
    const result = projectWithMetrics(log);
    const t = result.view.threads[0];
    expect(t.assistant?.text).toBe("abc");
    // seq 2 took the buffering path; seq 1 was the in-order arrival
    // that drained the gap (no bump).
    expect(result.metrics.outOfOrder).toBe(1);
    expect(result.metrics.duplicates).toBe(0);
  });

  it("should buffer arrivals beyond the gap until the gap fills (large gap)", () => {
    // seq 0, 5, 2, 1 — when 1 arrives, drain 1; 2 was already
    // buffered so drain 2; 3,4 missing so 5 stays buffered.
    const log: Envelope[] = [
      env("t1", 0, aDelta("a")),
      env("t1", 5, aDelta("z")),
      env("t1", 2, aDelta("c")),
      env("t1", 1, aDelta("b")),
    ];
    const result = projectWithMetrics(log);
    const t = result.view.threads[0];
    expect(t.assistant?.text).toBe("abc");
    // seq 5 + seq 2 buffered (=2). seq 1 was in-order (no bump).
    expect(result.metrics.outOfOrder).toBe(2);
  });

  it("should produce identical output for [0,1,2] and [0,2,1] (codex BLOCK 2 order-independence)", () => {
    const inOrder: Envelope[] = [
      env("t1", 0, aDelta("a")),
      env("t1", 1, aDelta("b")),
      env("t1", 2, aDelta("c")),
    ];
    const outOfOrder: Envelope[] = [
      env("t1", 0, aDelta("a")),
      env("t1", 2, aDelta("c")),
      env("t1", 1, aDelta("b")),
    ];
    expect(project(inOrder)).toEqual(project(outOfOrder));
  });
});

// ─── turn_completed barrier ───────────────────────────────────────────────

describe("project — turn_completed barrier", () => {
  it("should drop any envelope after turn_completed for the same thread and bump the metric", () => {
    const log: Envelope[] = [
      env("t1", 0, aDelta("hi")),
      env("t1", 1, aPersisted("hi")),
      env("t1", 2, tCompleted({ input_tokens: 1, output_tokens: 2 })),
      env("t1", 3, aDelta("LATE")), // forbidden post-barrier delta
      env("t1", 4, tStart("tc-late", "shell")), // forbidden post-barrier tool
      env("t1", 5, fAttached("/tmp/late.md", "text/markdown", 1)),
    ];
    const result = projectWithMetrics(log);
    const t = result.view.threads[0];
    expect(t.completed).toBe(true);
    expect(t.tokenUsage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(t.assistant?.text).toBe("hi");
    expect(t.toolCalls).toEqual([]);
    expect(t.files).toEqual([]);
    expect(result.metrics.droppedAfterTurnCompleted).toBe(3);
  });

  it("should not affect other threads when one thread completes", () => {
    const log: Envelope[] = [
      env("t1", 0, aDelta("a")),
      env("t1", 1, tCompleted()),
      env("t2", 0, aDelta("b")), // different thread, must survive
      env("t1", 2, aDelta("LATE")),
    ];
    const result = projectWithMetrics(log);
    const byThread = new Map(result.view.threads.map((t) => [t.thread_id, t]));
    expect(byThread.get("t1")?.completed).toBe(true);
    expect(byThread.get("t1")?.assistant?.text).toBe("a");
    expect(byThread.get("t2")?.completed).toBe(false);
    expect(byThread.get("t2")?.assistant?.text).toBe("b");
    expect(result.metrics.droppedAfterTurnCompleted).toBe(1);
  });
});

// ─── Per-variant focused unit tests ───────────────────────────────────────

describe("project — assistant_delta accumulates text", () => {
  it("should concatenate fragments in seq order", () => {
    const log: Envelope[] = [
      env("t1", 0, aDelta("foo ")),
      env("t1", 1, aDelta("bar ")),
      env("t1", 2, aDelta("baz")),
    ];
    const view = project(log);
    expect(view.threads[0].assistant?.text).toBe("foo bar baz");
    expect(view.threads[0].assistant?.persisted).toBe(false);
    expect(view.threads[0].assistant?.meta).toBeNull();
  });
});

describe("project — assistant_persisted replaces text + finalizes meta", () => {
  it("should replace streamed text with persisted text and stamp meta", () => {
    const meta: MessageMeta = {
      message_id: "01900000-0000-7000-8000-000000000018",
      persisted_at: "2026-05-09T18:30:01Z",
      media: ["report.md"],
    };
    const log: Envelope[] = [
      env("t1", 0, aDelta("Hello ")),
      env("t1", 1, aDelta("wo")),
      env("t1", 2, aPersisted("Hello world", meta)),
    ];
    const view = project(log);
    const a = view.threads[0].assistant!;
    expect(a.text).toBe("Hello world");
    expect(a.meta).toEqual(meta);
    expect(a.persisted).toBe(true);
  });
});

describe("project — tool_start adds a toolCall", () => {
  it("should open a tool-call card keyed on tool_call_id", () => {
    const log: Envelope[] = [env("t1", 0, tStart("tc-1", "shell"))];
    const view = project(log);
    expect(view.threads[0].toolCalls).toEqual([
      {
        tool_call_id: "tc-1",
        name: "shell",
        progress: [],
        status: null,
        error: null,
      },
    ]);
  });
});

describe("project — tool_progress appends to the matching toolCall", () => {
  it("should append progress messages in seq order", () => {
    const log: Envelope[] = [
      env("t1", 0, tStart("tc-1", "shell")),
      env("t1", 1, tProgress("tc-1", "starting")),
      env("t1", 2, tProgress("tc-1", "running…")),
      env("t1", 3, tProgress("tc-1", "almost done")),
    ];
    const view = project(log);
    expect(view.threads[0].toolCalls[0].progress).toEqual([
      "starting",
      "running…",
      "almost done",
    ]);
  });
});

describe("project — tool_end stamps status (and error iff status==error)", () => {
  it("should set status=complete with no error", () => {
    const log: Envelope[] = [
      env("t1", 0, tStart("tc-1", "shell")),
      env("t1", 1, tEnd("tc-1", "complete")),
    ];
    const view = project(log);
    expect(view.threads[0].toolCalls[0].status).toBe("complete");
    expect(view.threads[0].toolCalls[0].error).toBeNull();
  });

  it("should set status=error and surface the error string", () => {
    const log: Envelope[] = [
      env("t1", 0, tStart("tc-2", "web")),
      env("t1", 1, tEnd("tc-2", "error", "boom")),
    ];
    const view = project(log);
    expect(view.threads[0].toolCalls[0].status).toBe("error");
    expect(view.threads[0].toolCalls[0].error).toBe("boom");
  });
});

describe("project — file_attached adds to files", () => {
  it("should record arrival order with the envelope's seq", () => {
    const log: Envelope[] = [
      env("t1", 0, fAttached("/tmp/a.md", "text/markdown", 10)),
      env("t1", 1, fAttached("/tmp/b.mp3", "audio/mpeg", 2048)),
    ];
    const view = project(log);
    expect(view.threads[0].files).toEqual([
      { seq: 0, path: "/tmp/a.md", mime: "text/markdown", size_bytes: 10 },
      { seq: 1, path: "/tmp/b.mp3", mime: "audio/mpeg", size_bytes: 2048 },
    ]);
  });
});

// ─── Misc surface checks ──────────────────────────────────────────────────

describe("project — user view captures client_message_id when present", () => {
  it("should record the client_message_id from the first envelope", () => {
    const log: Envelope[] = [
      env("t1", 0, aDelta("hi"), "u-token-1"),
      env("t1", 1, aDelta("there")),
    ];
    const view = project(log);
    // Until a `user_message` envelope lands, text/files default to
    // empty (codex BLOCK 3: no first-envelope-seen fallback).
    expect(view.threads[0].user).toEqual({
      seq: 0,
      client_message_id: "u-token-1",
      text: "",
      files: [],
    });
  });

  it("should leave client_message_id unset when the envelope omits it", () => {
    const log: Envelope[] = [env("t1", 0, aDelta("hi"))];
    const view = project(log);
    expect(view.threads[0].user).toEqual({ seq: 0, text: "", files: [] });
  });
});

describe("project — empty input", () => {
  it("should produce an empty view-model", () => {
    const view = project([]);
    expect(view).toEqual({ threads: [] });
  });
});

// ─── BLOCK 3: user_message payload populates UserView ────────────────────

describe("project — user_message variant (codex BLOCK 3)", () => {
  it("should populate UserView.text and UserView.files from a user_message envelope", () => {
    const files: FileRef[] = [
      { path: "/tmp/notes.md", mime: "text/markdown", size_bytes: 42 },
    ];
    const log: Envelope[] = [
      env("t1", 0, uMsg("Hello!", files), "u-1"),
      env("t1", 1, aDelta("Hi ")),
      env("t1", 2, aDelta("there")),
    ];
    const view = project(log);
    const u = view.threads[0].user!;
    expect(u.text).toBe("Hello!");
    expect(u.files).toEqual(files);
    expect(u.client_message_id).toBe("u-1");
    expect(u.seq).toBe(0);
    expect(view.threads[0].assistant?.text).toBe("Hi there");
  });

  it("should NOT clobber UserView.text from a later assistant_delta (no first-envelope fallback)", () => {
    const log: Envelope[] = [env("t1", 0, aDelta("assistant content"))];
    const view = project(log);
    expect(view.threads[0].user?.text).toBe("");
    expect(view.threads[0].user?.files).toEqual([]);
  });

  it("should preserve UserView.text under buffered out-of-order arrival of the user_message envelope", () => {
    const files: FileRef[] = [{ path: "/tmp/x.png" }];
    const log: Envelope[] = [
      env("t1", 1, aDelta("after"), "u-late"),
      env("t1", 0, uMsg("typed", files), "u-late"),
    ];
    const view = project(log);
    const u = view.threads[0].user!;
    expect(u.text).toBe("typed");
    expect(u.files).toEqual(files);
    expect(view.threads[0].assistant?.text).toBe("after");
  });

  it("should ignore a second user_message payload (first-seen wins per thread)", () => {
    const log: Envelope[] = [
      env("t1", 0, uMsg("first")),
      env("t1", 1, uMsg("second")),
    ];
    const view = project(log);
    expect(view.threads[0].user?.text).toBe("first");
  });
});

// ─── BLOCK 4: referential stability across project() calls ───────────────

describe("project — referential stability (codex BLOCK 4)", () => {
  it("should return the same ChatViewModel reference for the same input array", () => {
    const log: Envelope[] = [
      env("t1", 0, uMsg("hi"), "u-1"),
      env("t1", 1, aDelta("hello")),
    ];
    const a = project(log);
    const b = project(log);
    expect(a).toBe(b);
  });

  it("should reuse per-thread ThreadView refs across distinct projections when the thread is unchanged", () => {
    const log1: Envelope[] = [
      env("t1", 0, uMsg("hi"), "u-1"),
      env("t1", 1, aDelta("hello")),
    ];
    const log2: Envelope[] = log1.slice();
    const v1 = project(log1);
    const v2 = project(log2);
    expect(v1).not.toBe(v2);
    expect(v1.threads[0]).toBe(v2.threads[0]);
  });

  it("should mint a new ThreadView ref when the thread's contents materially change", () => {
    const log1: Envelope[] = [env("t1", 0, uMsg("hi"))];
    const log2: Envelope[] = [
      env("t1", 0, uMsg("hi")),
      env("t1", 1, aDelta("more")),
    ];
    const v1 = project(log1);
    const v2 = project(log2);
    expect(v1.threads[0]).not.toBe(v2.threads[0]);
  });
});
