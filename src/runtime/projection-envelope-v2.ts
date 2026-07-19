/**
 * Stage 0 receive-only decoder for the server's flattened
 * `projection/envelope` params shape.
 *
 * This module deliberately has no bridge, store, subscription, or feature
 * negotiation dependency. It is a pure boundary decoder only; wiring its
 * result into a live path is a later migration stage.
 *
 * The server's per-thread `seq` starts at 1. The current wire does not carry
 * a durable ledger `cursor`; a future v2 envelope may add one for
 * reconnect/replay, so the decoder preserves it when present without
 * conflating it with the per-thread sequence.
 */

type JsonObject = Record<string, unknown>;

export interface ProjectionEnvelopeV2Cursor {
  stream: string;
  seq: number;
}

export interface ProjectionEnvelopeV2FileRef {
  path: string;
  mime: string;
  size_bytes: number;
}

export interface ProjectionEnvelopeV2MessageMeta {
  message_id: string;
  persisted_at: string;
  media?: string[];
}

export interface ProjectionEnvelopeV2TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ProjectionEnvelopeV2TerminalError {
  code: string;
  message: string;
  data?: unknown;
}

export type ProjectionEnvelopeV2ToolEndStatus =
  | "complete"
  | "error"
  | "skipped"
  | "aborted";

export type ProjectionEnvelopeV2TurnStatus =
  | "completed"
  | "error"
  | "errored"
  | "interrupted"
  | "cancelled";

export interface ProjectionEnvelopeV2UserMessagePayload {
  type: "user_message";
  data: {
    text: string;
    files: ProjectionEnvelopeV2FileRef[];
  };
}

export interface ProjectionEnvelopeV2AssistantDeltaPayload {
  type: "assistant_delta";
  data: { text: string };
}

export interface ProjectionEnvelopeV2ReasoningDeltaPayload {
  type: "reasoning_delta";
  data: { text: string };
}

export interface ProjectionEnvelopeV2AssistantPersistedPayload {
  type: "assistant_persisted";
  data: {
    text: string;
    meta: ProjectionEnvelopeV2MessageMeta;
  };
}

export interface ProjectionEnvelopeV2ToolStartPayload {
  type: "tool_start";
  data: {
    tool_call_id: string;
    name: string;
    arguments?: unknown;
  };
}

export interface ProjectionEnvelopeV2ToolProgressPayload {
  type: "tool_progress";
  data: {
    tool_call_id: string;
    message: string;
  };
}

export interface ProjectionEnvelopeV2ToolEndPayload {
  type: "tool_end";
  data: {
    tool_call_id: string;
    status: ProjectionEnvelopeV2ToolEndStatus;
    error?: string;
    reason?: string;
  };
}

export interface ProjectionEnvelopeV2FileAttachedPayload {
  type: "file_attached";
  data: ProjectionEnvelopeV2FileRef;
}

export interface ProjectionEnvelopeV2TurnCompletedPayload {
  type: "turn_completed";
  data: {
    token_usage: ProjectionEnvelopeV2TokenUsage;
    status?: ProjectionEnvelopeV2TurnStatus;
    error?: ProjectionEnvelopeV2TerminalError;
    reason?: string;
  };
}

/** Completion emitted by the background/spawn path after the foreground
 * turn has already settled. `content` is the durable assistant body; media
 * is optional because a background task can complete with text only. */
export interface ProjectionEnvelopeV2BackgroundSpawnCompletePayload {
  type: "background/spawn_complete";
  data: {
    task_id: string;
    content: string;
    tool_call_id?: string;
    response_to_client_message_id?: string;
    message_id?: string;
    source?: string;
    persisted_at?: string;
    media?: string[];
    meta?: ProjectionEnvelopeV2MessageMeta;
  };
}

