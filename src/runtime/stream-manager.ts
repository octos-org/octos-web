/**
 * Session-scoped SSE stream manager.
 *
 * Keeps SSE connections alive independently of React component lifecycle.
 * React components subscribe/unsubscribe without killing the underlying stream.
 */

import { getToken } from "@/api/client";
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
  /** Queued messages waiting for this stream to finish. */
  _queued?: { message: string; media: string[] }[];
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
): "started" | "queued" {
  // If there's already an active stream for this session, queue this message
  // and start a new stream when the current one finishes.
  const existing = streams.get(sessionId);
  if (existing?.active) {
    // Store the queued message — it will be sent when the current stream ends
    if (!existing._queued) existing._queued = [];
    existing._queued.push({ message, media });
    return "queued";
  }

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
  window.dispatchEvent(
    new CustomEvent("crew:stream_state", {
      detail: { sessionId, active: true },
    }),
  );

  const token = getToken();
  const settings = getSettings();

  // Run fetch in background — NOT tied to any React component
  (async () => {
    try {
      const searchHeaders: Record<string, string> = {
        "X-Search-Engine": settings.searchEngine,
      };
      if (settings.serperApiKey) {
        searchHeaders["X-Serper-Api-Key"] = settings.serperApiKey;
      }
      if (settings.crawl4aiUrl) {
        searchHeaders["X-Crawl4ai-Url"] = settings.crawl4aiUrl;
      }

      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...searchHeaders,
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
      window.dispatchEvent(
        new CustomEvent("crew:stream_state", {
          detail: { sessionId, active: false },
        }),
      );
      // Clean up event buffer after completion to prevent memory leak.
      // Keep only the final text, drop individual events.
      setTimeout(() => {
        stream.events = [];
      }, 5000);

      // Process queued messages — start a new stream for the next one
      const queued = stream._queued;
      if (queued && queued.length > 0) {
        const next = queued.shift()!;
        stream._queued = queued.length > 0 ? queued : undefined;
        // Small delay to let the adapter's done handler finish
        setTimeout(() => startStream(sessionId, next.message, next.media), 100);
      }
    }
  })();

  return "started";
}

/**
 * Wait for a NEW stream to start for a session (after a queued message).
 * Resolves when the stream is created and active.
 */
export function waitForNewStream(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const stream = streams.get(sessionId);
      if (stream?.active && stream.events.length === 0) {
        // Fresh stream just started
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    // Listen for stream_state event
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId && detail?.active) {
        window.removeEventListener("crew:stream_state", handler);
        // Small delay to let the stream object be set up
        setTimeout(resolve, 50);
      }
    };
    window.addEventListener("crew:stream_state", handler);
    // Timeout: if no new stream in 60s, resolve anyway to prevent hanging
    setTimeout(() => {
      window.removeEventListener("crew:stream_state", handler);
      resolve();
    }, 60000);
  });
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

/**
 * Subscribe to a session's stream WITHOUT replaying past events.
 * Used for queued messages that need to wait for a fresh stream.
 */
export function subscribeNew(
  sessionId: string,
  callback: StreamSubscriber,
): (() => void) | null {
  const stream = streams.get(sessionId);
  if (!stream) return null;

  // No replay — only future events
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
