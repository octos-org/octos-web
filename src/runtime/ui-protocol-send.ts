/**
 * UI Protocol v1 send-path glue for /chat (Phase C-2).
 *
 * Flag-gated wrapper around the legacy SSE-bridge `sendMessage`. When the
 * `chat_app_ui_v1` flag is OFF (the default), this module just delegates
 * to the SSE bridge unchanged so the existing REST+SSE behaviour is bit-
 * for-bit preserved. When ON, the user message is mirrored into the
 * thread store and the turn is dispatched through `bridge.sendTurn(...)`.
 *
 * Image / voice upload stays on REST: the existing `sendMessage` already
 * uploads via `StreamManager.startStream` which posts to `/api/chat`. The
 * v1 path runs in parallel — a follow-up swaps the upload pre-step to a
 * direct REST call once the bridge owns the streaming-turn slice cleanly,
 * but for C-2 we keep the simplest possible split: only the streaming
 * transport changes.
 */

import * as ThreadStore from "@/store/thread-store";
import { isChatAppUiV1Enabled } from "@/lib/feature-flags";
import { displayFilenameFromPath } from "@/lib/utils";
import { sendMessage as legacySendMessage } from "./sse-bridge";
import type { SendOptions } from "./sse-bridge";
import { getActiveBridge } from "./ui-protocol-runtime";

export type { SendOptions } from "./sse-bridge";

export function sendMessage(opts: SendOptions): void {
  if (!isChatAppUiV1Enabled()) {
    legacySendMessage(opts);
    return;
  }
  void sendMessageV1(opts);
}

async function sendMessageV1(opts: SendOptions): Promise<void> {
  const {
    sessionId,
    historyTopic,
    text,
    media,
    clientMessageId = crypto.randomUUID(),
    onSessionActive,
    onComplete,
  } = opts;

  const bridge = getActiveBridge(sessionId, historyTopic);
  if (!bridge) {
    // Bridge has not started yet (rare race: send before mount effect ran).
    // Fall back to the SSE path so the user message is never lost — the
    // session is still functional, just not on the v1 transport for this
    // turn. The next turn will pick up the bridge.
    legacySendMessage(opts);
    return;
  }

  const localFiles = media.map((path) => ({
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  }));

  // Mirror the legacy bridge's user-message write so the thread store has
  // a thread anchored on this clientMessageId before any server event
  // arrives. The pendingAssistant slot is opened so streaming tokens land
  // in the right slot from the very first delta.
  ThreadStore.addUserMessage(sessionId, {
    text,
    clientMessageId,
    files: localFiles,
    topic: historyTopic,
  });

  onSessionActive?.(text);

  try {
    await bridge.sendTurn(clientMessageId, [
      { kind: "text", text },
      // File / voice attachments stay on REST in C-2 — the bridge schema
      // already accepts a TurnStartInput[] so a future PR can add file
      // references here without changing this call site.
    ]);
  } catch {
    // Surface as an error message in the thread so the user isn't left
    // with a silent dead pending bubble. The bridge already emits a
    // `warning` for transport-level failures; this just guarantees the
    // thread terminates rather than spinning forever.
    ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
  } finally {
    // The v1 path's `onComplete` resolves on `turn/completed` rather than
    // when the RPC returns (the RPC just acks acceptance). Wire a one-
    // shot listener for the completed event scoped to this turn id.
    if (onComplete) {
      const off = bridge.onTurnLifecycle((e) => {
        if (e.turn_id !== clientMessageId) return;
        if ("reason" in e || "error" in e) {
          off();
          onComplete();
        }
      });
    }
  }
}
