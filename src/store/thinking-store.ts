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
 * authoritative server-side value. The send path can `await
 * whenThinkingSeeded(...)` so a send racing the open handshake does not
 * serialise a frame without the field and wrongly clear the override
 * (codex #261 P2).
 *
 * Unknown tiers: a NEWER server may persist a tier this client does not
 * know (e.g. a future "ultra"). The store keeps the RAW string and the
 * send path forwards it verbatim — narrowing it to null would omit the
 * field and destroy the newer-tier choice (codex #261 P2). The selector
 * renders the raw value as an extra option until the user explicitly
 * picks something else.
 *
 * `null` ≡ "default": the send path omits the field entirely.
 */

import { useSyncExternalStore } from "react";
import type { ReasoningEffortLevel } from "@/runtime/ui-protocol-types";

/** A stored tier: one of the known wire levels, or a raw string from a
 *  newer server that must be preserved round-trip. */
export type StoredEffort = ReasoningEffortLevel | (string & {});

const effortByKey = new Map<string, StoredEffort>();
/** Scopes whose server-persisted value has been observed (or is known
 *  not to be observable — topic scopes, legacy bridges). Send-side
 *  waiters gate on this, not on a value being present. */
const seededKeys = new Set<string>();
const listeners = new Set<() => void>();
const seedWaiters = new Map<string, Array<() => void>>();

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

export const KNOWN_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];

/** Normalize an untrusted wire value to a storable tier. Known levels
 *  and unknown non-empty strings are kept (unknown tiers must survive a
 *  round-trip through an older client); everything else is unset. */
export function asStoredEffort(value: unknown): StoredEffort | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getThinkingEffort(
  sessionId: string,
  topic?: string,
): StoredEffort | null {
  return effortByKey.get(storeKey(sessionId, topic)) ?? null;
}

/** Set (or clear with `null`) the session's thinking effort. */
export function setThinkingEffort(
  sessionId: string,
  effort: StoredEffort | null,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const current = effortByKey.get(key) ?? null;
  if (current !== effort) {
    if (effort === null) {
      effortByKey.delete(key);
    } else {
      effortByKey.set(key, effort);
    }
    notify();
  }
  markThinkingSeeded(sessionId, topic);
}

/** Mark a scope's restore as complete WITHOUT changing its value —
 *  used for scopes where no server restore is possible (topic buckets:
 *  `session/open` carries only the root session id, so the ack's
 *  `reasoning_effort` describes the ROOT bucket; and legacy bridges
 *  pre-dating `onSessionOpened`). */
export function markThinkingSeeded(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  if (!seededKeys.has(key)) {
    seededKeys.add(key);
  }
  const waiters = seedWaiters.get(key);
  if (waiters) {
    seedWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
}

/** Resolves once the scope's server restore has been observed (or was
 *  marked unobservable), or after `timeoutMs` as a fail-open bound so a
 *  send can never wedge on a handshake that never completes. */
export function whenThinkingSeeded(
  sessionId: string,
  topic: string | undefined,
  timeoutMs = 3000,
): Promise<void> {
  const key = storeKey(sessionId, topic);
  if (seededKeys.has(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiters = seedWaiters.get(key);
      if (waiters) {
        const next = waiters.filter((w) => w !== wrapped);
        if (next.length === 0) seedWaiters.delete(key);
        else seedWaiters.set(key, next);
      }
      resolve();
    }, timeoutMs);
    const wrapped = () => {
      clearTimeout(timer);
      resolve();
    };
    const waiters = seedWaiters.get(key) ?? [];
    waiters.push(wrapped);
    seedWaiters.set(key, waiters);
  });
}

export function useThinkingEffort(
  sessionId: string,
  topic?: string,
): StoredEffort | null {
  return useSyncExternalStore(
    subscribe,
    () => getThinkingEffort(sessionId, topic),
    () => getThinkingEffort(sessionId, topic),
  );
}

/** Test helper — clears all per-session state. */
export function __resetThinkingStoreForTest(): void {
  effortByKey.clear();
  seededKeys.clear();
  seedWaiters.clear();
  notify();
}
