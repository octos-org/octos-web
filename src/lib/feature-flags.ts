/**
 * Client-side feature flags backed by `localStorage`.
 *
 * Each flag is cached on first read so a mid-session flip cannot start a
 * feature partway through a request/response cycle, with a test-only helper
 * that resets both the cache and the storage key.
 *
 * Production defaults vary per flag — see each flag's doc comment. Some
 * flags ship OFF until a cutover phase flips them ON (e.g. Phase C
 * flipped `chat_app_ui_v1` from OFF to ON before deleting the flag in
 * octos-web PR #66; Phase D-4 flips `auxiliary_rest_to_ws_v1` from OFF
 * to ON below).
 */

// ---------------------------------------------------------------------------
// auxiliary.rest_to_ws.v1 — M12 Phase D-2 (wrappers), Phase D-4 (default ON)
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
// **Phase D-4 cutover (this commit): default is now ON.**
//
// Migration semantics for the localStorage key:
//   - UNSET (no entry in localStorage) → treat as ON. This is the new
//     default and applies to every existing user on first page load
//     after the cutover ships.
//   - "0" / "false" / "off" (case-insensitive, whitespace trimmed) →
//     OFF. This is the emergency-rollback escape hatch: a user who
//     hits a bug in the WS wrappers can
//     `localStorage.setItem("octos_auxiliary_rest_to_ws_v1", "0")` in
//     devtools and the next page reload restores the pre-D-4 REST
//     behavior. `"false"`, `"FALSE"`, `" 0 "`, and `"off"` all work.
//   - Any other value (`"1"`, `"true"`, `"yes"`, garbage, etc.) → ON.
//     Opt-out is a positive match on the known disable tokens — stale
//     experimental values from earlier phases (e.g. `"true"`,
//     `"enabled"`) that used to mean ON now correctly stay ON instead
//     of silently flipping a user back to REST.
//
// Cached on first read; mid-session flips do not take effect until the
// next page reload. The cache-once
// pattern protects against a flip in the middle of a single RPC and
// against half-the-app-on / half-off routing within a page load.

/** localStorage key gating Phase D-2 WS wrappers. Production default
 *  is ON as of Phase D-4 — see the migration-semantics comment block
 *  above. Tests flip via `__setAuxRestToWsV1ForTests`. */
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
    if (typeof globalThis === "undefined") return true;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return true;
    const raw = ls.getItem(AUX_REST_TO_WS_V1_FLAG_KEY);
    // UNSET → ON (new default). Otherwise, only an explicit "0",
    // "false", or "off" (case-insensitive, whitespace trimmed) opts
    // out. Any other value (including "true", "yes", garbage) → ON.
    if (raw === null) return true;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "0" || trimmed === "false" || trimmed === "off") {
      return false;
    }
    return true;
  } catch {
    // Some jsdom configurations throw on `localStorage` access (security
    // origin checks). Treat unreachable storage as flag-on, matching
    // the new default.
    return true;
  }
}

/**
 * Read the auxiliary-rest-to-ws-v1 flag. The first call latches the
 * observed value so a mid-session flip cannot start the wrapper using
 * the WS bridge for some calls and REST for others within the same
 * page load. A subsequent flip is a one-shot `console.warn` and is
 * otherwise ignored until the next reload.
 *
 * This is independent of negotiated protocol capabilities.
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
 *  the cache so the next `isAuxRestToWsV1Enabled()` call re-reads it.
 *
 *  - `enabled=true`  → writes `"1"` to localStorage (explicit ON).
 *  - `enabled=false` → writes `"0"` (explicit OFF). NOTE: prior to
 *    Phase D-4 this used `removeItem`, but the default is now ON so
 *    removing the key would leave the flag ON. Tests that want the
 *    OFF leg of the wrapper must explicitly opt out. */
export function __setAuxRestToWsV1ForTests(enabled: boolean): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      if (enabled) ls.setItem(AUX_REST_TO_WS_V1_FLAG_KEY, "1");
      else ls.setItem(AUX_REST_TO_WS_V1_FLAG_KEY, "0");
    }
  } catch {
    // No-op when storage is unavailable.
  }
  cachedAuxRestToWsV1 = null;
  warnedAboutAuxRestToWsV1MidSessionChange = false;
}

/** Test-only helper: clear the localStorage key entirely so the next
 *  `isAuxRestToWsV1Enabled()` call exercises the UNSET → default-ON
 *  path. Distinct from `__setAuxRestToWsV1ForTests(false)`, which
 *  writes an explicit opt-out value. */
export function __clearAuxRestToWsV1ForTests(): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) ls.removeItem(AUX_REST_TO_WS_V1_FLAG_KEY);
  } catch {
    // No-op when storage is unavailable.
  }
  cachedAuxRestToWsV1 = null;
  warnedAboutAuxRestToWsV1MidSessionChange = false;
}
