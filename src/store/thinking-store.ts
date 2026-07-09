/**
 * Per-session reasoning/thinking effort store (web parity for the TUI
 * `/thinking` command; octos P2 parity item).
 *
 * Single source of truth for the composer's thinking selector AND the
 * send path: `buildTurnStartExtras` reads the current value at send
 * time so EVERY user turn carries the chosen effort. That is load-
 * bearing, not cosmetic — the server treats a user turn that OMITS
 * `reasoning_effort` as "the user chose default" and CLEARS the
 * persisted override, so a single surface sending without the field
 * (voice, studio rail) would silently reset the user's choice. Reading
 * the store centrally in the send path keeps all three send surfaces
 * consistent.
 *
 * Seeding: the bridge surfaces the server-persisted value from the
 * `session/open` ack (`opened.reasoning_effort`), and the runtime layer
 * seeds this store — so a page reload or reconnect restores the
 * selector to the authoritative server-side value.
 *
 * `null` ≡ "default": the send path omits the field entirely.
 */

import { useSyncExternalStore } from "react";
import type { ReasoningEffortLevel } from "@/runtime/ui-protocol-types";

const effortByKey = new Map<string, ReasoningEffortLevel>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

const WIRE_LEVELS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];

/** Narrow an untrusted wire value to a known effort level. Unknown
 *  strings (a future server tier) are treated as unset rather than
 *  poisoning the selector state. */
export function asReasoningEffortLevel(
  value: unknown,
): ReasoningEffortLevel | null {
  return WIRE_LEVELS.includes(value as ReasoningEffortLevel)
    ? (value as ReasoningEffortLevel)
    : null;
}

export function getThinkingEffort(
  sessionId: string,
  topic?: string,
): ReasoningEffortLevel | null {
  return effortByKey.get(storeKey(sessionId, topic)) ?? null;
}

/** Set (or clear with `null`) the session's thinking effort. */
export function setThinkingEffort(
  sessionId: string,
  effort: ReasoningEffortLevel | null,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const current = effortByKey.get(key) ?? null;
  if (current === effort) return;
  if (effort === null) {
    effortByKey.delete(key);
  } else {
    effortByKey.set(key, effort);
  }
  notify();
}

export function useThinkingEffort(
  sessionId: string,
  topic?: string,
): ReasoningEffortLevel | null {
  return useSyncExternalStore(
    subscribe,
    () => getThinkingEffort(sessionId, topic),
    () => getThinkingEffort(sessionId, topic),
  );
}

/** Test helper — clears all per-session state. */
export function __resetThinkingStoreForTest(): void {
  effortByKey.clear();
  notify();
}
