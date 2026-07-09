/**
 * SessionAutonomyChip tests — visibility, pause/resume, two-click
 * delete/clear, scope discipline.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const controlLoop = vi.fn();
const clearGoal = vi.fn();
vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => ({ controlLoop, clearGoal }),
}));

import { SessionAutonomyChip } from "./session-autonomy-chip";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";
import type { UiLoopRecord } from "@/runtime/ui-protocol-types";
import {
  __resetAutonomyStoreForTest,
  getAutonomyState,
  replaceLoops,
  setGoal,
} from "@/store/autonomy-store";

const SESSION = "sess-autonomy-chip";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: SESSION,
    historyTopic: undefined,
    currentSessionTitle: "",
    currentSessionStats: null,
    initialMessages: [],
    activeTaskOnServer: false,
    queueMode: null,
    adaptiveMode: null,
    setServerTaskActive: () => {},
    renameSession: () => {},
    updateSessionStats: () => {},
    switchSession: () => {},
    goBack: async () => false,
    createSession: () => SESSION,
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
  };
}

function mountChip(): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionAutonomyChip />
      </SessionContext.Provider>,
    );
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

function makeLoop(
  partial: Partial<UiLoopRecord> & { loop_id: string },
): UiLoopRecord {
  return {
    session_id: SESSION,
    prompt: "poll the deploy queue",
    mode: "interval",
    interval_seconds: 300,
    status: "active",
    expires_at_ms: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...partial,
  };
}

function q<T extends Element>(h: MountedHarness, sel: string): T | null {
  return h.container.querySelector(sel) as T | null;
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  __resetAutonomyStoreForTest();
  controlLoop.mockReset();
  clearGoal.mockReset();
});

describe("SessionAutonomyChip", () => {
  it("renders nothing without live loops or goal", () => {
    const harness = mountChip();
    expect(q(harness, '[data-testid="session-autonomy-chip"]')).toBeNull();
    // Terminal loops don't count as live.
    replaceLoops(SESSION, [makeLoop({ loop_id: "l1", status: "completed" })]);
    act(() => {});
    expect(q(harness, '[data-testid="session-autonomy-chip"]')).toBeNull();
    harness.unmount();
  });

  it("treats an elapsed expires_at_ms as terminal even when status is active (codex #263 P2)", () => {
    // The backend enforces expiry by SKIPPING due loops — it does not
    // necessarily rewrite status or emit loop/completed, so an
    // elapsed-but-"active" row must not pin the chip with dead
    // controls.
    replaceLoops(SESSION, [
      makeLoop({ loop_id: "l-exp", expires_at_ms: Date.now() - 1_000 }),
    ]);
    const harness = mountChip();
    expect(q(harness, '[data-testid="session-autonomy-chip"]')).toBeNull();
    // A live loop alongside it counts alone.
    act(() => {
      replaceLoops(SESSION, [
        makeLoop({ loop_id: "l-exp", expires_at_ms: Date.now() - 1_000 }),
        makeLoop({ loop_id: "l-live", expires_at_ms: Date.now() + 60_000 }),
      ]);
    });
    const chip = q<HTMLButtonElement>(
      harness,
      '[data-testid="session-autonomy-chip"]',
    );
    expect(chip?.getAttribute("data-loop-count")).toBe("1");
    harness.unmount();
  });

  it("pauses an active loop and merges the returned record", async () => {
    controlLoop.mockResolvedValue({
      ok: true,
      status: "paused",
      loop: makeLoop({ loop_id: "l1", status: "paused" }),
    });
    replaceLoops(SESSION, [makeLoop({ loop_id: "l1" })]);
    const harness = mountChip();
    const chip = q<HTMLButtonElement>(
      harness,
      '[data-testid="session-autonomy-chip"]',
    );
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-loop-count")).toBe("1");
    act(() => chip?.click());
    const toggle = q<HTMLButtonElement>(
      harness,
      '[data-testid="loop-toggle-l1"]',
    );
    expect(toggle?.textContent).toBe("Pause");
    await act(async () => {
      toggle?.click();
    });
    expect(controlLoop).toHaveBeenCalledWith("l1", "pause");
    expect(getAutonomyState(SESSION).loops[0]?.status).toBe("paused");
    harness.unmount();
  });

  it("resumes a paused loop", async () => {
    controlLoop.mockResolvedValue({
      ok: true,
      status: "active",
      loop: makeLoop({ loop_id: "l1", status: "active" }),
    });
    replaceLoops(SESSION, [makeLoop({ loop_id: "l1", status: "paused" })]);
    const harness = mountChip();
    act(() =>
      q<HTMLButtonElement>(
        harness,
        '[data-testid="session-autonomy-chip"]',
      )?.click(),
    );
    const toggle = q<HTMLButtonElement>(
      harness,
      '[data-testid="loop-toggle-l1"]',
    );
    expect(toggle?.textContent).toBe("Resume");
    await act(async () => {
      toggle?.click();
    });
    expect(controlLoop).toHaveBeenCalledWith("l1", "resume");
    harness.unmount();
  });

  it("requires a confirming second click to delete a loop", async () => {
    controlLoop.mockResolvedValue({ ok: true, status: "deleted" });
    replaceLoops(SESSION, [makeLoop({ loop_id: "l1" })]);
    const harness = mountChip();
    act(() =>
      q<HTMLButtonElement>(
        harness,
        '[data-testid="session-autonomy-chip"]',
      )?.click(),
    );
    const del = q<HTMLButtonElement>(
      harness,
      '[data-testid="loop-delete-l1"]',
    );
    act(() => del?.click());
    expect(controlLoop).not.toHaveBeenCalled();
    expect(
      q<HTMLButtonElement>(harness, '[data-testid="loop-delete-l1"]')
        ?.textContent,
    ).toContain("Confirm");
    await act(async () => {
      q<HTMLButtonElement>(
        harness,
        '[data-testid="loop-delete-l1"]',
      )?.click();
    });
    expect(controlLoop).toHaveBeenCalledWith("l1", "delete");
    // Optimistic removal → chip disappears (no other live state).
    expect(q(harness, '[data-testid="session-autonomy-chip"]')).toBeNull();
    harness.unmount();
  });

  it("shows and clears the goal with a confirm", async () => {
    clearGoal.mockResolvedValue(null);
    setGoal(SESSION, {
      goal_id: "g1",
      objective: "keep the fleet green",
      status: "active",
      token_budget: 100000,
      tokens_used: 42,
      time_used_seconds: 60,
      created_at_ms: 1,
      updated_at_ms: 1,
    });
    const harness = mountChip();
    const chip = q<HTMLButtonElement>(
      harness,
      '[data-testid="session-autonomy-chip"]',
    );
    expect(chip?.getAttribute("data-has-goal")).toBe("true");
    act(() => chip?.click());
    expect(q(harness, '[data-testid="goal-row"]')?.textContent).toContain(
      "keep the fleet green",
    );
    const clear = q<HTMLButtonElement>(harness, '[data-testid="goal-clear"]');
    act(() => clear?.click());
    expect(clearGoal).not.toHaveBeenCalled();
    await act(async () => {
      q<HTMLButtonElement>(harness, '[data-testid="goal-clear"]')?.click();
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
    expect(getAutonomyState(SESSION).goal).toBe(null);
    harness.unmount();
  });
});