export type ProjectionEnvelopeV2Payload =
  | ProjectionEnvelopeV2UserMessagePayload
  | ProjectionEnvelopeV2AssistantDeltaPayload
  | ProjectionEnvelopeV2ReasoningDeltaPayload
  | ProjectionEnvelopeV2AssistantPersistedPayload
  | ProjectionEnvelopeV2ToolStartPayload
  | ProjectionEnvelopeV2ToolProgressPayload
  | ProjectionEnvelopeV2ToolEndPayload
  | ProjectionEnvelopeV2FileAttachedPayload
  | ProjectionEnvelopeV2TurnCompletedPayload
  | ProjectionEnvelopeV2BackgroundSpawnCompletePayload;

/** The actual flattened notification params shape. There is intentionally no
 * nested `envelope` object and no `turn_id` field. */
export interface ProjectionEnvelopeV2 {
  session_id: string;
  topic?: string;
  thread_id: string;
  /** Server-assigned per-thread order; the first envelope is 1, not 0. */
  seq: number;
  client_message_id?: string;
  /** V2 reconnect/replay addition; absent from the current EnvelopeWire. */
  cursor?: ProjectionEnvelopeV2Cursor;
  payload: ProjectionEnvelopeV2Payload;
}

export type ProjectionEnvelopeV2ParseErrorCode =
  | "not_object"
  | "missing_field"
  | "invalid_field"
  | "unknown_payload";

export interface ProjectionEnvelopeV2ParseError {
  code: ProjectionEnvelopeV2ParseErrorCode;
  path: string;
  message: string;
}

export type ProjectionEnvelopeV2ParseResult =
  | { ok: true; value: ProjectionEnvelopeV2 }
  | { ok: false; error: ProjectionEnvelopeV2ParseError };

type ParseStep<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectionEnvelopeV2ParseError };

function ok<T>(value: T): ParseStep<T> {
  return { ok: true, value };
}

function fail(
  code: ProjectionEnvelopeV2ParseErrorCode,
  path: string,
  message: string,
): ParseStep<never> {
  return { ok: false, error: { code, path, message } };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readObject(
  object: JsonObject,
  key: string,
  path: string,
): ParseStep<JsonObject> {
  if (!hasOwn(object, key)) {
    return fail("missing_field", `${path}.${key}`, "field is required");
  }
  if (!isPlainObject(object[key])) {
    return fail("invalid_field", `${path}.${key}`, "expected an object");
  }
  return ok(object[key]);
}

function readString(
  object: JsonObject,
  key: string,
  path: string,
  options: { nonEmpty?: boolean } = {},
): ParseStep<string> {
  if (!hasOwn(object, key)) {
    return fail("missing_field", `${path}.${key}`, "field is required");
  }
  const value = object[key];
  if (typeof value !== "string") {
    return fail("invalid_field", `${path}.${key}`, "expected a string");
  }
  if (options.nonEmpty && value.length === 0) {
    return fail("invalid_field", `${path}.${key}`, "expected a non-empty string");
  }
  return ok(value);
}

function readOptionalString(
  object: JsonObject,
  key: string,
  path: string,
  options: { nonEmpty?: boolean } = {},
): ParseStep<string | undefined> {
  if (!hasOwn(object, key)) return ok(undefined);
  const value = object[key];
  if (typeof value !== "string") {
    return fail("invalid_field", `${path}.${key}`, "expected a string");
  }
  if (options.nonEmpty && value.length === 0) {
    return fail("invalid_field", `${path}.${key}`, "expected a non-empty string");
  }
  return ok(value);
}

function readNonNegativeInteger(
  object: JsonObject,
  key: string,
  path: string,
  minimum: number,
): ParseStep<number> {
  if (!hasOwn(object, key)) {
    return fail("missing_field", `${path}.${key}`, "field is required");
  }
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(
      "invalid_field",
      `${path}.${key}`,
      `expected a safe integer greater than or equal to ${minimum}`,
    );
  }
  return ok(value as number);
}

function readOptionalNonNegativeInteger(
  object: JsonObject,
  key: string,
  path: string,
): ParseStep<number | undefined> {
  if (!hasOwn(object, key)) return ok(undefined);
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(
      "invalid_field",
      `${path}.${key}`,
      "expected a non-negative safe integer",
    );
  }
  return ok(value as number);
}

