import { useEffect, useMemo, useState } from "react";

import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import type {
  UserQuestionAnswer,
  UserQuestionRequestedEvent,
} from "@/runtime/ui-protocol-types";

interface UiProtocolQuestionDialogProps {
  question: UserQuestionRequestedEvent | null;
  sessionId: string;
  topic?: string;
  onResolved: () => void;
}

const OTHER = "__other__";

/**
 * Prominent multiple-choice dialog for `ask_user_question` (user_question.v1).
 * Replaces the old typed "A) … B) …" text fallback: each option is a clickable
 * card, a free-text "Other" is always offered, and multi-question requests are
 * walked one at a time. Answers are collected per question and submitted via
 * `user_question/respond`.
 */
export function UiProtocolQuestionDialog({
  question,
  sessionId,
  topic,
  onResolved,
}: UiProtocolQuestionDialogProps) {
  const questions = useMemo(() => question?.questions ?? [], [question]);
  const questionKey = question?.question_id ?? null;

  const [active, setActive] = useState(0);
  // Per-question state: chosen option labels (Set) + free-text.
  const [chosen, setChosen] = useState<Record<number, Set<string>>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset all state when a new question event arrives.
  useEffect(() => {
    setActive(0);
    setChosen({});
    setFreeText({});
    setSubmitting(false);
    setError(null);
  }, [questionKey]);

  if (!question || questions.length === 0) return null;

  const q = questions[Math.min(active, questions.length - 1)];
  const multi = q.multi_select;
  const picks = chosen[active] ?? new Set<string>();
  const otherPicked = picks.has(OTHER);
  const otherText = freeText[active] ?? "";
  const isLast = active >= questions.length - 1;
  const answered =
    picks.size > 0 && (!otherPicked || otherText.trim().length > 0);

  function toggle(label: string) {
    setError(null);
    setChosen((prev) => {
      const next = new Set(multi ? (prev[active] ?? new Set<string>()) : []);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return { ...prev, [active]: next };
    });
  }

  function buildAnswers(): UserQuestionAnswer[] {
    return questions.map((_, i) => {
      const set = chosen[i] ?? new Set<string>();
      const labels = [...set].filter((l) => l !== OTHER);
      const ft = (freeText[i] ?? "").trim();
      const answer: UserQuestionAnswer = { selected_labels: labels };
      if (set.has(OTHER) && ft) answer.free_text = ft;
      return answer;
    });
  }

  async function submit() {
    if (isLast) {
      setError(null);
      setSubmitting(true);
      try {
        const bridge = getActiveBridge(sessionId, topic);
        if (!bridge) throw new Error("UI Protocol bridge is not connected");
        const result = await bridge.respondToUserQuestion(
          question!.question_id,
          buildAnswers(),
        );
        if (!result.accepted) {
          throw new Error(result.status || "answer was rejected");
        }
        onResolved();
      } catch (err) {
        setError(err instanceof Error ? err.message : "could not send answer");
      } finally {
        setSubmitting(false);
      }
    } else {
      setActive((a) => a + 1);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ui-protocol-question-title"
    >
      <div className="glass-panel flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-[16px] shadow-lg">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="shell-kicker">Your input</div>
            {questions.length > 1 && (
              <div className="text-xs font-medium tabular-nums text-muted">
                {active + 1} / {questions.length}
              </div>
            )}
          </div>
          <h2
            id="ui-protocol-question-title"
            className="mt-1 text-lg font-semibold text-text-strong"
          >
            {q.question || question.title}
          </h2>
          {q.header && (
            <p className="mt-1 text-sm text-muted">{q.header}</p>
          )}
        </div>

        <div className="flex-1 space-y-2 overflow-auto px-5 py-4">
          {question.body && active === 0 && (
            <p className="mb-3 whitespace-pre-wrap text-sm leading-6 text-muted">
              {question.body}
            </p>
          )}

          {q.options.map((opt) => {
            const selected = picks.has(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                aria-pressed={selected}
                onClick={() => toggle(opt.label)}
                className={
                  "flex w-full items-start gap-3 rounded-[12px] border px-4 py-3 text-left transition-colors " +
                  (selected
                    ? "border-accent bg-accent/10"
                    : "border-border bg-surface-container hover:border-accent/50 hover:bg-surface-container/70")
                }
              >
                <span
                  aria-hidden="true"
                  className={
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border " +
                    (multi ? "rounded-[6px]" : "rounded-full") +
                    " " +
                    (selected
                      ? "border-accent bg-accent text-white"
                      : "border-muted/60")
                  }
                >
                  {selected && (multi ? "✓" : "●")}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-strong">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="mt-0.5 block text-sm leading-5 text-muted">
                      {opt.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {q.allow_free_text && (
            <div
              className={
                "rounded-[12px] border px-4 py-3 transition-colors " +
                (otherPicked
                  ? "border-accent bg-accent/10"
                  : "border-border bg-surface-container")
              }
            >
              <button
                type="button"
                aria-pressed={otherPicked}
                onClick={() => toggle(OTHER)}
                className="flex w-full items-center gap-3 text-left"
              >
                <span
                  aria-hidden="true"
                  className={
                    "flex h-5 w-5 shrink-0 items-center justify-center border " +
                    (multi ? "rounded-[6px]" : "rounded-full") +
                    " " +
                    (otherPicked
                      ? "border-accent bg-accent text-white"
                      : "border-muted/60")
                  }
                >
                  {otherPicked && (multi ? "✓" : "●")}
                </span>
                <span className="text-sm font-medium text-text-strong">
                  Other…
                </span>
              </button>
              {otherPicked && (
                <textarea
                  autoFocus
                  rows={2}
                  value={otherText}
                  onChange={(e) =>
                    setFreeText((prev) => ({ ...prev, [active]: e.target.value }))
                  }
                  placeholder="Type your answer"
                  className="mt-2 w-full resize-none rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              )}
            </div>
          )}

          {error && (
            <div className="rounded-[10px] border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-4">
          <span className="text-xs text-muted">
            {multi ? "Choose one or more" : "Choose one"}
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!answered || submitting}
            className="rounded-[10px] bg-accent px-5 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-50"
          >
            {submitting ? "Sending…" : isLast ? "Submit" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
