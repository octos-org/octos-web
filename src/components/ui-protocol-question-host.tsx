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

  // Render the first queued question that matches the ACTIVE scope, not just
  // queue[0]: a question queued under a now-inactive session/topic must not
  // sit in front and block newer in-scope questions (codex review). Stale
  // items are kept, not pruned — the question is still pending server-side, so
  // it should re-appear if the user switches back to that scope.
  const head =
    queue.find((q) =>
      eventMatchesScope(q, currentSessionId, historyTopic),
    ) ?? null;

  return (
    <UiProtocolQuestionDialog
      question={head}
      sessionId={currentSessionId}
      topic={historyTopic}
      onResolved={() =>
        setQueue((prev) => (head ? prev.filter((q) => q !== head) : prev))
      }
    />
  );
}
