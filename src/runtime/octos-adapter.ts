import type {
  ChatModelAdapter,
  ChatModelRunResult,
} from "@assistant-ui/react";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import type { SseEvent } from "@/api/types";

/** Strip <think>...</think> blocks from streaming text.
 *  Handles unclosed <think> (still streaming) by hiding from that point. */
function stripThink(text: string): string {
  // Remove complete <think>...</think> blocks
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  // Hide unclosed <think> (still streaming)
  const openIdx = result.lastIndexOf("<think>");
  if (openIdx !== -1 && result.indexOf("</think>", openIdx) === -1) {
    result = result.slice(0, openIdx);
  }
  return result.trim();
}

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

      // Handle queued response — message was accepted but a previous
      // request's SSE stream is still active. Show acknowledgment.
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await resp.json();
        if (json.status === "queued") {
          yield { content: [{ type: "text" as const, text: "⏳ Processing..." }] };
          // Poll for response — the queued message will be processed after current request completes
          for (let poll = 0; poll < 180; poll++) {
            await new Promise((r) => setTimeout(r, 5000));
            try {
              const pollResp = await fetch(
                `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=3`,
                { headers: token ? { Authorization: `Bearer ${token}` } : {} },
              );
              if (pollResp.ok) {
                const pollMsgs = (await pollResp.json()) as {
                  role: string;
                  content: string;
                }[];
                // Check if there's a new assistant response after our queued message
                const lastAssistant = [...pollMsgs]
                  .reverse()
                  .find((m) => m.role === "assistant" && m.content.length > 20);
                if (lastAssistant) {
                  yield buildResult(lastAssistant.content, new Map());
                  onMessageComplete?.();
                  return;
                }
              }
            } catch {
              // keep polling
            }
          }
          return;
        }
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const toolCalls = new Map<
        string,
        { toolCallId: string; toolName: string; status: string }
      >();
      let buffer = "";
      const fileLinks: string[] = [];

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
                yield buildResult(stripThink(text), toolCalls);
                break;

              case "replace":
                // Full-text replacement (streamed edits from gateway)
                text = event.text;
                yield buildResult(stripThink(text), toolCalls);
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

              case "file": {
                // File produced by pipeline — collect for appending after done
                const fileEvent = event as { path?: string; filename?: string; caption?: string };
                if (fileEvent.path && fileEvent.filename) {
                  const fileUrl = `${API_BASE}/api/files/${encodeURIComponent(fileEvent.path)}`;
                  const caption = fileEvent.caption ? ` — ${fileEvent.caption}` : "";
                  fileLinks.push(`\n\n📄 [${fileEvent.filename}](${fileUrl})${caption}`);
                }
                break;
              }

              case "done":
                // The done event carries the authoritative final content.
                if (event.content) {
                  text = stripThink(event.content);
                }
                // Append any file download links collected during streaming
                if (fileLinks.length > 0) {
                  text += fileLinks.join("");
                }
                // Dispatch message metadata (model, tokens, duration)
                if (event.model || event.tokens_in || event.tokens_out) {
                  window.dispatchEvent(
                    new CustomEvent("crew:message_meta", {
                      detail: {
                        model: event.model || "",
                        tokens_in: event.tokens_in || 0,
                        tokens_out: event.tokens_out || 0,
                        duration_s: event.duration_s || 0,
                      },
                    }),
                  );
                }
                yield buildResult(text, toolCalls);
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

      // If stream ended without content (connection dropped during long pipeline),
      // poll the session messages API to recover the response.
      if (!text || text.length < 10) {
        console.log("[adapter] stream ended with no content, polling session for response...");
        for (let poll = 0; poll < 180; poll++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const pollResp = await fetch(
              `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=3`,
              { headers: token ? { Authorization: `Bearer ${token}` } : {} },
            );
            if (pollResp.ok) {
              const pollMsgs = (await pollResp.json()) as {
                role: string;
                content: string;
              }[];
              // Find the latest assistant message
              const lastAssistant = [...pollMsgs]
                .reverse()
                .find((m) => m.role === "assistant" && m.content.length > 20);
              if (lastAssistant) {
                console.log(
                  "[adapter] recovered response via polling:",
                  lastAssistant.content.slice(0, 100),
                );
                text = lastAssistant.content;
                if (fileLinks.length > 0) {
                  text += fileLinks.join("");
                }
                yield buildResult(text, toolCalls);
                break;
              }
            }
          } catch {
            // polling failed, keep trying
          }
        }
      }

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
