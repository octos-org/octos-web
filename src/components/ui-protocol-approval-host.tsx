import { useEffect, useState } from "react";

import { eventMatchesScope } from "@/runtime/event-scope";
import { useSession } from "@/runtime/session-context";
import type {
  ApprovalAutoResolvedEvent,
  ApprovalRequestedEvent,
} from "@/runtime/ui-protocol-types";

import { UiProtocolApprovalDialog } from "./ui-protocol-approval-dialog";

export function UiProtocolApprovalHost() {
  const { currentSessionId, historyTopic } = useSession();
  const [approval, setApproval] = useState<ApprovalRequestedEvent | null>(null);
  // Transient banner shown when a standing scope grant auto-resolves a later
  // request (so a "for session" grant isn't invisible on subsequent commands).
  const [autoResolved, setAutoResolved] =
    useState<ApprovalAutoResolvedEvent | null>(null);
  const scopedApproval =
    approval && eventMatchesScope(approval, currentSessionId, historyTopic)
      ? approval
      : null;

  useEffect(() => {
    function onApprovalRequested(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      setApproval(detail as ApprovalRequestedEvent);
    }

    window.addEventListener("crew:approval_requested", onApprovalRequested);
    return () => {
      window.removeEventListener(
        "crew:approval_requested",
        onApprovalRequested,
      );
    };
  }, [currentSessionId, historyTopic]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    function onAutoResolved(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      setAutoResolved(detail as ApprovalAutoResolvedEvent);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setAutoResolved(null), 6000);
    }

    window.addEventListener("crew:approval_auto_resolved", onAutoResolved);
    return () => {
      window.removeEventListener("crew:approval_auto_resolved", onAutoResolved);
      if (timer) clearTimeout(timer);
    };
  }, [currentSessionId, historyTopic]);

  return (
    <>
      <UiProtocolApprovalDialog
        approval={scopedApproval}
        sessionId={currentSessionId}
        topic={historyTopic}
        onResolved={() => setApproval(null)}
      />
      {autoResolved && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-[10px] border border-border bg-surface-container px-4 py-2 text-sm text-muted shadow-lg"
        >
          <span className="text-text-strong">Auto-approved</span>
          {" · "}
          <span className="font-mono text-text">{autoResolved.tool_name}</span>
          {" · "}
          {autoResolved.scope} grant
        </div>
      )}
    </>
  );
}
