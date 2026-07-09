import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

import { UiProtocolApprovalDialog } from "./ui-protocol-approval-dialog";
import type { ApprovalRequestedEvent } from "@/runtime/ui-protocol-types";

const respondToApproval = vi.fn();
vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => ({ respondToApproval }),
}));

function ev(
  over: Partial<ApprovalRequestedEvent> = {},
): ApprovalRequestedEvent {
  return {
    session_id: "sess-1",
    approval_id: "appr-1",
    turn_id: "turn-1",
    tool_name: "shell",
    title: "Approve command",
    body: "Run command: sudo make install",
    approval_scope: "request",
    ...over,
  };
}

afterEach(() => {
  cleanup();
  respondToApproval.mockReset();
});

describe("UiProtocolApprovalDialog", () => {
  it("renders Deny / Approve for session / Approve", () => {
    render(
      <UiProtocolApprovalDialog
        approval={ev()}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve for session" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("plain Approve keeps the server-sent scope (request)", async () => {
    respondToApproval.mockResolvedValue({ accepted: true });
    const onResolved = vi.fn();
    render(
      <UiProtocolApprovalDialog
        approval={ev()}
        sessionId="sess-1"
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith(
        "appr-1",
        "approve",
        "request",
      ),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it("Approve for session widens the scope to session", async () => {
    respondToApproval.mockResolvedValue({ accepted: true });
    render(
      <UiProtocolApprovalDialog
        approval={ev()}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve for session" }),
    );
    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith(
        "appr-1",
        "approve",
        "session",
      ),
    );
  });

  it("Deny sends deny with the server scope", async () => {
    respondToApproval.mockResolvedValue({ accepted: true });
    render(
      <UiProtocolApprovalDialog
        approval={ev()}
        sessionId="sess-1"
        onResolved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith(
        "appr-1",
        "deny",
        "request",
      ),
    );
  });

  it("surfaces a rejected response as an error and does not resolve", async () => {
    respondToApproval.mockResolvedValue({
      accepted: false,
      status: "scope not allowed",
    });
    const onResolved = vi.fn();
    render(
      <UiProtocolApprovalDialog
        approval={ev()}
        sessionId="sess-1"
        onResolved={onResolved}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve for session" }),
    );
    await waitFor(() =>
      expect(screen.getByText("scope not allowed")).toBeTruthy(),
    );
    expect(onResolved).not.toHaveBeenCalled();
  });
});
