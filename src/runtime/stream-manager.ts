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

/** A single SSE event with its parsed data. */
export interface StreamEvent {
  raw: SseEvent;
}

/** Callback for stream subscribers. */
export type StreamSubscriber = (event: StreamEvent) => void;

/** State of a managed session stream. */
interface ManagedStream {
  sessionId: string;
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

/** Track all active streams so isActive reports true while ANY is running. */
const activeStreams = new Set<ManagedStream>();

const streams = new Map<string, ManagedStream>();

function createManagedStream(sessionId: string): ManagedStream {
  const abort = new AbortController();
  const stream: ManagedStream = {
    sessionId,
    events: [],
    active: true,
    completed: false,
    subscribers: new Set(),
    abort,
    text: "",
  };
  // The streams map holds the LATEST stream per session (for subscribe/isActive).
  // Previous streams keep running independently via their own fetch reference.
  streams.set(sessionId, stream);
  activeStreams.add(stream);
  window.dispatchEvent(
    new CustomEvent("crew:stream_state", {
      detail: { sessionId, active: true },
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

  // Only emit stream_state inactive when NO streams are active for this session.
  const anyActive = [...activeStreams].some((s) => s.sessionId === sessionId);
  if (!anyActive) {
    window.dispatchEvent(
      new CustomEvent("crew:stream_state", {
        detail: { sessionId, active: false },
      }),
    );
  }

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
  clientMessageId?: string,
  audioUploadMode?: "recording" | "upload",
): "started" {
  // Always start immediately — no client-side queuing.
  // Previous streams keep running independently via their own fetch reference.
  // The backend's queue mode (followup/collect/steer/interrupt) handles
  // concurrent messages server-side.
  const stream = createManagedStream(sessionId);

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
export function attachStream(sessionId: string): "attached" | "busy" {
  const existing = streams.get(sessionId);
  if (existing?.active) return "busy";

  const stream = createManagedStream(sessionId);

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
 * Returns an unsubscribe function.
 */
export function subscribe(
  sessionId: string,
  callback: StreamSubscriber,
): (() => void) | null {
  const stream = streams.get(sessionId);
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

  return () => {
    stream.subscribers.delete(callback);
  };
}

/** Check if a session has an active or completed stream. */
export function hasStream(sessionId: string): boolean {
  return streams.has(sessionId);
}

/** Check if a session has any active stream. */
export function isActive(sessionId: string): boolean {
  return [...activeStreams].some((s) => s.sessionId === sessionId);
}

/** Get the current accumulated text for a session. */
export function getText(sessionId: string): string {
  return streams.get(sessionId)?.text ?? "";
}

/** Check if stream completed normally. */
export function isCompleted(sessionId: string): boolean {
  return streams.get(sessionId)?.completed ?? false;
}

/** Clean up a session's stream (e.g., on session delete). */
export function destroyStream(sessionId: string): void {
  const stream = streams.get(sessionId);
  if (stream) {
    if (stream.active) stream.abort.abort();
    streams.delete(sessionId);
  }
}
