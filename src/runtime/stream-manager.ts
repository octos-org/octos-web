/**
 * Session-scoped SSE stream manager.
 *
 * Keeps SSE connections alive independently of React component lifecycle.
 * React components subscribe/unsubscribe without killing the underlying stream.
 */

import { buildApiHeaders } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import { getSettings } from "@/hooks/use-settings";
import type { SseEvent } from "@/api/types";
import { normalizeTopic } from "./event-scope";

/** A single SSE event with its parsed data. */
export interface StreamEvent {
  raw: SseEvent;
}

/** Callback for stream subscribers. */
export type StreamSubscriber = (event: StreamEvent) => void;

/** State of a managed session stream. */
interface ManagedStream {
  /**
   * Unique, monotonic identifier scoped to this tab. Out-of-order concurrent
   * responses share a (sessionId, topic) but have different ids, so consumers
   * that must discriminate "my stream" from "a sibling stream" (e.g. the
   * sse-bridge cleanup handler below) can match on this value instead of on
   * the session key that every concurrent stream reuses.
   */
  id: number;
  sessionId: string;
  topic?: string;
  /** All events received so far (for replay on resubscribe). */
  events: StreamEvent[];
  /** Whether the stream is still active (fetch in progress). */
  active: boolean;
  /** Whether the stream completed normally (done event received). */
  completed: boolean;
  /** Current subscribers (React components listening). */
  subscribers: Set<StreamSubscriber>;
  /** Abort controller for the fetch. */
  abort: AbortController;
  /** Final accumulated text from token/replace events. */
  text: string;
}

/** Handle returned by subscribe — unsubscribe callback plus the id of the
 * stream the callback is attached to. Consumers need the id to match
 * per-stream lifecycle events (e.g. crew:stream_state) across concurrent
 * streams that share the same (sessionId, topic). */
export interface StreamSubscription {
  unsub: () => void;
  streamId: number;
}

/** Track all active streams so isActive reports true while ANY is running. */
const activeStreams = new Set<ManagedStream>();

const streams = new Map<string, ManagedStream>();

let nextStreamId = 1;

function streamKey(sessionId: string, topic?: string): string {
  const normalizedTopic = normalizeTopic(topic);
  return normalizedTopic ? `${sessionId}#${normalizedTopic}` : sessionId;
}

function createManagedStream(sessionId: string, topic?: string): ManagedStream {
  const abort = new AbortController();
  const normalizedTopic = normalizeTopic(topic);
  const id = nextStreamId++;
  const stream: ManagedStream = {
    id,
    sessionId,
    topic: normalizedTopic,
    events: [],
    active: true,
    completed: false,
    subscribers: new Set(),
    abort,
    text: "",
  };
  // The streams map holds the LATEST stream per session/topic. Previous
  // streams keep running independently via their own fetch reference.
  streams.set(streamKey(sessionId, normalizedTopic), stream);
  activeStreams.add(stream);
  window.dispatchEvent(
    new CustomEvent("crew:stream_state", {
      detail: { sessionId, topic: normalizedTopic, active: true, streamId: id },
    }),
  );
  return stream;
}

