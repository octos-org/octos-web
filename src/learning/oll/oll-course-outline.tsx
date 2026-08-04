import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ListTree,
  Play,
} from "lucide-react";
import type { PlaybackOutlineBeat, PlaybackOutlineStep } from "octos-lesson-language/player";
import { unlockAudio } from "@/home/voice/audio-playback";
import type { OllLessonRuntimeController } from "./use-oll-lesson-runtime";

function itemState(
  item: Pick<PlaybackOutlineStep | PlaybackOutlineBeat, "id" | "end_cursor">,
  currentId: string | undefined,
  cursor: number,
): "current" | "completed" | "upcoming" {
  if (item.id === currentId) return "current";
  return cursor >= item.end_cursor ? "completed" : "upcoming";
}

export function OllCourseOutline({
  runtime,
}: {
  runtime: OllLessonRuntimeController;
}) {
  const [open, setOpen] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const currentStep = useMemo(
    () => runtime.outline
      .flatMap((topic) => topic.steps)
      .find((step) => step.id === runtime.currentStepId),
    [runtime.currentStepId, runtime.outline],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  const select = (action: () => void) => {
    unlockAudio();
    action();
    setOpen(false);
  };

  return (
    <div className="oll-course-outline" ref={rootRef}>
      <button
        type="button"
        className="oll-course-outline-trigger"
        onClick={() => {
          if (!open) runtime.pause();
          setOpen((current) => !current);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="打开本课目录"
        title="本课目录"
      >
        <ListTree size={15} />
        <span className="oll-course-outline-trigger-copy">
          <small>本课目录</small>
          <b>{currentStep?.title ?? "选择讲解步骤"}</b>
        </span>
        <ChevronDown size={14} />
      </button>

      {open ? (
        <div
          className="oll-course-outline-panel"
          role="dialog"
          aria-label="本课目录"
        >
          <div className="oll-course-outline-heading">
            <div>
              <small>COURSE OUTLINE</small>
              <h2>本课目录</h2>
            </div>
            <span>{runtime.outline.reduce(
              (count, topic) => count + topic.steps.length,
              0,
            )} 个步骤</span>
          </div>

          <nav className="oll-course-outline-scroll" aria-label="课程步骤">
            {runtime.outline.map((topic, topicIndex) => (
              <section className="oll-course-topic" key={topic.id}>
                <header>
                  <span>{String(topicIndex + 1).padStart(2, "0")}</span>
                  <h3>{topic.title}</h3>
                </header>
                <ol>
                  {topic.steps.map((step, stepIndex) => {
                    const state = itemState(
                      step,
                      runtime.currentStepId,
                      runtime.cursor,
                    );
                    const expanded = expandedSteps.has(step.id);
                    return (
                      <li
                        className={`oll-course-step is-${state}`}
                        key={step.id}
                      >
                        <div className="oll-course-step-row">
                          <button
                            type="button"
                            className="oll-course-step-main"
                            onClick={() => select(() => runtime.viewStep(step.id))}
                            aria-current={state === "current" ? "step" : undefined}
                            aria-label={`查看步骤：${step.title}`}
                          >
                            <span className="oll-course-step-status">
                              {state === "completed"
                                ? <Check size={12} />
                                : stepIndex + 1}
                            </span>
                            <span>{step.title}</span>
                          </button>
                          {step.beats.length > 0 ? (
                            <button
                              type="button"
                              className="oll-course-expand"
                              onClick={() => toggleStep(step.id)}
                              aria-label={`${expanded ? "收起" : "展开"}${step.title}的讲解片段`}
                              aria-expanded={expanded}
                            >
                              {expanded
                                ? <ChevronDown size={14} />
                                : <ChevronRight size={14} />}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="oll-course-play"
                            onClick={() => select(() => runtime.playStep(step.id))}
                            aria-label={`从步骤开始播放：${step.title}`}
                          >
                            <Play size={12} fill="currentColor" />
                          </button>
                        </div>
                        {expanded ? (
                          <ol className="oll-course-beats">
                            {step.beats.map((beat, beatIndex) => {
                              const beatState = itemState(
                                beat,
                                runtime.currentBeatId,
                                runtime.cursor,
                              );
                              return (
                                <li className={`is-${beatState}`} key={beat.id}>
                                  <button
                                    type="button"
                                    className="oll-course-beat-main"
                                    onClick={() => select(() => runtime.viewBeat(beat.id))}
                                    aria-current={
                                      beatState === "current" ? "step" : undefined
                                    }
                                    aria-label={`查看讲解片段：${beat.title}`}
                                  >
                                    <span>{beatIndex + 1}</span>
                                    <b>{beat.title}</b>
                                  </button>
                                  <button
                                    type="button"
                                    className="oll-course-beat-play"
                                    onClick={() => select(() => runtime.playBeat(beat.id))}
                                    aria-label={`从讲解片段开始播放：${beat.title}`}
                                  >
                                    <Play size={10} fill="currentColor" />
                                  </button>
                                </li>
                              );
                            })}
                          </ol>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </nav>
          <p className="oll-course-outline-help">
            点击查看完成画面，使用播放按钮从该段重新讲解
          </p>
        </div>
      ) : null}
    </div>
  );
}
