import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/runtime/ui-protocol-send", () => ({
  sendMessage: vi.fn(),
}));

import { SessionContext, type SessionContextValue } from "@/runtime/session-context";
import { SessionList } from "./session-list";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: "web-current",
    historyTopic: undefined,
    currentSessionTitle: "Current",
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
    createSession: () => "web-new",
    branchSession: async () => "web-new",
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
    ...overrides,
  };
}

function mount(ctx: SessionContextValue): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={ctx}>
        <SessionList />
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

const mounted: MountedHarness[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

const SESSIONS = [
  { id: "web-111", message_count: 4, title: "research thread" },
  { id: "web-222", message_count: 2, title: "second thread" },
];

describe("SessionList fork action", () => {
  it("forks the addressed row via branchSession", async () => {
    let resolveFork: (id: string) => void = () => {};
    const branchSession = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const harness = mount(
      makeSessionCtx({ sessions: SESSIONS, branchSession }),
    );
    mounted.push(harness);

    const forkButtons = harness.container.querySelectorAll(
      '[data-testid="session-fork-button"]',
    );
    expect(forkButtons.length).toBe(2);

    await act(async () => {
      (forkButtons[1] as HTMLButtonElement).click();
    });
    expect(branchSession).toHaveBeenCalledWith("web-222");

    // While the fork is in flight EVERY fork button is disabled (one
    // fork at a time) and the addressed row shows a spinner.
    const busyButtons = harness.container.querySelectorAll(
      '[data-testid="session-fork-button"]',
    );
    expect(
      Array.from(busyButtons).every(
        (b) => (b as HTMLButtonElement).disabled,
      ),
    ).toBe(true);

    await act(async () => {
      resolveFork("web-child");
    });
    const settled = harness.container.querySelectorAll(
      '[data-testid="session-fork-button"]',
    );
    expect(
      Array.from(settled).some((b) => (b as HTMLButtonElement).disabled),
    ).toBe(false);
  });

  it("survives a fork failure without wedging the buttons", async () => {
    const branchSession = vi.fn(async () => {
      throw new Error("fork refused");
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const harness = mount(
      makeSessionCtx({ sessions: SESSIONS, branchSession }),
    );
    mounted.push(harness);

    const forkButton = harness.container.querySelector(
      '[data-testid="session-fork-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      forkButton.click();
    });

    expect(branchSession).toHaveBeenCalledTimes(1);
    const after = harness.container.querySelector(
      '[data-testid="session-fork-button"]',
    ) as HTMLButtonElement;
    expect(after.disabled).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
