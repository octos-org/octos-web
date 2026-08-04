export const LESSON_PACKET_VERSION = 1;

export interface BoardPoint {
  x: number;
  y: number;
}

interface BaseAction {
  id: string;
  delayMs?: number;
}

export interface WriteTextAction extends BaseAction {
  type: "write_text";
  text: string;
  at: BoardPoint;
  tone?: "ink" | "muted" | "accent";
  size?: "sm" | "md" | "lg" | "xl";
  semanticLevel?: "detail" | "summary" | "topic";
}

export interface WriteFormulaAction extends BaseAction {
  type: "write_formula";
  latex: string;
  at: BoardPoint;
  tone?: "ink" | "accent";
  size?: "md" | "lg" | "xl";
  semanticLevel?: "detail" | "summary" | "topic";
}

export interface DrawAxesAction extends BaseAction {
  type: "draw_axes";
  at: BoardPoint;
  width: number;
  height: number;
  xDomain: [number, number];
  yDomain: [number, number];
}

export interface PlotFunctionAction extends BaseAction {
  type: "plot_function";
  function: {
    kind: "quadratic";
    coefficients: [number, number, number];
  };
  axesId: string;
  color?: "blue" | "coral" | "ink";
}

export interface MarkPointAction extends BaseAction {
  type: "mark_point";
  axesId: string;
  point: [number, number];
  label: string;
  color?: "blue" | "coral" | "ink";
}

export interface HighlightAction extends BaseAction {
  type: "highlight";
  targetId: string;
  label?: string;
  color?: "yellow" | "blue" | "coral";
}

export interface ConnectAction extends BaseAction {
  type: "connect";
  fromId: string;
  toId: string;
  label?: string;
}

export interface CheckpointAction extends BaseAction {
  type: "checkpoint";
  prompt: string;
  at: BoardPoint;
}

export interface FocusAction extends BaseAction {
  type: "focus";
  at: BoardPoint;
  zoom?: number;
}

export interface GroupAction extends BaseAction {
  type: "group";
  title: string;
  at: BoardPoint;
  width: number;
  height: number;
  memberIds: string[];
  summary?: string;
}

export type BoardAction =
  | WriteTextAction
  | WriteFormulaAction
  | DrawAxesAction
  | PlotFunctionAction
  | MarkPointAction
  | HighlightAction
  | ConnectAction
  | CheckpointAction
  | FocusAction
  | GroupAction;

export interface LessonSegment {
  id: string;
  speech: string;
  actions: BoardAction[];
}

export interface LessonPacketV1 {
  version: 1;
  lessonId: string;
  turnId: string;
  title: string;
  segments: LessonSegment[];
}

export interface LessonPacketParseResult {
  packet: LessonPacketV1 | null;
  errors: string[];
}

const MAX_SEGMENTS = 48;
const MAX_ACTIONS_PER_SEGMENT = 12;
const MAX_TEXT_LENGTH = 800;
const MAX_COORDINATE = 50_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is BoardPoint {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    Math.abs(value.x) <= MAX_COORDINATE &&
    Math.abs(value.y) <= MAX_COORDINATE
  );
}

function isTuple(
  value: unknown,
  min: number,
  max: number,
): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (entry) =>
        isFiniteNumber(entry) && entry >= min && entry <= max,
    )
  );
}

function isNumberTriple(
  value: unknown,
  min: number,
  max: number,
): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (entry) =>
        isFiniteNumber(entry) && entry >= min && entry <= max,
    )
  );
}

function hasBaseAction(value: Record<string, unknown>): boolean {
  return (
    isString(value.id, 120) &&
    (value.delayMs === undefined ||
      (isFiniteNumber(value.delayMs) &&
        value.delayMs >= 0 &&
        value.delayMs <= 30_000))
  );
}

