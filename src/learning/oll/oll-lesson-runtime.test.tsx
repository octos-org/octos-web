import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import geometryLessonSource from "./fixtures/geometry-auxiliary-line-v2.canonical.jsonl?raw";
import type { CanonicalEvent } from "octos-lesson-language";
import { OllLessonBoard } from "./oll-lesson-runtime";
import { useOllLessonRuntime } from "./use-oll-lesson-runtime";

function RuntimeProbe() {
  const runtime = useOllLessonRuntime({
    source: geometryLessonSource,
    storageKey: "oll-runtime-test",
  });
  if (!runtime) return null;
  return (
    <div style={{ width: 1200, height: 800 }}>
      <span data-testid="progress">
        {runtime.cursor}/{runtime.totalOperations}
      </span>
      <button type="button" onClick={runtime.nextBeat}>下一 Beat</button>
      <OllLessonBoard runtime={runtime} />
    </div>
  );
}

function ReviewRuntimeProbe() {
  const runtime = useOllLessonRuntime({
    source: geometryLessonSource,
    storageKey: "oll-review-runtime-test",
    startAtEnd: true,
  });
  if (!runtime) return null;
  return (
    <div>
      <span data-testid="review-progress">
        {runtime.cursor}/{runtime.totalOperations}
      </span>
      <span data-testid="review-playing">{String(runtime.playing)}</span>
      <OllLessonBoard runtime={runtime} />
    </div>
  );
}

function OutlineRuntimeProbe() {
  const runtime = useOllLessonRuntime({
    source: geometryLessonSource,
    storageKey: "oll-outline-runtime-test",
    startAtEnd: true,
    topics: [{
      id: "geometry",
      title: "几何证明",
      stepIds: geometryEvents.flatMap((event) =>
        event.step ? [event.step.id] : [],
      ),
    }],
  });
  if (!runtime) return null;
  const firstStep = runtime.outline[0]?.steps[0];
  return (
    <div>
      <span data-testid="outline-progress">
        {runtime.cursor}/{runtime.totalOperations}
      </span>
      <span data-testid="outline-topic">{runtime.outline[0]?.title}</span>
      <span data-testid="outline-current">{runtime.currentStepId}</span>
      <button
        type="button"
        onClick={() => firstStep && runtime.viewStep(firstStep.id)}
      >
        查看第一步
      </button>
      <OllLessonBoard runtime={runtime} />
    </div>
  );
}

const geometryEvents = geometryLessonSource
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CanonicalEvent);

function IncrementalRuntimeProbe() {
  const runtime = useOllLessonRuntime({
    source: JSON.stringify(geometryEvents[0]),
    storageKey: "oll-incremental-runtime-test",
    incremental: true,
  });
  if (!runtime) return null;
  return (
    <div style={{ width: 1200, height: 800 }}>
      <span data-testid="stream-status">{runtime.status}</span>
      <span data-testid="stream-total">{runtime.totalOperations}</span>
      <button type="button" onClick={runtime.nextBeat}>推进增量课程</button>
      <button type="button" onClick={() => runtime.appendEvents([geometryEvents[1]!])}>追加课程步骤</button>
      <OllLessonBoard runtime={runtime} />
    </div>
  );
}

function IncrementalReviewRuntimeProbe() {
  const runtime = useOllLessonRuntime({
    source: JSON.stringify(geometryEvents[0]),
    storageKey: "oll-incremental-review-runtime-test",
    incremental: true,
    startAtEnd: true,
  });
  if (!runtime) return null;
  return (
    <div>
      <span data-testid="incremental-review-status">{runtime.status}</span>
      <span data-testid="incremental-review-progress">
        {runtime.cursor}/{runtime.totalOperations}
      </span>
      <span data-testid="incremental-review-playing">
        {String(runtime.playing)}
      </span>
      <button
        type="button"
        onClick={() => runtime.appendEvents(geometryEvents.slice(1, -1))}
      >
        恢复历史课程
      </button>
      <OllLessonBoard runtime={runtime} />
    </div>
  );
}

