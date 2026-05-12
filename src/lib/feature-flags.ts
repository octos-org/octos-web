/**
 * Client-side feature flags backed by `localStorage`.
 *
 * Each flag follows the same shape as the `projection_v1` flag in
 * `src/store/projection-store.ts`: cache-on-first-read so a mid-session
 * flip cannot start a feature partway through a request/response cycle,
 * with a test-only helper that resets both the cache and the storage key.
 *
 * Production default for every flag below is OFF. Flipping a flag on for
 * production is the job of a later phase PR (e.g. Phase D-4 flips the
 * aux-rest-to-ws flag default ON once the wrappers are battle-tested).
 */

// ---------------------------------------------------------------------------
// auxiliary.rest_to_ws.v1 — M12 Phase D-2
// ---------------------------------------------------------------------------
//
// When ON, REST callsites listed in the ADR
// (`docs/adr/m12-phase-d-auxiliary-rest-to-ws.md`, octos PR #910) route
// through the JSON-RPC WS bridge using the 13 methods landed in octos
// PR #912 under the `auxiliary.rest_to_ws.v1` capability. When OFF, the
// same callsites fall through to the existing REST helpers in
// `src/api/sessions.ts` / `src/api/content.ts` so the wire stays
// byte-identical to a pre-D-2 build.
//
// Cached on first read; mid-session flips do not take effect until the
// next page reload — matches `projection_v1` behavior. The cache-once
// pattern protects against a flip in the middle of a single RPC and
// against half-the-app-on / half-off routing within a page load. Phase
// D-3 panels that want to toggle the flag at runtime must reload to
// pick up the change (consistent with how `projection_v1` is flipped).

/** localStorage key gating Phase D-2 WS wrappers. Production default
 *  is OFF; Phase D-4 will flip the default. Tests flip via
 *  `__setAuxRestToWsV1ForTests`. */
export const AUX_REST_TO_WS_V1_FLAG_KEY = "octos_auxiliary_rest_to_ws_v1";

/** The on-the-wire capability string negotiated via the `?ui_feature=`
 *  query when this flag is on. Mirrors the server-side constant in
 *  `crates/octos-core/src/ui_protocol.rs`
 *  (`UI_PROTOCOL_FEATURE_AUXILIARY_REST_TO_WS_V1`). */
export const AUX_REST_TO_WS_V1_FEATURE = "auxiliary.rest_to_ws.v1";

let cachedAuxRestToWsV1: boolean | null = null;
let warnedAboutAuxRestToWsV1MidSessionChange = false;

function readAuxRestToWsV1FromStorage(): boolean {
  try {
    if (typeof globalThis === "undefined") return false;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    return ls.getItem(AUX_REST_TO_WS_V1_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Read the auxiliary-rest-to-ws-v1 flag. The first call latches the
 * observed value so a mid-session flip cannot start the wrapper using
 * the WS bridge for some calls and REST for others within the same
 * page load. A subsequent flip is a one-shot `console.warn` and is
 * otherwise ignored until the next reload.
 *
 * Mirrors `isProjectionV1Enabled` in `src/store/projection-store.ts`.
 */
export function isAuxRestToWsV1Enabled(): boolean {
  if (cachedAuxRestToWsV1 !== null) {
    if (!warnedAboutAuxRestToWsV1MidSessionChange) {
      const live = readAuxRestToWsV1FromStorage();
      if (live !== cachedAuxRestToWsV1) {
        warnedAboutAuxRestToWsV1MidSessionChange = true;
        console.warn(
          `[octos] ${AUX_REST_TO_WS_V1_FLAG_KEY} changed mid-session; ` +
            "the new value is ignored until reload to keep wrapper " +
            "routing consistent across the page load.",
        );
      }
    }
    return cachedAuxRestToWsV1;
  }
  cachedAuxRestToWsV1 = readAuxRestToWsV1FromStorage();
  return cachedAuxRestToWsV1;
}

/** Test helper: flip the flag in the current jsdom origin AND reset
 *  the cache so the next `isAuxRestToWsV1Enabled()` call re-reads it. */
export function __setAuxRestToWsV1ForTests(enabled: boolean): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      if (enabled) ls.setItem(AUX_REST_TO_WS_V1_FLAG_KEY, "1");
      else ls.removeItem(AUX_REST_TO_WS_V1_FLAG_KEY);
    }
  } catch {
    // No-op when storage is unavailable.
  }
  cachedAuxRestToWsV1 = null;
  warnedAboutAuxRestToWsV1MidSessionChange = false;
}
