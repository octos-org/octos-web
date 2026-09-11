import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2FileRef,
} from "./projection-envelope-v2";
import { parseProjectionEnvelopeV2 } from "./projection-envelope-v2";
import type { HydratedMessage, SessionHydrateResult } from "./ui-protocol-types";

function fileMime(path: string): string {
  const normalized = path.toLowerCase().split("?")[0];
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".wav")) return "audio/wav";
  if (normalized.endsWith(".mp3")) return "audio/mpeg";
  if (normalized.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function fileRefs(media: readonly string[] | undefined): ProjectionEnvelopeV2FileRef[] {
  return (media ?? []).map((path) => ({
    path,
    mime: fileMime(path),
    // HydratedMessage does not expose the persisted byte size. Zero means
    // unknown; render adapters only need path and mime.
    size_bytes: 0,
  }));
}

function messageThreadId(message: HydratedMessage): string | null {
  return message.thread_id
    ?? message.turn_id
    ?? message.client_message_id
    ?? null;
}

/**
 * Convert the Stage-5 server's durable hydrate rows into the sole canonical
 * web projection. This is a receive-boundary compatibility adapter, not a
 * second render store.
 */
export function hydrateProjectionEnvelopes(
  sessionId: string,
  topic: string | undefined,
  hydrate: SessionHydrateResult,
): ProjectionEnvelopeV2[] | null {
  const canonical =
    hydrate.projection_snapshot?.envelopes ?? hydrate.projection_envelopes;
  if (canonical !== undefined) {
    return canonical
      .map((frame) => parseProjectionEnvelopeV2(frame))
      .filter(
        (parsed): parsed is { ok: true; value: ProjectionEnvelopeV2 } =>
          parsed.ok,
      )
      .map((parsed) => parsed.value)
      .filter((envelope) => {
        if (envelope.session_id !== sessionId) return false;
        const snapshotTopic = envelope.topic?.trim() || undefined;
        const requestedTopic = topic?.trim() || undefined;
        return snapshotTopic === undefined || snapshotTopic === requestedTopic;
      });
  }

  if (hydrate.messages === undefined) return null;

  const envelopes: ProjectionEnvelopeV2[] = [];
  const transcriptThreadOrder = new Map<string, number>();
  const nextSeqByThread = new Map<string, number>();
  const nextSeq = (threadId: string) => {
    const seq = (nextSeqByThread.get(threadId) ?? 0) + 1;
    nextSeqByThread.set(threadId, seq);
    return seq;
  };
  const normalizedTopic = topic?.trim() || undefined;
  const parseRetained = (frame: unknown) => parseProjectionEnvelopeV2({
    session_id: sessionId,
    ...(normalizedTopic ? { topic: normalizedTopic } : {}),
    ...(typeof frame === "object" && frame !== null ? frame : {}),
  });

  for (const message of [...hydrate.messages].sort((left, right) =>
    left.seq - right.seq)) {
    const threadId = messageThreadId(message);
    if (!threadId) continue;
    if (!transcriptThreadOrder.has(threadId)) {
      transcriptThreadOrder.set(threadId, transcriptThreadOrder.size);
    }
    const turnId = message.turn_id ?? message.thread_id ?? threadId;
    const common = {
      session_id: sessionId,
      ...(normalizedTopic ? { topic: normalizedTopic } : {}),
      thread_id: threadId,
      turn_id: turnId,
      ...(message.client_message_id
        ? { client_message_id: message.client_message_id }
        : {}),
    };

    if (message.role === "user") {
      envelopes.push({
        ...common,
        seq: nextSeq(threadId),
        payload: {
          type: "user_message",
          data: { text: message.content, files: fileRefs(message.media), persisted_at: message.persisted_at },
        },
      });
      continue;
    }
    if (message.role !== "assistant") continue;

    const messageId = message.message_id
      ?? `${sessionId}:hydrate:${message.seq}`;
    envelopes.push({
      ...common,
      seq: nextSeq(threadId),
      payload: {
        type: "assistant_persisted",
        data: {
          text: message.content,
          assistant_segment_id: messageId,
          meta: {
            message_id: messageId,
            persisted_at: message.persisted_at,
            ...(message.media?.length ? { media: [...message.media] } : {}),
          },
        },
      },
    });
  }

  // The deployed server already returns these retained records in canonical
  // v2 form. Re-sequence them behind the durable transcript so the synthetic
  // snapshot remains contiguous even though transcript seq and envelope seq
  // use different coordinate systems.
  for (const frame of [
    ...(hydrate.replayed_tool_envelopes ?? []),
    ...(hydrate.replayed_envelopes ?? []),
  ]) {
    const parsed = parseRetained(frame);
    if (!parsed.ok || parsed.value.session_id !== sessionId) continue;
    const envelope = parsed.value;
    const frameTopic = envelope.topic?.trim() || undefined;
    if (frameTopic !== undefined && frameTopic !== normalizedTopic) continue;
    envelopes.push({
      ...envelope,
      ...(normalizedTopic ? { topic: normalizedTopic } : {}),
      seq: nextSeq(envelope.thread_id),
    });
  }

  if (hydrate.replayed_projection_envelopes !== undefined) {
    const retainedByThread = new Map<string, ProjectionEnvelopeV2[]>();
    for (const frame of hydrate.replayed_projection_envelopes) {
      const parsed = parseRetained(frame);
      if (!parsed.ok || parsed.value.session_id !== sessionId) continue;
      const envelope = parsed.value;
      if ((envelope.topic?.trim() || undefined) !== normalizedTopic) continue;
      const entries = retainedByThread.get(envelope.thread_id) ?? [];
      entries.push(envelope);
      retainedByThread.set(envelope.thread_id, entries);
    }
    const users = new Map(envelopes
      .filter((entry) => entry.payload.type === "user_message")
      .map((entry) => [entry.thread_id, entry]));
    const canonical: ProjectionEnvelopeV2[] = [];
    const replaced = new Set<string>();
    for (const [threadId, entries] of retainedByThread) {
      entries.sort((left, right) => left.seq - right.seq);
      // A bounded retained tail is not a complete thread snapshot. Keep the
      // transcript fallback for older threads whose beginning was evicted.
      if (entries.some((entry, index) => entry.seq !== index + 1)) {
        // A compacted/evicted event prefix falls back to durable transcript
        // rows. Preserve its terminal too; the server checkpoint separately
        // establishes the next live sequence after this reconstructed view.
        if (hydrate.projection_thread_sequences?.[threadId] !== undefined && users.has(threadId)) {
          for (const entry of entries) {
            if (entry.payload.type === "turn_terminal") envelopes.push({ ...entry, seq: nextSeq(threadId) });
          }
        }
        continue;
      }
      const terminal = entries.some((entry) => entry.payload.type === "turn_terminal");
      const user = users.get(threadId);
      // Rolled-back durable turns remain in the event log. Do not resurrect
      // their completed projection after a later hydrate.
      if (terminal && entries.some((entry) => entry.payload.type === "user_message") && !user) {
        replaced.add(threadId);
        continue;
      }
      replaced.add(threadId);
      canonical.push(...entries.map((entry) => {
        if (entry.payload.type !== "user_message" || user?.payload.type !== "user_message") return entry;
        return { ...entry, payload: { ...entry.payload, data: {
          ...entry.payload.data, persisted_at: user.payload.data.persisted_at,
        } } };
      }));
    }
    // Preserve exact retained coordinates. Re-sequencing a live thread's
    // transcript as 1,2 made its next seq=10 terminal look like a permanent
    // gap, stranding queues and optimistic messages (#353).
    // Complete retained turns can be older than compacted transcript turns.
    // Keep their transcript position when replacing the synthetic envelopes;
    // appending all retained turns made old questions reappear after the latest
    // answer. Stable sorting preserves each thread's canonical coordinates and
    // leaves live/background-only threads in their retained order at the end.
    return [...envelopes.filter((entry) => !replaced.has(entry.thread_id)), ...canonical]
      .sort((left, right) =>
        (transcriptThreadOrder.get(left.thread_id) ?? Number.MAX_SAFE_INTEGER)
        - (transcriptThreadOrder.get(right.thread_id) ?? Number.MAX_SAFE_INTEGER));
  }

  return envelopes;
}
