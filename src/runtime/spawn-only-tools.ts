/**
 * Canonical set of `spawn_only` tool names known to the SPA.
 *
 * spawn_only tools are background skills whose foreground `tool/completed`
 * envelope fires ~2ms after `tool/started` (it's only an acknowledgement
 * that the supervisor accepted the work) — the actual background task
 * keeps running for seconds or minutes. The terminal signal for the
 * tool-card chip is `task/updated:completed` (or `task/updated:failed`),
 * not the foreground `tool/completed`.
 *
 * The router consults this set in `handleToolCompleted` to skip the
 * premature `status: complete` flip; `handleTaskUpdated` then drives the
 * real terminal transition once the background task settles.
 *
 * Sources of truth for the names below:
 *   - `crates/app-skills/.../manifest.json` entries with `spawn_only: true`
 *   - `crates/platform-skills/voice/manifest.json` (`voice_synthesize`)
 *   - `crates/octos-agent/src/workspace_contract.rs` (`fm_tts`,
 *     `podcast_generate`)
 *   - the pipeline / deep-search supervisors which run as spawn_only via
 *     `mark_spawn_only` in `crates/octos-agent/src/tools/registry.rs`
 *
 * Keep this list synchronized when new spawn_only tools land on the
 * agent side. The set is checked by exact string equality on the
 * server-emitted `tool_name` field, so abbreviations / aliases don't
 * resolve here.
 */
export const SPAWN_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "run_pipeline",
  "podcast_generate",
  "mofa_slides",
  "mofa_cards",
  "mofa_comic",
  "mofa_infographic",
  "mofa_frame",
  "voice_synthesize",
  "fm_tts",
  "deep_search",
]);

/** Returns true when `toolName` is a known spawn_only background tool.
 *  Safe to call with `undefined` / empty strings — returns false. */
export function isSpawnOnlyToolName(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  return SPAWN_ONLY_TOOL_NAMES.has(toolName);
}
