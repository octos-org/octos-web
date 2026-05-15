/**
 * `ToolProgressIndicator` unit tests.
 *
 * Anchor/derivation regression (2026-05-14):
 *
 * The indicator used to subscribe to `crew:tool_progress` window
 * events for its display state. That had two structural problems:
 *
 *   1. The indicator is mounted inside the assistant bubble, gated on
 *      `message.toolCalls.length > 0`. The bubble only acquires its
 *      first tool call when `tool/started` is processed, which is
 *      ALSO when the first `crew:tool_progress` event fires — so the
 *      indicator's `useEffect` listener attaches AFTER the first
 *      progress event has already been dispatched and dropped on the
 *      floor. The user-reported bug ("`run_pipeline: running` sat
 *      above the input prompt for ~25 min, detached from the bubble")
 *      was the lifted (chat-layout-level) workaround for the
 *      missing-spinner regression that this listener-attach race
 *      caused. The lift created a different bug (detached spinner)
 *      so we redesigned the indicator to be a pure derivation of
 *      `message.toolCalls` instead — no listeners, no race.
 *
 *   2. Per-bubble state was lost when React reconciled the
 *      `pendingAssistant -> responses[]` promotion (different parent
 *      array even with the same `key`).
 *
 * The new design is a pure render of the latest progress entry across
 * `message.toolCalls[*].progress`. With `1a20b7a`'s immutable
 * tool-call updates the bubble re-renders on every heartbeat, so the
 * indicator picks up new entries automatically.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ToolProgressIndicator } from "./tool-progress-indicator";
import type { ThreadMessage } from "@/store/thread-store";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(node: React.ReactElement): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function makeMessage(toolCalls: ThreadMessage["toolCalls"]): ThreadMessage {
  return {
    id: "msg-1",
    role: "assistant",
    text: "",
    files: [],
    toolCalls,
    status: "streaming",
    timestamp: Date.now(),
  };
}

afterEach(() => {
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

describe("ToolProgressIndicator (data-derived)", () => {
  it("renders nothing when no tool calls have progress entries", () => {
    const message = makeMessage([
      {
        id: "tc-1",
        name: "shell",
        status: "running",
        progress: [],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("renders nothing when the message has no tool calls at all", () => {
    const message = makeMessage([]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("renders the latest progress entry's tool name and cleaned message", () => {
    const message = makeMessage([
      {
        id: "tc-1",
        name: "shell",
        status: "running",
        progress: [
          { message: "[info] cargo build", ts: 100 },
          { message: "[info] running cargo test", ts: 200 },
        ],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector("[data-testid='tool-progress']");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("shell");
    // The component strips `[info]/[debug]/[warn]` prefixes.
    expect(row!.textContent).toContain("running cargo test");
    expect(row!.textContent).not.toContain("[info]");
    // The OLDER entry is superseded by the LATER one (higher ts wins).
    expect(row!.textContent).not.toContain("cargo build");
    harness.unmount();
  });

  it("picks the highest-ts entry across multiple tool calls", () => {
    // Two tool calls: an earlier-completed `shell` and a still-emitting
    // `run_pipeline`. The latter's most recent heartbeat must win.
    const message = makeMessage([
      {
        id: "tc-1",
        name: "shell",
        status: "complete",
        progress: [{ message: "done", ts: 100 }],
        retryCount: 0,
      },
      {
        id: "tc-2",
        name: "run_pipeline",
        status: "complete",
        progress: [
          { message: "starting", ts: 150 },
          { message: "5s elapsed", ts: 200 },
          { message: "10s elapsed", ts: 250 },
        ],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector("[data-testid='tool-progress']");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("run_pipeline");
    expect(row!.textContent).toContain("10s elapsed");
    expect(row!.textContent).not.toContain("shell");
    expect(row!.textContent).not.toContain("done");
    harness.unmount();
  });

  it("re-renders the latest entry when the message prop updates (heartbeat path)", () => {
    let message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "running",
        progress: [{ message: "starting", ts: 100 }],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    expect(
      harness.container
        .querySelector("[data-testid='tool-progress']")
        ?.textContent,
    ).toContain("starting");

    // Heartbeat path: store mutates immutably, parent re-renders with
    // a new `message` ref that has an additional progress entry.
    message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "running",
        progress: [
          { message: "starting", ts: 100 },
          { message: "5s elapsed", ts: 200 },
        ],
        retryCount: 0,
      },
    ]);
    act(() => {
      harness.root.render(<ToolProgressIndicator message={message} />);
    });
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row?.textContent).toContain("5s elapsed");
    harness.unmount();
  });

  it("keeps the latest entry visible after the tool status flips to complete (spawn_only heartbeat path)", () => {
    // For spawn_only flows the foreground `tool/completed` flips the
    // chip's status to `complete` immediately on the ack, but the BG
    // task continues to append heartbeat entries. The indicator must
    // keep surfacing the latest entry — disappearing on
    // `status=complete` would hide the spawn_only liveness signal.
    const message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "complete",
        progress: [
          { message: "starting", ts: 100 },
          { message: "running plan_and_search 5s elapsed", ts: 200 },
        ],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("5s elapsed");
    harness.unmount();
  });
});

/**
 * Spinner-gating regression (2026-05-14 follow-up to commit `e8cfb94`).
 *
 * The bug observed live on mini5: a spawn_only `run_pipeline`
 * completed (server log: `spawn_only background tool completed
 * tool=run_pipeline success=true`), the chat bubble correctly
 * reflected completion in its chip-list, but the leading `Loader2`
 * icon on the `tool-progress` row kept animating because the icon was
 * rendered unconditionally — only the row's mount was gated (on
 * `progress.length > 0`), not the spinner animation itself.
 *
 * Fix: the leading icon is now selected by the owning tool call's
 * `status`:
 *   - `running`  → animated `Loader2` (`data-testid='tool-progress-spinner'`)
 *   - `complete` → static `Check` (`data-testid='tool-progress-complete-icon'`)
 *   - `error`    → static `X`     (`data-testid='tool-progress-error-icon'`)
 *
 * The owning tool call is the one whose progress entry won the highest
 * `ts` — same selection rule the row text uses, so the icon and the
 * text are always describing the SAME call (avoids the "animated icon
 * on tool A, text from tool B" mismatch that a naive `some` over all
 * tool calls would produce).
 */
