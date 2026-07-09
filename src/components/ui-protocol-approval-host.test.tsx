import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";

import { UiProtocolApprovalHost } from "./ui-protocol-approval-host";
import type { ApprovalAutoResolvedEvent } from "@/runtime/ui-protocol-types";

let scope = { currentSessionId: "sess-1", historyTopic: undefined as
  | string
  | undefined };
vi.mock("@/runtime/session-context", () => ({
  useSession: () => scope,
}));
vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => ({ respondToApproval: vi.fn() }),
}));

function fireAuto(over: Partial<ApprovalAutoResolvedEvent> = {}) {
  const detail: ApprovalAutoResolvedEvent = {
    session_id: "sess-1",
    approval_id: "a-1",
    turn_id: "t-1",
    tool_name: "shell",
    scope: "session",
    scope_match: "*",
    decision: "approve",
    ...over,
  };
  act(() => {
    window.dispatchEvent(
      new CustomEvent("crew:approval_auto_resolved", { detail }),
    );
  });
}

afterEach(() => {
  cleanup();
  scope = { currentSessionId: "sess-1", historyTopic: undefined };
});

describe("UiProtocolApprovalHost — auto-resolved toast", () => {
  it("shows Auto-approved for an approve decision", () => {
    render(<UiProtocolApprovalHost />);
    fireAuto({ decision: "approve", tool_name: "shell" });
    expect(screen.getByText("Auto-approved")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
  });

  it("shows Auto-denied for a deny decision (never mislabels a denial)", () => {
    render(<UiProtocolApprovalHost />);
    fireAuto({ decision: "deny" });
    expect(screen.getByText("Auto-denied")).toBeTruthy();
    expect(screen.queryByText("Auto-approved")).toBeNull();
  });

  it("ignores an auto-resolved event for a different session", () => {
    render(<UiProtocolApprovalHost />);
    fireAuto({ session_id: "other-session" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears the toast when the session scope rebinds", async () => {
    const { rerender } = render(<UiProtocolApprovalHost />);
    fireAuto();
    expect(screen.getByRole("status")).toBeTruthy();
    // Switch sessions — the toast must not linger into the new scope.
    scope = { currentSessionId: "sess-2", historyTopic: undefined };
    rerender(<UiProtocolApprovalHost />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
