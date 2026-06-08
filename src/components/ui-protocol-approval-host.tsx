import { useEffect, useState } from "react";

import { eventMatchesScope } from "@/runtime/event-scope";
import { useSession } from "@/runtime/session-context";
import type { ApprovalRequestedEvent } from "@/runtime/ui-protocol-types";

import { UiProtocolApprovalDialog } from "./ui-protocol-approval-dialog";

export function UiProtocolApprovalHost() {
  const { currentSessionId, historyTopic } = useSession();
  const [approval, setApproval] = useState<ApprovalRequestedEvent | null>(null);
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

  return (
    <UiProtocolApprovalDialog
      approval={scopedApproval}
      sessionId={currentSessionId}
      topic={historyTopic}
      onResolved={() => setApproval(null)}
    />
  );
}
