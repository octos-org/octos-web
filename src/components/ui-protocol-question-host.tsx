import { useEffect, useState } from "react";

import { eventMatchesScope } from "@/runtime/event-scope";
import { useSession } from "@/runtime/session-context";
import type { UserQuestionRequestedEvent } from "@/runtime/ui-protocol-types";

import { UiProtocolQuestionDialog } from "./ui-protocol-question-dialog";

/**
 * Mounts the multiple-choice dialog when the agent asks a structured question
 * (user_question.v1). Self-contained, mirroring `UiProtocolApprovalHost`;
 * mounted on every turn-running surface so a question never arrives without a
 * responder (which would hang the turn server-side).
 *
 * Overlapping questions are QUEUED by `question_id` (reconnect can replay
 * several pending questions, and a parallel tool batch can raise more than
 * one) — the head renders, and resolving it pops to the next rather than
 * dropping the rest.
 */
export function UiProtocolQuestionHost() {
  const { currentSessionId, historyTopic } = useSession();
  const [queue, setQueue] = useState<UserQuestionRequestedEvent[]>([]);

  useEffect(() => {
    function onQuestionRequested(e: Event) {
      const detail = (e as CustomEvent).detail as UserQuestionRequestedEvent;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      setQueue((prev) =>
        prev.some((q) => q.question_id === detail.question_id)
          ? prev
          : [...prev, detail],
      );
    }

    window.addEventListener(
      "crew:user_question_requested",
      onQuestionRequested,
    );
    return () => {
      window.removeEventListener(
        "crew:user_question_requested",
        onQuestionRequested,
      );
    };
  }, [currentSessionId, historyTopic]);

  const head = queue[0] ?? null;
  const scoped =
    head && eventMatchesScope(head, currentSessionId, historyTopic)
      ? head
      : null;

  return (
    <UiProtocolQuestionDialog
      question={scoped}
      sessionId={currentSessionId}
      topic={historyTopic}
      onResolved={() =>
        setQueue((prev) => (head ? prev.filter((q) => q !== head) : prev))
      }
    />
  );
}
