export interface LearnDiagnosticEntry {
  timestamp: string;
  elapsedMs: number;
  event: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    __OCTOS_LEARN_TRACE__?: LearnDiagnosticEntry[];
    __OCTOS_EXPORT_LEARN_TRACE__?: () => string;
  }
}

const TRACE_LIMIT = 600;
const traceStart = globalThis.performance?.now?.() ?? Date.now();

function traceBuffer(): LearnDiagnosticEntry[] | null {
  if (
    !import.meta.env.DEV ||
    import.meta.env.MODE === "test" ||
    typeof window === "undefined"
  ) {
    return null;
  }
  window.__OCTOS_LEARN_TRACE__ ??= [];
  window.__OCTOS_EXPORT_LEARN_TRACE__ = () =>
    JSON.stringify(window.__OCTOS_LEARN_TRACE__ ?? [], null, 2);
  return window.__OCTOS_LEARN_TRACE__;
}

/**
 * Development-only, bounded diagnostics for the /learn delivery pipeline.
 * Callers deliberately provide metadata rather than learner content, images,
 * audio, tokens, or complete narration text.
 */
export function traceLearnDiagnostic(
  event: string,
  data: Record<string, unknown> = {},
): void {
  const buffer = traceBuffer();
  if (!buffer) return;
  const now = globalThis.performance?.now?.() ?? Date.now();
  const entry: LearnDiagnosticEntry = {
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round(now - traceStart),
    event,
    data,
  };
  buffer.push(entry);
  if (buffer.length > TRACE_LIMIT) {
    buffer.splice(0, buffer.length - TRACE_LIMIT);
  }
  console.info(`[learn-trace] ${event}`, data);
}
