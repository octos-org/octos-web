// Browser probe for tests/voice-capture-subpath-assets.spec.ts. The spec's
// spawned Vite dev server (base /app/) serves this module, which mounts the
// REAL capture hook — exercising the exact asset URLs the hook derives,
// including the vad-web worklet/ONNX loads — and mirrors the hook's live
// state onto window.__vadProbe for the spec to assert on.
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useVoiceCapture } from "../../src/home/voice/use-voice-capture";

interface VadProbeState {
  started: boolean;
  done: boolean;
  capturing: boolean;
  error: string | null;
}

declare global {
  interface Window {
    __vadProbe: VadProbeState;
  }
}

window.__vadProbe = { started: false, done: false, capturing: false, error: null };

function Probe() {
  const { start, capturing, error } = useVoiceCapture();
  // No dep array: mirror the latest hook state after every render, so the
  // spec observes the post-settle capturing/error even though React commits
  // asynchronously relative to start()'s promise resolution.
  useEffect(() => {
    window.__vadProbe = { ...window.__vadProbe, capturing, error };
  });
  useEffect(() => {
    // start is a stable useCallback; the guard also covers StrictMode's
    // double effect invocation.
    if (window.__vadProbe.started) return;
    window.__vadProbe.started = true;
    start(() => {})
      .then(() => {
        window.__vadProbe.done = true;
      })
      .catch(() => {
        window.__vadProbe.done = true;
      });
  }, [start]);
  return null;
}

createRoot(document.createElement("div")).render(createElement(Probe));