function readOptionalStringArray(
  object: JsonObject,
  key: string,
  path: string,
): ParseStep<string[] | undefined> {
  if (!hasOwn(object, key)) return ok(undefined);
  const value = object[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return fail("invalid_field", `${path}.${key}`, "expected an array of strings");
  }
  return ok(value.slice());
}

function parseCursor(value: unknown, path: string): ParseStep<ProjectionEnvelopeV2Cursor> {
  if (!isPlainObject(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const stream = readString(value, "stream", path, { nonEmpty: true });
  if (!stream.ok) return stream;
  const seq = readNonNegativeInteger(value, "seq", path, 0);
  if (!seq.ok) return seq;
  return ok({ stream: stream.value, seq: seq.value });
}

function parseFileRef(value: unknown, path: string): ParseStep<ProjectionEnvelopeV2FileRef> {
  if (!isPlainObject(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const filePath = readString(value, "path", path, { nonEmpty: true });
  if (!filePath.ok) return filePath;
  const mime = readString(value, "mime", path, { nonEmpty: true });
  if (!mime.ok) return mime;
  const sizeBytes = readNonNegativeInteger(value, "size_bytes", path, 0);
  if (!sizeBytes.ok) return sizeBytes;
  return ok({ path: filePath.value, mime: mime.value, size_bytes: sizeBytes.value });
}

function parseFileRefs(
  object: JsonObject,
  key: string,
  path: string,
): ParseStep<ProjectionEnvelopeV2FileRef[]> {
  if (!hasOwn(object, key)) return ok([]);
  const value = object[key];
  if (!Array.isArray(value)) {
    return fail("invalid_field", `${path}.${key}`, "expected an array");
  }
  const files: ProjectionEnvelopeV2FileRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseFileRef(value[index], `${path}.${key}[${index}]`);
    if (!parsed.ok) return parsed;
    files.push(parsed.value);
  }
  return ok(files);
}

function parseMessageMeta(
  value: unknown,
  path: string,
): ParseStep<ProjectionEnvelopeV2MessageMeta> {
  if (!isPlainObject(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const messageId = readString(value, "message_id", path, { nonEmpty: true });
  if (!messageId.ok) return messageId;
  const persistedAt = readString(value, "persisted_at", path, { nonEmpty: true });
  if (!persistedAt.ok) return persistedAt;
  const media = readOptionalStringArray(value, "media", path);
  if (!media.ok) return media;
  return ok({
    message_id: messageId.value,
    persisted_at: persistedAt.value,
    ...(media.value !== undefined ? { media: media.value } : {}),
  });
}

function parseTokenUsage(
  value: unknown,
  path: string,
): ParseStep<ProjectionEnvelopeV2TokenUsage> {
  if (!isPlainObject(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const usage: ProjectionEnvelopeV2TokenUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ] as const) {
    const valueForKey = readOptionalNonNegativeInteger(value, key, path);
    if (!valueForKey.ok) return valueForKey;
    if (valueForKey.value !== undefined) usage[key] = valueForKey.value;
  }
  return ok(usage);
}

function parseTerminalError(
  value: unknown,
  path: string,
): ParseStep<ProjectionEnvelopeV2TerminalError> {
  if (!isPlainObject(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const code = readString(value, "code", path, { nonEmpty: true });
  if (!code.ok) return code;
  const message = readString(value, "message", path, { nonEmpty: true });
  if (!message.ok) return message;
  return ok({
    code: code.value,
    message: message.value,
    ...(hasOwn(value, "data") ? { data: value.data } : {}),
  });
}

function parsePayload(value: unknown): ParseStep<ProjectionEnvelopeV2Payload> {
  const path = "$.payload";
  if (!isPlainObject(value)) {
    return fail("invalid_field", path, "expected an object");
  }
  const type = readString(value, "type", path, { nonEmpty: true });
  if (!type.ok) return type;
  const data = readObject(value, "data", path);
  if (!data.ok) return data;
  const dataPath = `${path}.data`;

  switch (type.value) {
    case "user_message": {
      const text = readString(data.value, "text", dataPath);
      if (!text.ok) return text;
      const files = parseFileRefs(data.value, "files", dataPath);
      if (!files.ok) return files;
      return ok({
        type: "user_message",
        data: { text: text.value, files: files.value },
      });
    }
    case "assistant_delta":
    case "reasoning_delta": {
      const text = readString(data.value, "text", dataPath);
      if (!text.ok) return text;
      return ok({ type: type.value, data: { text: text.value } });
    }
    case "assistant_persisted": {
      const text = readString(data.value, "text", dataPath);
      if (!text.ok) return text;
      const meta = parseMessageMeta(data.value.meta, `${dataPath}.meta`);
      if (!meta.ok) return meta;
      return ok({
        type: "assistant_persisted",
        data: { text: text.value, meta: meta.value },
      });
    }
    case "tool_start": {
      const toolCallId = readString(data.value, "tool_call_id", dataPath, {
        nonEmpty: true,
      });
      if (!toolCallId.ok) return toolCallId;
      const name = readString(data.value, "name", dataPath, { nonEmpty: true });
      if (!name.ok) return name;
      return ok({
        type: "tool_start",
        data: {
          tool_call_id: toolCallId.value,
          name: name.value,
          ...(hasOwn(data.value, "arguments")
            ? { arguments: data.value.arguments }
            : {}),
        },
      });
    }
    case "tool_progress": {
      const toolCallId = readString(data.value, "tool_call_id", dataPath, {
        nonEmpty: true,
      });
      if (!toolCallId.ok) return toolCallId;
      const message = readString(data.value, "message", dataPath);
      if (!message.ok) return message;
      return ok({
        type: "tool_progress",
        data: { tool_call_id: toolCallId.value, message: message.value },
      });
    }
    case "tool_end": {
      const toolCallId = readString(data.value, "tool_call_id", dataPath, {
        nonEmpty: true,
      });
      if (!toolCallId.ok) return toolCallId;
      const status = readString(data.value, "status", dataPath, { nonEmpty: true });
      if (!status.ok) return status;
      if (
        status.value !== "complete" &&
        status.value !== "error" &&
        status.value !== "skipped" &&
        status.value !== "aborted"
      ) {
        return fail("invalid_field", `${dataPath}.status`, "unknown tool outcome status");
      }
      const error = readOptionalString(data.value, "error", dataPath);
      if (!error.ok) return error;
      const reason = readOptionalString(data.value, "reason", dataPath);
      if (!reason.ok) return reason;
      return ok({
        type: "tool_end",
        data: {
          tool_call_id: toolCallId.value,
          status: status.value,
          ...(error.value !== undefined ? { error: error.value } : {}),
          ...(reason.value !== undefined ? { reason: reason.value } : {}),
        },
      });
    }
    case "file_attached": {
      const file = parseFileRef(data.value, dataPath);
      if (!file.ok) return file;
      return ok({ type: "file_attached", data: file.value });
    }
    case "turn_completed": {
      const tokenUsage = parseTokenUsage(data.value.token_usage, `${dataPath}.token_usage`);
      if (!tokenUsage.ok) return tokenUsage;
      const status = readOptionalString(data.value, "status", dataPath);
      if (!status.ok) return status;
      if (
        status.value !== undefined &&
        status.value !== "completed" &&
        status.value !== "error" &&
        status.value !== "errored" &&
        status.value !== "interrupted" &&
        status.value !== "cancelled"
      ) {
        return fail("invalid_field", `${dataPath}.status`, "unknown terminal status");
      }
      let error: ProjectionEnvelopeV2TerminalError | undefined;
      if (hasOwn(data.value, "error")) {
        const parsedError = parseTerminalError(data.value.error, `${dataPath}.error`);
        if (!parsedError.ok) return parsedError;
        error = parsedError.value;
      }
      const reason = readOptionalString(data.value, "reason", dataPath);
      if (!reason.ok) return reason;
      return ok({
        type: "turn_completed",
        data: {
          token_usage: tokenUsage.value,
          ...(status.value !== undefined ? { status: status.value } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(reason.value !== undefined ? { reason: reason.value } : {}),
        },
      });
    }
    case "background/spawn_complete": {
      const taskId = readString(data.value, "task_id", dataPath, { nonEmpty: true });
      if (!taskId.ok) return taskId;
      const content = readString(data.value, "content", dataPath);
      if (!content.ok) return content;
      const toolCallId = readOptionalString(data.value, "tool_call_id", dataPath, {
        nonEmpty: true,
      });
      if (!toolCallId.ok) return toolCallId;
      const responseToClientMessageId = readOptionalString(
        data.value,
        "response_to_client_message_id",
        dataPath,
        { nonEmpty: true },
      );
      if (!responseToClientMessageId.ok) return responseToClientMessageId;
      const messageId = readOptionalString(data.value, "message_id", dataPath, {
        nonEmpty: true,
      });
      if (!messageId.ok) return messageId;
      const source = readOptionalString(data.value, "source", dataPath, {
        nonEmpty: true,
      });
      if (!source.ok) return source;
      const persistedAt = readOptionalString(data.value, "persisted_at", dataPath, {
        nonEmpty: true,
      });
      if (!persistedAt.ok) return persistedAt;
      const media = readOptionalStringArray(data.value, "media", dataPath);
      if (!media.ok) return media;
      let meta: ProjectionEnvelopeV2MessageMeta | undefined;
      if (hasOwn(data.value, "meta")) {
        const parsedMeta = parseMessageMeta(data.value.meta, `${dataPath}.meta`);
        if (!parsedMeta.ok) return parsedMeta;
        meta = parsedMeta.value;
      }
      return ok({
        type: "background/spawn_complete",
        data: {
          task_id: taskId.value,
          content: content.value,
          ...(toolCallId.value !== undefined ? { tool_call_id: toolCallId.value } : {}),
          ...(responseToClientMessageId.value !== undefined
            ? { response_to_client_message_id: responseToClientMessageId.value }
            : {}),
          ...(messageId.value !== undefined ? { message_id: messageId.value } : {}),
          ...(source.value !== undefined ? { source: source.value } : {}),
          ...(persistedAt.value !== undefined ? { persisted_at: persistedAt.value } : {}),
          ...(media.value !== undefined ? { media: media.value } : {}),
          ...(meta !== undefined ? { meta } : {}),
        },
      });
    }
    default:
      return fail("unknown_payload", `${path}.type`, `unsupported payload type: ${type.value}`);
  }
}

/**
 * Decode a server `projection/envelope` params object.
 *
 * The function does not throw for malformed JSON-shaped input. Callers can
 * safely handle the discriminated result at a receive boundary without any
 * subscription, store write, or other runtime effect.
 */
export function parseProjectionEnvelopeV2(input: unknown): ProjectionEnvelopeV2ParseResult {
  if (!isPlainObject(input)) {
    return fail("not_object", "$", "expected an object");
  }
  const sessionId = readString(input, "session_id", "$", { nonEmpty: true });
  if (!sessionId.ok) return sessionId;
  const topic = readOptionalString(input, "topic", "$", { nonEmpty: true });
  if (!topic.ok) return topic;
  const threadId = readString(input, "thread_id", "$", { nonEmpty: true });
  if (!threadId.ok) return threadId;
  const seq = readNonNegativeInteger(input, "seq", "$", 1);
  if (!seq.ok) return seq;
  const clientMessageId = readOptionalString(input, "client_message_id", "$", {
    nonEmpty: true,
  });
  if (!clientMessageId.ok) return clientMessageId;
  let cursor: ProjectionEnvelopeV2Cursor | undefined;
  if (hasOwn(input, "cursor")) {
    const parsedCursor = parseCursor(input.cursor, "$.cursor");
    if (!parsedCursor.ok) return parsedCursor;
    cursor = parsedCursor.value;
  }
  const payload = parsePayload(input.payload);
  if (!payload.ok) return payload;

  return {
    ok: true,
    value: {
      session_id: sessionId.value,
      ...(topic.value !== undefined ? { topic: topic.value } : {}),
      thread_id: threadId.value,
      seq: seq.value,
      ...(clientMessageId.value !== undefined
        ? { client_message_id: clientMessageId.value }
        : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      payload: payload.value,
    },
  };
}