describe("OLL lesson Runtime integration", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("plays Canonical Beats without replacing existing board nodes", () => {
    render(<RuntimeProbe />);

    fireEvent.click(screen.getByRole("button", { name: "下一 Beat" }));

    expect(screen.getByTestId("progress").textContent).not.toMatch(/^0\//);
    const board = screen.getByTestId("oll-lesson-board");
    expect(board.querySelectorAll(".board-node").length).toBeGreaterThan(0);
    expect(screen.getByText("① 已知与目标")).toBeTruthy();

    const diagram = board.querySelector<HTMLElement>(
      '[data-id="lesson-geometry-v2-001:node:clean-diagram"]',
    );
    const instanceId = diagram?.dataset.instanceId;
    expect(instanceId).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一 Beat" }));

    expect(
      board.querySelector<HTMLElement>(
        '[data-id="lesson-geometry-v2-001:node:clean-diagram"]',
      )?.dataset.instanceId,
    ).toBe(instanceId);
    expect(screen.getByText("② 连接 AD")).toBeTruthy();
  });

  it("opens a historical lesson at its final board state without playing", async () => {
    render(<ReviewRuntimeProbe />);

    await waitFor(() => {
      const [cursor, total] = screen
        .getByTestId("review-progress")
        .textContent!.split("/")
        .map(Number);
      expect(cursor).toBe(total);
      expect(total).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("review-playing").textContent).toBe("false");
    expect(screen.getByText("关键想法")).toBeTruthy();
  });

  it("groups the outline and seeks backwards to a selected Step", () => {
    render(<OutlineRuntimeProbe />);
    const [initialCursor, total] = screen
      .getByTestId("outline-progress")
      .textContent!.split("/")
      .map(Number);
    expect(initialCursor).toBe(total);
    expect(screen.getByTestId("outline-topic").textContent).toBe("几何证明");

    fireEvent.click(screen.getByRole("button", { name: "查看第一步" }));

    const [cursorAfterSeek] = screen
      .getByTestId("outline-progress")
      .textContent!.split("/")
      .map(Number);
    expect(cursorAfterSeek).toBeLessThan(total!);
    expect(screen.getByTestId("outline-current").textContent).toBe(
      geometryEvents[1]?.step?.id,
    );
    expect(screen.getByText("① 已知与目标")).toBeTruthy();
  });

  it("applies each Beat focus even when React batches advanceBeat updates", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 960,
      bottom: 608,
      width: 960,
      height: 608,
      toJSON: () => ({}),
    } as DOMRect);
    render(<RuntimeProbe />);

    const board = screen.getByTestId("oll-lesson-board");
    const world = board.querySelector<HTMLElement>("[data-oll-board-runtime-world]");
    expect(world).toBeTruthy();
    const transforms: string[] = [];

    for (let beat = 0; beat < 11; beat += 1) {
      fireEvent.click(screen.getByRole("button", { name: "下一 Beat" }));
      transforms.push(world?.style.transform ?? "");
    }

    const scales = transforms.map((transform) => transform.match(/scale\(([^)]+)\)/)?.[1]);
    expect(new Set(scales).size).toBeGreaterThanOrEqual(4);
    expect(transforms[5]).not.toBe(transforms[6]);
    expect(transforms[7]).not.toBe(transforms[8]);
  });

  it("grows an active /learn board when a validated Canonical Step arrives", () => {
    render(<IncrementalRuntimeProbe />);
    fireEvent.click(screen.getByRole("button", { name: "推进增量课程" }));
    expect(screen.getByTestId("stream-status").textContent).toBe("waiting");
    const totalBefore = Number(screen.getByTestId("stream-total").textContent);

    fireEvent.click(screen.getByRole("button", { name: "追加课程步骤" }));
    expect(Number(screen.getByTestId("stream-total").textContent)).toBeGreaterThan(totalBefore);
    fireEvent.click(screen.getByRole("button", { name: "推进增量课程" }));
    expect(screen.getByText("① 已知与目标")).toBeTruthy();
  });

  it("applies an incrementally restored history directly to its available end", async () => {
    render(<IncrementalReviewRuntimeProbe />);
    fireEvent.click(screen.getByRole("button", { name: "恢复历史课程" }));

    await waitFor(() => {
      const [cursor, total] = screen
        .getByTestId("incremental-review-progress")
        .textContent!.split("/")
        .map(Number);
      expect(cursor).toBe(total);
      expect(total).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("incremental-review-status").textContent).toBe(
      "waiting",
    );
    expect(screen.getByTestId("incremental-review-playing").textContent).toBe(
      "false",
    );
    expect(screen.getByText("关键想法")).toBeTruthy();
  });
});
