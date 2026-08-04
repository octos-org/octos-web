import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import katex from "katex";
import {
  LocateFixed,
  Maximize2,
  Minus,
  Plus,
} from "lucide-react";
import type {
  BoardAction,
  ConnectAction,
  DrawAxesAction,
  GroupAction,
  LessonPacketV1,
  MarkPointAction,
  PlotFunctionAction,
} from "./lesson-packet";
import "./board.css";

interface BoardViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface InfiniteBoardProps {
  packet: LessonPacketV1;
  segmentIndex: number;
  className?: string;
}

const MIN_ZOOM = 0.18;
const MAX_ZOOM = 1.8;
const INITIAL_VIEWPORT: BoardViewport = { x: 60, y: 42, zoom: 0.72 };

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function actionStyle(action: {
  at: { x: number; y: number };
}): React.CSSProperties {
  return {
    left: action.at.x,
    top: action.at.y,
  };
}

function Formula({
  latex,
  className,
}: {
  latex: string;
  className?: string;
}) {
  const html = useMemo(
    () =>
      katex.renderToString(latex, {
        throwOnError: false,
        strict: "warn",
        trust: false,
      }),
    [latex],
  );
  return (
    <span
      className={className}
      aria-label={latex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function mapPoint(
  axes: DrawAxesAction,
  point: [number, number],
): [number, number] {
  const [xMin, xMax] = axes.xDomain;
  const [yMin, yMax] = axes.yDomain;
  return [
    ((point[0] - xMin) / (xMax - xMin)) * axes.width,
    axes.height - ((point[1] - yMin) / (yMax - yMin)) * axes.height,
  ];
}

function Graph({
  axes,
  plot,
  points,
}: {
  axes: DrawAxesAction;
  plot?: PlotFunctionAction;
  points: MarkPointAction[];
}) {
  const [originX, originY] = mapPoint(axes, [0, 0]);
  const curve = useMemo(() => {
    if (!plot) return "";
    const [xMin, xMax] = axes.xDomain;
    const [a, b, c] = plot.function.coefficients;
    const samples = Array.from({ length: 121 }, (_, index) => {
      const x = xMin + ((xMax - xMin) * index) / 120;
      const y = a * x * x + b * x + c;
      return mapPoint(axes, [x, y]);
    }).filter(([, y]) => y >= -20 && y <= axes.height + 20);
    return samples
      .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
      .join(" ");
  }, [axes, plot]);

  const xTicks = Array.from(
    { length: Math.floor(axes.xDomain[1] - axes.xDomain[0]) + 1 },
    (_, index) => axes.xDomain[0] + index,
  );
  const yTicks = Array.from(
    { length: Math.floor(axes.yDomain[1] - axes.yDomain[0]) + 1 },
    (_, index) => axes.yDomain[0] + index,
  );

  return (
    <svg
      className="learning-board-graph"
      style={{
        ...actionStyle(axes),
        width: axes.width,
        height: axes.height,
      }}
      viewBox={`0 0 ${axes.width} ${axes.height}`}
      role="img"
      aria-label="二次函数坐标图"
    >
      <defs>
        <marker
          id={`axis-arrow-${axes.id}`}
          viewBox="0 0 10 10"
          refX="7"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="board-axis-arrow" />
        </marker>
      </defs>
      {xTicks.map((value) => {
        const [x] = mapPoint(axes, [value, 0]);
        return (
          <g key={`x-${value}`}>
            <line
              x1={x}
              y1={0}
              x2={x}
              y2={axes.height}
              className="board-grid-line"
            />
            {value !== 0 && (
              <text x={x} y={originY + 22} className="board-axis-label">
                {value}
              </text>
            )}
          </g>
        );
      })}
      {yTicks.map((value) => {
        const [, y] = mapPoint(axes, [0, value]);
        return (
          <g key={`y-${value}`}>
            <line
              x1={0}
              y1={y}
              x2={axes.width}
              y2={y}
              className="board-grid-line"
            />
            {value !== 0 && (
              <text x={originX - 12} y={y + 4} className="board-axis-label">
                {value}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1={0}
        y1={originY}
        x2={axes.width - 6}
        y2={originY}
        className="board-axis-line"
        markerEnd={`url(#axis-arrow-${axes.id})`}
      />
      <line
        x1={originX}
        y1={axes.height}
        x2={originX}
        y2={6}
        className="board-axis-line"
        markerEnd={`url(#axis-arrow-${axes.id})`}
      />
      <line
        x1={mapPoint(axes, [2, axes.yDomain[0]])[0]}
        y1={0}
        x2={mapPoint(axes, [2, axes.yDomain[0]])[0]}
        y2={axes.height}
        className="board-symmetry-line"
      />
      {curve && <path d={curve} className="board-curve board-draw-stroke" />}
      {points.map((point) => {
        const [x, y] = mapPoint(axes, point.point);
        return (
          <g key={point.id} className="board-point-enter">
            <circle cx={x} cy={y} r={7} className="board-vertex-point" />
            <text x={x + 13} y={y - 13} className="board-point-label">
              {point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function semanticClass(level?: "detail" | "summary" | "topic"): string {
  return `board-semantic-${level ?? "detail"}`;
}

function textSizeClass(size?: "sm" | "md" | "lg" | "xl"): string {
  return `board-text-${size ?? "md"}`;
}

function renderAction(
  action: BoardAction,
  highlights: ReadonlyMap<string, Extract<BoardAction, { type: "highlight" }>>,
) {
  switch (action.type) {
    case "write_text": {
      const highlight = highlights.get(action.id);
      return (
        <div
          key={action.id}
          data-board-id={action.id}
          className={`learning-board-text board-element-enter ${semanticClass(action.semanticLevel)} ${textSizeClass(action.size)} board-tone-${action.tone ?? "ink"} ${highlight ? `is-highlighted is-${highlight.color ?? "yellow"}` : ""}`}
          style={actionStyle(action)}
        >
          {action.text}
          {highlight?.label && (
            <span className="board-highlight-label">{highlight.label}</span>
          )}
        </div>
      );
    }
    case "write_formula": {
      const highlight = highlights.get(action.id);
      return (
        <div
          key={action.id}
          data-board-id={action.id}
          className={`learning-board-formula board-element-enter ${semanticClass(action.semanticLevel)} board-formula-${action.size ?? "md"} board-tone-${action.tone ?? "ink"} ${highlight ? `is-highlighted is-${highlight.color ?? "yellow"}` : ""}`}
          style={actionStyle(action)}
        >
          <Formula latex={action.latex} />
          {highlight?.label && (
            <span className="board-highlight-label">{highlight.label}</span>
          )}
        </div>
      );
    }
    case "checkpoint":
      return (
        <div
          key={action.id}
          data-board-id={action.id}
          className="learning-board-checkpoint board-element-enter board-semantic-summary"
          style={actionStyle(action)}
        >
          <span>轮到你了</span>
          <strong>{action.prompt}</strong>
          <div className="board-answer-line" />
        </div>
      );
    default:
      return null;
  }
}

function connectionGeometry(
  connection: ConnectAction,
  groups: ReadonlyMap<string, GroupAction>,
) {
  const from = groups.get(connection.fromId);
  const to = groups.get(connection.toId);
  if (!from || !to) return null;
  return {
    x1: from.at.x + from.width,
    y1: from.at.y + from.height / 2,
    x2: to.at.x,
    y2: to.at.y + to.height / 2,
  };
}

export function InfiniteBoard({
  packet,
  segmentIndex,
  className,
}: InfiniteBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [viewport, setViewport] =
    useState<BoardViewport>(INITIAL_VIEWPORT);

  const actions = useMemo(() => {
    if (segmentIndex < 0) return [];
    const byId = new Map<string, BoardAction>();
    for (const action of packet.segments
      .slice(0, segmentIndex + 1)
      .flatMap((segment) => segment.actions)) {
      byId.set(action.id, action);
    }
    return [...byId.values()];
  }, [packet.segments, segmentIndex]);

  const highlights = useMemo(
    () =>
      new Map(
        actions
          .filter((action) => action.type === "highlight")
          .map((action) => [action.targetId, action]),
      ),
    [actions],
  );
  const groups = useMemo(
    () =>
      new Map(
        actions
          .filter((action) => action.type === "group")
          .map((action) => [action.id, action]),
      ),
    [actions],
  );

  useEffect(() => {
    const focus = [...actions]
      .reverse()
      .find((action) => action.type === "focus");
    if (!focus || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const zoom = focus.zoom ?? viewport.zoom;
    setViewport({
      zoom,
      x: rect.width / 2 - focus.at.x * zoom,
      y: rect.height / 2 - focus.at.y * zoom,
    });
    // Focus actions are immutable and identified by the visible action count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.length]);

  const zoomAt = useCallback((nextZoom: number, x: number, y: number) => {
    setViewport((current) => {
      const zoom = clampZoom(nextZoom);
      const worldX = (x - current.x) / current.zoom;
      const worldY = (y - current.y) / current.zoom;
      return {
        zoom,
        x: x - worldX * zoom,
        y: y - worldY * zoom,
      };
    });
  }, []);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * 0.0012);
    zoomAt(
      viewport.zoom * factor,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setViewport((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y,
    }));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resetViewport = () => setViewport(INITIAL_VIEWPORT);
  const showOverview = () =>
    setViewport({ x: 80, y: 70, zoom: 0.38 });

  const axes = actions.filter(
    (action): action is DrawAxesAction => action.type === "draw_axes",
  );

  return (
    <div
      ref={containerRef}
      className={`learning-board ${className ?? ""}`}
      data-zoom={viewport.zoom.toFixed(2)}
      onWheel={handleWheel}
    >
      <div
        className="learning-board-gesture-layer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <div
        className="learning-board-world"
        style={{
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
          "--learning-board-zoom": viewport.zoom,
        } as React.CSSProperties}
      >
        {actions
          .filter((action) => action.type === "group")
          .map((action) => (
            <div
              key={action.id}
              data-board-id={action.id}
              className="learning-board-group board-element-enter board-semantic-topic"
              style={{
                ...actionStyle(action),
                width: action.width,
                height: action.height,
              }}
            >
              <strong>{action.title}</strong>
              {action.summary && <span>{action.summary}</span>}
            </div>
          ))}

        <svg
          className="learning-board-connections"
          width="1800"
          height="1200"
          viewBox="0 0 1800 1200"
          aria-hidden="true"
        >
          {actions
            .filter(
              (action): action is ConnectAction =>
                action.type === "connect",
            )
            .map((connection) => {
              const geometry = connectionGeometry(connection, groups);
              if (!geometry) return null;
              const midX = (geometry.x1 + geometry.x2) / 2;
              const path = `M ${geometry.x1} ${geometry.y1} C ${midX} ${geometry.y1}, ${midX} ${geometry.y2}, ${geometry.x2} ${geometry.y2}`;
              return (
                <g key={connection.id}>
                  <path d={path} className="board-connection board-draw-stroke" />
                  {connection.label && (
                    <text
                      x={midX}
                      y={(geometry.y1 + geometry.y2) / 2 - 10}
                      className="board-connection-label"
                    >
                      {connection.label}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>

        {actions.map((action) => renderAction(action, highlights))}

        {axes.map((axis) => (
          <Graph
            key={axis.id}
            axes={axis}
            plot={
              actions.find(
                (action): action is PlotFunctionAction =>
                  action.type === "plot_function" &&
                  action.axesId === axis.id,
              )
            }
            points={actions.filter(
              (action): action is MarkPointAction =>
                action.type === "mark_point" &&
                action.axesId === axis.id,
            )}
          />
        ))}
      </div>

      {actions.length === 0 && (
        <div className="learning-board-empty">
          <span>这块白板会保存我们的思考过程</span>
          <strong>向 Octos 提问，我们从这里开始</strong>
        </div>
      )}

      <div className="learning-board-controls" aria-label="白板视图控制">
        <button
          type="button"
          onClick={() => zoomAt(viewport.zoom * 0.84, 120, 100)}
          aria-label="缩小白板"
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(viewport.zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => zoomAt(viewport.zoom * 1.18, 120, 100)}
          aria-label="放大白板"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          onClick={resetViewport}
          aria-label="回到当前课程"
        >
          <LocateFixed size={16} />
        </button>
        <button type="button" onClick={showOverview} aria-label="知识全景">
          <Maximize2 size={16} />
        </button>
      </div>

      <div className="learning-board-zoom-hint">
        拖动画布 · 滚轮缩放
      </div>
    </div>
  );
}
