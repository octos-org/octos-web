/**
 * Feature flag helpers (Phase C-3, issue #69).
 *
 * Mirrors the inline `localStorage.getItem("octos_thread_store_v2") === "1"`
 * pattern used by the M8.10 thread-store rollout. Each flag is OFF by default
 * and opt-in via `localStorage.setItem('<name>', '1')` in DevTools. Reads are
 * fresh on every call so toggling does not require a page reload, and any
 * environment without `window` (SSR, tests without `jsdom`) returns false.
 *
 * `chat_app_ui_v1` gates the UI Protocol v1 transport rollout (Phase C-2 wires
 * the flag into the chat surface; this PR is scaffolding only).
 */

const CHAT_APP_UI_V1 = "chat_app_ui_v1";

function readFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(name) === "1";
  } catch {
    return false;
  }
}

export function isChatAppUiV1Enabled(): boolean {
  return readFlag(CHAT_APP_UI_V1);
}