function isBoardAction(value: unknown): value is BoardAction {
  if (!isRecord(value) || !hasBaseAction(value)) return false;

  switch (value.type) {
    case "write_text":
      return (
        isString(value.text) &&
        isPoint(value.at) &&
        (value.tone === undefined ||
          ["ink", "muted", "accent"].includes(String(value.tone))) &&
        (value.size === undefined ||
          ["sm", "md", "lg", "xl"].includes(String(value.size))) &&
        (value.semanticLevel === undefined ||
          ["detail", "summary", "topic"].includes(
            String(value.semanticLevel),
          ))
      );
    case "write_formula":
      return (
        isString(value.latex) &&
        !/[<>]/.test(value.latex) &&
        isPoint(value.at) &&
        (value.tone === undefined ||
          ["ink", "accent"].includes(String(value.tone))) &&
        (value.size === undefined ||
          ["md", "lg", "xl"].includes(String(value.size)))
      );
    case "draw_axes":
      return (
        isPoint(value.at) &&
        isFiniteNumber(value.width) &&
        value.width >= 180 &&
        value.width <= 1400 &&
        isFiniteNumber(value.height) &&
        value.height >= 180 &&
        value.height <= 1000 &&
        isTuple(value.xDomain, -1000, 1000) &&
        isTuple(value.yDomain, -1000, 1000) &&
        value.xDomain[0] < value.xDomain[1] &&
        value.yDomain[0] < value.yDomain[1]
      );
    case "plot_function":
      return (
        isRecord(value.function) &&
        value.function.kind === "quadratic" &&
        isNumberTriple(value.function.coefficients, -1000, 1000) &&
        value.function.coefficients[0] !== 0 &&
        isString(value.axesId, 120) &&
        (value.color === undefined ||
          ["blue", "coral", "ink"].includes(String(value.color)))
      );
    case "mark_point":
      return (
        isString(value.axesId, 120) &&
        isTuple(value.point, -1000, 1000) &&
        isString(value.label, 120) &&
        (value.color === undefined ||
          ["blue", "coral", "ink"].includes(String(value.color)))
      );
    case "highlight":
      return (
        isString(value.targetId, 120) &&
        (value.label === undefined || isString(value.label, 120)) &&
        (value.color === undefined ||
          ["yellow", "blue", "coral"].includes(String(value.color)))
      );
    case "connect":
      return (
        isString(value.fromId, 120) &&
        isString(value.toId, 120) &&
        (value.label === undefined || isString(value.label, 120))
      );
    case "checkpoint":
      return isString(value.prompt) && isPoint(value.at);
    case "focus":
      return (
        isPoint(value.at) &&
        (value.zoom === undefined ||
          (isFiniteNumber(value.zoom) &&
            value.zoom >= 0.15 &&
            value.zoom <= 2.5))
      );
    case "group":
      return (
        isString(value.title, 160) &&
        isPoint(value.at) &&
        isFiniteNumber(value.width) &&
        value.width >= 200 &&
        value.width <= 3000 &&
        isFiniteNumber(value.height) &&
        value.height >= 160 &&
        value.height <= 2400 &&
        Array.isArray(value.memberIds) &&
        value.memberIds.length <= 48 &&
        value.memberIds.every((id) => isString(id, 120)) &&
        (value.summary === undefined || isString(value.summary, 400))
      );
    default:
      return false;
  }
}

export function parseLessonPacket(value: unknown): LessonPacketParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { packet: null, errors: ["packet must be an object"] };
  }
  if (value.version !== LESSON_PACKET_VERSION) {
    errors.push("unsupported lesson packet version");
  }
  if (!isString(value.lessonId, 160)) errors.push("invalid lessonId");
  if (!isString(value.turnId, 160)) errors.push("invalid turnId");
  if (!isString(value.title, 240)) errors.push("invalid title");
  if (
    !Array.isArray(value.segments) ||
    value.segments.length === 0 ||
    value.segments.length > MAX_SEGMENTS
  ) {
    errors.push("invalid segments");
  } else {
    const segmentIds = new Set<string>();
    const actionIds = new Set<string>();
    value.segments.forEach((segment, segmentIndex) => {
      if (!isRecord(segment)) {
        errors.push(`segment ${segmentIndex} must be an object`);
        return;
      }
      if (!isString(segment.id, 120) || segmentIds.has(String(segment.id))) {
        errors.push(`segment ${segmentIndex} has an invalid or duplicate id`);
      } else {
        segmentIds.add(segment.id);
      }
      if (!isString(segment.speech)) {
        errors.push(`segment ${segmentIndex} has invalid speech`);
      }
      if (
        !Array.isArray(segment.actions) ||
        segment.actions.length > MAX_ACTIONS_PER_SEGMENT
      ) {
        errors.push(`segment ${segmentIndex} has invalid actions`);
        return;
      }
      segment.actions.forEach((action, actionIndex) => {
        if (!isBoardAction(action)) {
          errors.push(
            `segment ${segmentIndex} action ${actionIndex} is invalid`,
          );
          return;
        }
        if (actionIds.has(action.id)) {
          errors.push(`duplicate action id: ${action.id}`);
        }
        actionIds.add(action.id);
      });
    });
  }

  if (errors.length > 0) return { packet: null, errors };
  return { packet: value as unknown as LessonPacketV1, errors: [] };
}
