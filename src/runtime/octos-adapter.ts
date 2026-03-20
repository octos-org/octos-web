import type {
  ChatModelAdapter,
  ChatModelRunResult,
} from "@assistant-ui/react";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import type { SseEvent } from "@/api/types";

/** Extract text from message content parts. */
function extractText(
  msg: { content: readonly { type: string; text?: string }[] } | undefined,
): string {
  if (!msg?.content) return "";
  return msg.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof (p as { text?: string }).text === "string",
    )
    .map((p) => p.text)
    .join("");
}

export function createOctosAdapter(
  getSessionId: () => string,
  onMessageComplete?: () => void,
  getPendingMedia?: () => string[],
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      console.log("[adapter] run() called, messages:", messages.length, "history:", messages.map(m => ({ role: m.role, text: extractText(m).slice(0, 50) })));
      const token = getToken();
      const sessionId = getSessionId();
      console.log("[adapter] sessionId:", sessionId);
      const lastMsg = messages[messages.length - 1];
      const userText = extractText(lastMsg);
      console.log("[adapter] userText:", userText.slice(0, 100));

      // Streaming POST — each request gets its own isolated event stream
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: userText,
          session_id: sessionId,
          stream: true,
          media: getPendingMedia?.() ?? [],
        }),
        signal: abortSignal,
      });

      console.log("[adapter] fetch response:", resp.status, resp.headers.get("content-type"));
      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[adapter] fetch error:", resp.status, errText);
        throw new Error(errText || `HTTP ${resp.status}`);
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const toolCalls = new Map<
        string,
        { toolCallId: string; toolName: string; status: string }
      >();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!; // keep incomplete line

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

            console.log("[adapter] SSE event:", event.type, "replace" in event ? (event as { text?: string }).text?.slice(0, 80) : "");
            switch (event.type) {
              case "token":
                text += event.text;
                yield buildResult(text, toolCalls);
                break;

              case "replace":
                // Full-text replacement (streamed edits from gateway)
                text = event.text;
                yield buildResult(text, toolCalls);
                break;

              case "tool_start":
                toolCalls.set(event.tool, {
                  toolCallId: `tc_${event.tool}_${Date.now()}`,
                  toolName: event.tool,
                  status: "running",
                });
                yield buildResult(text, toolCalls);
                break;

              case "tool_end": {
                const tc = toolCalls.get(event.tool);
                if (tc) tc.status = event.success ? "complete" : "error";
                yield buildResult(text, toolCalls);
                break;
              }

              case "tool_progress":
                window.dispatchEvent(
                  new CustomEvent("crew:tool_progress", {
                    detail: { tool: event.tool, message: event.message },
                  }),
                );
                break;

              case "thinking":
                window.dispatchEvent(
                  new CustomEvent("crew:thinking", {
                    detail: { thinking: true, iteration: event.iteration },
                  }),
                );
                break;

              case "response":
                window.dispatchEvent(
                  new CustomEvent("crew:thinking", {
                    detail: { thinking: false, iteration: event.iteration },
                  }),
                );
                break;

              case "cost_update":
                window.dispatchEvent(
                  new CustomEvent("crew:cost", { detail: event }),
                );
                break;

              case "done":
                // The done event carries the authoritative final content.
                // Always use it when non-empty — it replaces any streamed tool
                // progress markers that may linger from the streaming phase.
                if (event.content) {
                  text = event.content;
                  yield buildResult(text, toolCalls);
                }
                break;

              case "error":
                throw new Error(
                  (event as { message?: string }).message || "Agent error",
                );

              case "stream_end":
                // Stream will close naturally via the done event
                break;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Strip residual tool progress lines from final text.
      // Tool progress (⚙ `tool`..., ✓ `tool`, ✗ `tool`) is transient — it should
      // be replaced by the final LLM response, but race conditions with the stream
      // forwarder can leave stale progress lines in the text.
      if (text) {
        const lines = text.split("\n");
        const cleaned = lines.filter(
          (line) => !/^[✓✗⚙📄]\s*`/.test(line.trim())
        );
        if (cleaned.length < lines.length) {
          text = cleaned.join("\n").trim();
          yield buildResult(text, toolCalls);
        }
      }

      console.log("[adapter] stream ended, final text:", text.slice(0, 100));

      // Clear thinking state
      window.dispatchEvent(
        new CustomEvent("crew:thinking", {
          detail: { thinking: false, iteration: 0 },
        }),
      );

      console.log("[adapter] calling onMessageComplete");
      onMessageComplete?.();
    },
  };
}

function buildResult(
  text: string,
  toolCalls: Map<
    string,
    { toolCallId: string; toolName: string; status: string }
  >,
): ChatModelRunResult {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, never>;
        argsText: string;
      }
  > = [];

  if (text) {
    content.push({ type: "text", text });
  }

  for (const tc of toolCalls.values()) {
    content.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: {},
      argsText: "{}",
    });
  }

  return { content };
}
