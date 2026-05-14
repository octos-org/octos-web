/**
 * `useModeState()` tests (Wave4-A codex review fix).
 *
 * The hook scopes `crew:mode_update` events by `sessionId` so a late
 * RouterStatus push from a prior session can't bleed into the current
 * session's pill. Switching to a different session id also resets the
 * mode state.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useModeState } from "./session-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Captured {
  current: ReturnType<typeof useModeState>;
}

function Harness({
  sessionId,
  out,
}: {
  sessionId: string;
  out: Captured;
}) {
  const state = useModeState(sessionId);
  out.current = state;
  return null;
}

interface MountedHarness {
  unmount: () => void;
  rerender: (sessionId: string) => void;
}

function mount(initialSessionId: string, out: Captured): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Harness sessionId={initialSessionId} out={out} />);
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    rerender: (sessionId) => {
      act(() => {
        root.render(<Harness sessionId={sessionId} out={out} />);
      });
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useModeState", () => {
  it("accepts crew:mode_update events whose sessionId matches", () => {
    const out: Captured = {
      current: { queueMode: null, adaptiveMode: null },
    };
    const h = mount("A", out);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:mode_update", {
            detail: { sessionId: "A", adaptiveMode: "hedge" },
          }),
        );
      });
      expect(out.current.adaptiveMode).toBe("hedge");
    } finally {
      h.unmount();
    }
  });

  it("drops crew:mode_update events for a different sessionId", () => {
    const out: Captured = {
      current: { queueMode: null, adaptiveMode: null },
    };
    const h = mount("A", out);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:mode_update", {
            detail: { sessionId: "OTHER", adaptiveMode: "hedge" },
          }),
        );
      });
      expect(out.current.adaptiveMode).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it("resets adaptive/queue mode when the sessionId changes", () => {
    const out: Captured = {
      current: { queueMode: null, adaptiveMode: null },
    };
    const h = mount("A", out);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:mode_update", {
            detail: { sessionId: "A", adaptiveMode: "lane" },
          }),
        );
      });
      expect(out.current.adaptiveMode).toBe("lane");
      // Switch to session B → mode should reset.
      h.rerender("B");
      expect(out.current.adaptiveMode).toBeNull();
    } finally {
      h.unmount();
    }
  });
});