describe("ToolProgressIndicator spinner gating (status-aware icon)", () => {
  it("renders the animated Loader2 spinner while the owning tool call is running", () => {
    const message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "running",
        progress: [{ message: "plan_and_search 5s elapsed", ts: 200 }],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-tool-status")).toBe("running");
    expect(
      row!.querySelector("[data-testid='tool-progress-spinner']"),
    ).not.toBeNull();
    expect(
      row!.querySelector("[data-testid='tool-progress-complete-icon']"),
    ).toBeNull();
    expect(
      row!.querySelector("[data-testid='tool-progress-error-icon']"),
    ).toBeNull();
    harness.unmount();
  });

  it("swaps the spinner for a static Check icon when the owning tool call is complete", () => {
    // Reproduces the mini5 run_pipeline observation: bubble shows
    // completion, icon must NOT animate any more.
    const message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "complete",
        progress: [
          { message: "starting", ts: 100 },
          { message: "done", ts: 200 },
        ],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-tool-status")).toBe("complete");
    // The spinner must be gone — no `Loader2` with `animate-spin`.
    expect(
      row!.querySelector("[data-testid='tool-progress-spinner']"),
    ).toBeNull();
    // Static terminal icon in its place.
    expect(
      row!.querySelector("[data-testid='tool-progress-complete-icon']"),
    ).not.toBeNull();
    // Text remains so the user sees the last activity message.
    expect(row!.textContent).toContain("done");
    harness.unmount();
  });

  it("swaps the spinner for a static X icon when the owning tool call errored", () => {
    const message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "error",
        progress: [{ message: "boom", ts: 100 }],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-tool-status")).toBe("error");
    expect(
      row!.querySelector("[data-testid='tool-progress-spinner']"),
    ).toBeNull();
    expect(
      row!.querySelector("[data-testid='tool-progress-error-icon']"),
    ).not.toBeNull();
    expect(row!.textContent).toContain("boom");
    harness.unmount();
  });

  it("transitions from animated spinner to static check across a status flip (heartbeat → complete)", () => {
    // The live mini5 sequence: heartbeats arrive with status="running"
    // (spinner ON), then `tool/completed` flips status to "complete"
    // and the BG task may still emit more heartbeats — but the icon
    // immediately stops animating because it's tied to the call's
    // status, not the existence of progress entries.
    let message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "running",
        progress: [{ message: "5s elapsed", ts: 100 }],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    {
      const row = harness.container.querySelector(
        "[data-testid='tool-progress']",
      );
      expect(row).not.toBeNull();
      expect(
        row!.querySelector("[data-testid='tool-progress-spinner']"),
      ).not.toBeNull();
    }

    // `tool/completed` → store.setToolCallStatus → status flips.
    message = makeMessage([
      {
        id: "tc-1",
        name: "run_pipeline",
        status: "complete",
        progress: [{ message: "5s elapsed", ts: 100 }],
        retryCount: 0,
      },
    ]);
    act(() => {
      harness.root.render(<ToolProgressIndicator message={message} />);
    });
    {
      const row = harness.container.querySelector(
        "[data-testid='tool-progress']",
      );
      expect(row).not.toBeNull();
      expect(
        row!.querySelector("[data-testid='tool-progress-spinner']"),
      ).toBeNull();
      expect(
        row!.querySelector("[data-testid='tool-progress-complete-icon']"),
      ).not.toBeNull();
    }
    harness.unmount();
  });

  it("ties the leading icon to the OWNING call (latest-ts call), not 'any call still running'", () => {
    // Cross-call mismatch defence: tool A still running with old
    // progress; tool B already complete with a NEWER heartbeat. The
    // row text comes from B (newer ts wins), so the icon MUST also
    // come from B — otherwise we'd render "B's last heartbeat" with
    // a Loader2 implying A's running state, which contradicts the
    // chip-list.
    const message = makeMessage([
      {
        id: "tc-a",
        name: "shell",
        status: "running",
        progress: [{ message: "still working on shell", ts: 100 }],
        retryCount: 0,
      },
      {
        id: "tc-b",
        name: "run_pipeline",
        status: "complete",
        progress: [{ message: "pipeline done", ts: 200 }],
        retryCount: 0,
      },
    ]);
    const harness = mount(<ToolProgressIndicator message={message} />);
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    // Text from B (newest ts).
    expect(row!.textContent).toContain("run_pipeline");
    expect(row!.textContent).toContain("pipeline done");
    // Icon from B's status (complete), NOT A's (running).
    expect(row!.getAttribute("data-tool-status")).toBe("complete");
    expect(
      row!.querySelector("[data-testid='tool-progress-spinner']"),
    ).toBeNull();
    expect(
      row!.querySelector("[data-testid='tool-progress-complete-icon']"),
    ).not.toBeNull();
    harness.unmount();
  });
});
