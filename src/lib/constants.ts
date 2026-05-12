export const API_BASE = "";
export const TOKEN_KEY = "octos_session_token";
export const ADMIN_TOKEN_KEY = "octos_auth_token";

// ---------------------------------------------------------------------------
// M12 Phase D-2 — server-side caps mirrored client-side.
//
// `session/messages_page` and `GET /api/sessions/:id/messages` both clamp
// `limit` to 500 and `offset` to 10_000 on the server (see
// `crates/octos-cli/src/api/handlers.rs:637-638`). The auxiliary REST-to-WS
// wrappers in `src/api/sessions.ts` clamp client-side too so the synthesized
// pagination metadata in the REST fallback path matches the metadata the
// server returns over WS — otherwise `getMessagesPage(id, 1000)` would
// report `next_offset = 1000` over REST but `next_offset = 500` over WS.
//
// `content/bulk_delete` is capped at 256 IDs server-side (see the WS
// dispatcher in `crates/octos-cli/src/api/ui_protocol.rs`). The REST
// endpoint has no equivalent cap; the wrapper chunks client-side so a
// 1000-ID delete succeeds on both transports.
// ---------------------------------------------------------------------------
export const MESSAGES_PAGE_LIMIT_CAP = 500;
export const MESSAGES_PAGE_OFFSET_CAP = 10_000;
export const CONTENT_BULK_DELETE_BATCH_SIZE = 256;
