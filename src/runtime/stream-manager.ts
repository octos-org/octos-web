/**
 * Session-scoped SSE stream manager.
 *
 * Keeps SSE connections alive independently of React component lifecycle.
 * React components subscribe/unsubscribe without killing the underlying stream.
 */

import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
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

const streams = new Map<string, ManagedStream>();

/**
 * Start an SSE stream for a session. The stream runs independently
 * of React lifecycle. Call subscribe() to receive events.
 */
export function startStream(
  sessionId: string,
  message: string,
  media: string[],
): void {
  // If there's already an active stream for this session, don't start another
  const existing = streams.get(sessionId);
  if (existing?.active) return;

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
  streams.set(sessionId, stream);

  const token = getToken();

  // Run fetch in background — NOT tied to any React component
  (async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message,
          session_id: sessionId,
          stream: true,
          media,
        }),
        signal: abort.signal,
      });

      if (!resp.ok || !resp.body) {
        stream.active = false;
        return;
      }

      // Handle queued response
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

            // Track text state
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

            // Notify all current subscribers
            for (const sub of stream.subscribers) {
              try {
                sub(streamEvent);
              } catch {
                // subscriber error, ignore
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // fetch aborted or network error
    } finally {
      stream.active = false;
    }
  })();
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

/** Check if a session's stream is still active. */
export function isActive(sessionId: string): boolean {
  return streams.get(sessionId)?.active ?? false;
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