async function consumeSseResponse(
  stream: ManagedStream,
  resp: Response,
): Promise<void> {
  if (!resp.ok || !resp.body) {
    stream.active = false;
    return;
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    stream.active = false;
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        let event: SseEvent;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "token") {
          stream.text += event.text;
        } else if (event.type === "replace") {
          stream.text = event.text;
        } else if (event.type === "done") {
          if (event.content) stream.text = event.content;
          stream.completed = true;
        }

        const streamEvent: StreamEvent = { raw: event };
        stream.events.push(streamEvent);
        for (const sub of stream.subscribers) {
          try {
            sub(streamEvent);
          } catch {
            // ignore subscriber error
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function finalizeStream(sessionId: string, stream: ManagedStream): void {
  stream.active = false;
  activeStreams.delete(stream);

  // Dispatch with streamId so subscribers that race concurrent streams on
  // the same (sessionId, topic) can tell whose lifecycle event this is.
  // Without streamId, a fast sibling stream finishing first would trip
  // every subscriber's cleanup path — unsubscribing them from their own
  // still-running stream.
  window.dispatchEvent(
    new CustomEvent("crew:stream_state", {
      detail: {
        sessionId,
        topic: stream.topic,
        active: false,
        streamId: stream.id,
      },
    }),
  );

  setTimeout(() => {
    stream.events = [];
  }, 5000);
}

function runStreamFetch(
  sessionId: string,
  stream: ManagedStream,
  fetcher: () => Promise<Response>,
): void {
  (async () => {
    try {
      const resp = await fetcher();
      await consumeSseResponse(stream, resp);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.warn("[stream-manager] stream error:", err.message);
        const errorEvent: StreamEvent = {
          raw: { type: "error", message: err.message },
        };
        for (const cb of stream.subscribers) cb(errorEvent);
      }
    } finally {
      finalizeStream(sessionId, stream);
    }
  })();
}

/**
 * Start an SSE stream for a session. The stream runs independently
 * of React lifecycle. Call subscribe() to receive events.
 */
export function startStream(
  sessionId: string,
  message: string,
  media: string[],
  topic?: string,
  clientMessageId?: string,
  audioUploadMode?: "recording" | "upload",
): "started" {
  // Always start immediately — no client-side queuing.
  // Previous streams keep running independently via their own fetch reference.
  // The backend's queue mode (followup/collect/steer/interrupt) handles
  // concurrent messages server-side.
  const normalizedTopic = normalizeTopic(topic);
  const stream = createManagedStream(sessionId, normalizedTopic);

  const settings = getSettings();

  runStreamFetch(sessionId, stream, async () => {
    const searchHeaders: Record<string, string> = {
      "X-Search-Engine": settings.searchEngine,
    };
    if (settings.serperApiKey) {
      searchHeaders["X-Serper-Api-Key"] = settings.serperApiKey;
    }
    if (settings.crawl4aiUrl) {
      searchHeaders["X-Crawl4ai-Url"] = settings.crawl4aiUrl;
    }

    return fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildApiHeaders(),
        ...searchHeaders,
      },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        topic: normalizedTopic,
        client_message_id: clientMessageId,
        stream: true,
        media,
        audio_upload_mode: audioUploadMode,
      }),
      signal: stream.abort.signal,
    });
  });

  return "started";
}

/**
 * Reattach to an existing server-side stream for a session after refresh.
 */
export function attachStream(
  sessionId: string,
  topic?: string,
): "attached" | "busy" {
  const normalizedTopic = normalizeTopic(topic);
  const existing = streams.get(streamKey(sessionId, normalizedTopic));
  if (existing?.active) return "busy";

  const stream = createManagedStream(sessionId, normalizedTopic);

  runStreamFetch(sessionId, stream, () =>
    fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildApiHeaders(),
      },
      body: JSON.stringify({
        message: "",
        session_id: sessionId,
        topic: normalizedTopic,
        stream: true,
        media: [],
        attach_only: true,
      }),
      signal: stream.abort.signal,
    }),
  );

  return "attached";
}

/**
 * Subscribe to a session's stream. Replays all past events immediately,
 * then delivers new events as they arrive.
 *
 * Returns `{ unsub, streamId }` so the caller can correlate lifecycle
 * events (crew:stream_state) with the specific stream it subscribed to.
 * Returns null when no stream exists for the session/topic.
 */
export function subscribe(
  sessionId: string,
  callback: StreamSubscriber,
  topic?: string,
): StreamSubscription | null {
  const stream = streams.get(streamKey(sessionId, topic));
  if (!stream) return null;

  // Replay past events
  for (const event of stream.events) {
    try {
      callback(event);
    } catch {
      // ignore
    }
  }

  // Subscribe for future events
  stream.subscribers.add(callback);

  return {
    unsub: () => {
      stream.subscribers.delete(callback);
    },
    streamId: stream.id,
  };
}

/** Check if a session has an active or completed stream. */
export function hasStream(sessionId: string): boolean {
  return [...streams.values()].some((stream) => stream.sessionId === sessionId);
}

/** Check if a session has any active stream. */
export function isActive(sessionId: string, topic?: string): boolean {
  const normalizedTopic = normalizeTopic(topic);
  return [...activeStreams].some(
    (s) =>
      s.sessionId === sessionId &&
      (normalizedTopic === undefined || s.topic === normalizedTopic),
  );
}

/** Get the current accumulated text for a session. */
export function getText(sessionId: string, topic?: string): string {
  return streams.get(streamKey(sessionId, topic))?.text ?? "";
}

/** Check if stream completed normally. */
export function isCompleted(sessionId: string, topic?: string): boolean {
  return streams.get(streamKey(sessionId, topic))?.completed ?? false;
}

/** Clean up a session's stream (e.g., on session delete). */
export function destroyStream(sessionId: string, topic?: string): void {
  const normalizedTopic = normalizeTopic(topic);
  const matchingStreams = [...streams.entries()].filter(([, stream]) => {
    if (stream.sessionId !== sessionId) return false;
    return normalizedTopic === undefined || stream.topic === normalizedTopic;
  });
  for (const [key, stream] of matchingStreams) {
    if (stream.active) stream.abort.abort();
    streams.delete(key);
  }
}
