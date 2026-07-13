import { useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, RotateCcw, Shuffle, X } from "lucide-react";

import { MarkdownContent } from "@/components/markdown-renderer";
import {
  parseFlashcardsMarkdown,
  parseQuizMarkdown,
  shuffleFlashcards,
  type Flashcard,
} from "./study-asset-parsers";

function FallbackMarkdown({ text, label }: { text: string; label: string }) {
  return (
    <div className="h-full overflow-y-auto p-4">
      <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-600">
        {label} could not be parsed as interactive content. Showing the original document.
      </p>
      <MarkdownContent text={text} className="text-sm" />
    </div>
  );
}

export function QuizViewer({ text }: { text: string }) {
  const quiz = useMemo(() => parseQuizMarkdown(text), [text]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  if (!quiz) return <FallbackMarkdown text={text} label="Quiz" />;
  const question = quiz.questions[index];
  const move = (next: number) => {
    setIndex(next);
    setRevealed(false);
    setSelection(null);
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{quiz.title}</h2>
        <span className="text-xs text-muted">{index + 1} / {quiz.questions.length}</span>
      </div>
      <article className="studio-card flex min-h-[15rem] flex-col rounded-2xl p-4">
        <h3 className="mb-4 text-sm font-medium">{question.question}</h3>
        {question.choices.length > 0 && (
          <div className="mb-4 grid gap-2">
            {question.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                className={`rounded-xl border p-3 text-left text-xs ${selection === choice ? "border-accent bg-accent/5" : ""}`}
                onClick={() => setSelection(choice)}
              >
                {choice}
              </button>
            ))}
          </div>
        )}
        {revealed ? (
          <div className="mt-auto rounded-xl bg-surface-strong p-3 text-xs">
            <p className="font-medium">Answer: {question.answer}</p>
            <p className="mt-2 text-muted">{question.explanation}</p>
          </div>
        ) : (
          <button type="button" className="studio-button-primary mt-auto h-9 px-3 text-xs" onClick={() => setRevealed(true)}>
            Show answer
          </button>
        )}
      </article>
      <div className="mt-4 flex justify-between gap-2">
        <button type="button" className="studio-ghost-button p-2" aria-label="Previous question" disabled={index === 0} onClick={() => move(index - 1)}><ChevronLeft size={16} /></button>
        <button type="button" className="studio-ghost-button p-2" aria-label="Next question" disabled={index === quiz.questions.length - 1} onClick={() => move(index + 1)}><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}

export function FlashcardsViewer({ text }: { text: string }) {
  const parsed = useMemo(() => parseFlashcardsMarkdown(text), [text]);
  const [cards, setCards] = useState<Flashcard[]>(() => parsed?.cards ?? []);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [got, setGot] = useState(0);
  const [missed, setMissed] = useState(0);
  if (!parsed || cards.length === 0) return <FallbackMarkdown text={text} label="Flashcards" />;
  const card = cards[index];
  const advance = () => {
    setIndex((value) => (value + 1) % cards.length);
    setFlipped(false);
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{parsed.title}</h2>
        <button
          type="button"
          className="studio-ghost-button p-2"
          aria-label="Shuffle cards"
          onClick={() => {
            setCards((values) => shuffleFlashcards(values));
            setIndex(0);
            setFlipped(false);
          }}
        ><Shuffle size={15} /></button>
      </div>
      <p className="mb-3 text-xs text-muted" aria-label={`${got} got it · ${missed} missed`}>{index + 1} / {cards.length} · {got} got it · {missed} missed</p>
      <button
        type="button"
        className="studio-card flex min-h-[16rem] flex-1 items-center justify-center rounded-2xl p-6 text-center"
        aria-label="Flip card"
        onClick={() => setFlipped((value) => !value)}
      >
        <span className="text-base font-medium">{flipped ? card.back : card.front}</span>
      </button>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="studio-ghost-button flex items-center justify-center gap-2 p-2 text-xs" aria-label="Missed it" onClick={() => { setMissed((value) => value + 1); advance(); }}><X size={15} /> Missed it</button>
        <button type="button" className="studio-button-primary flex items-center justify-center gap-2 p-2 text-xs" aria-label="Got it" onClick={() => { setGot((value) => value + 1); advance(); }}><Check size={15} /> Got it</button>
      </div>
      <button type="button" className="mt-2 flex items-center justify-center gap-2 text-xs text-muted" onClick={() => { setGot(0); setMissed(0); setIndex(0); setFlipped(false); }}><RotateCcw size={13} /> Reset progress</button>
    </div>
  );
}

export function ReportViewer({ text }: { text: string }) {
  const reportRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(() => text.split("\n")
    .flatMap((line) => {
      const match = line.match(/^#{2,3}\s+(.+)$/);
      return match ? [match[1].trim()] : [];
    })
    .map((label, index) => ({ label, index })), [text]);
  return (
    <div ref={reportRef} className="flex h-full min-h-0 flex-col overflow-y-auto">
      {headings.length > 0 && (
        <nav className="shrink-0 border-b p-3" aria-label="Report contents">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Contents</p>
          <div className="flex flex-wrap gap-2">
            {headings.map((heading) => (
              <button
                key={`${heading.index}:${heading.label}`}
                type="button"
                className="rounded-full border px-2.5 py-1 text-[11px]"
                onClick={() => {
                  const target = reportRef.current
                    ?.querySelectorAll("h2, h3")
                    .item(heading.index);
                  target?.scrollIntoView({ block: "start", behavior: "smooth" });
                }}
              >{heading.label}</button>
            ))}
          </div>
        </nav>
      )}
      <MarkdownContent text={text} className="min-h-full p-4 text-sm" />
    </div>
  );
}
