import { useEffect, useState } from "react";

import { eventMatchesScope } from "@/runtime/event-scope";
import { useSession } from "@/runtime/session-context";
import type { UserQuestionRequestedEvent } from "@/runtime/ui-protocol-types";

import { UiProtocolQuestionDialog } from "./ui-protocol-question-dialog";

/**
 * Mounts the multiple-choice dialog when the agent asks a structured question
 * (user_question.v1). Self-contained, mirroring `UiProtocolApprovalHost`:
 * listens for the `crew:user_question_requested` DOM event, scopes it to the
 * active session/topic, and clears on resolve.
 */
export function UiProtocolQuestionHost() {
  const { currentSessionId, historyTopic } = useSession();
  const [question, setQuestion] =
    useState<UserQuestionRequestedEvent | null>(null);
  const scoped =
    question && eventMatchesScope(question, currentSessionId, historyTopic)
      ? question
      : null;

  useEffect(() => {
    function onQuestionRequested(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      setQuestion(detail as UserQuestionRequestedEvent);
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

  return (
    <UiProtocolQuestionDialog
      question={scoped}
      sessionId={currentSessionId}
      topic={historyTopic}
      onResolved={() => setQuestion(null)}
    />
  );
}
