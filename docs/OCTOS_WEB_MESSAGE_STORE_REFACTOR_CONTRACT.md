# octos-web message-store refactor contract

Status: active. Phase 1 + 2 landed in `refactor/message-store-phases-1-4`.

## Goals

1. Separate pure message-shape logic (reducers) from stateful facade
   (session/topic maps, React subscriptions, observability counters).
2. Make each transformation independently testable without spinning up a
   backend or a browser.
3. Preserve the runtime fix on `main` that removed `_queued` and the
   client-side message queue — every user send POSTs immediately; the
   backend queue modes are authoritative.

## Phase map

| Phase | Branch | Scope |
| --- | --- | --- |
| 1 | `refactor/message-store-reducers-phase1` | Reducer scaffold, shared types. |
| 2 | `refactor/message-store-reducers-phase2` | Pure reducer functions extracted. |
| 3 | `refactor/message-store-phase-3-4` (PR B) | Route runtime bridges through reducers. |
| 4 | `refactor/message-store-phase-3-4` (PR B) | Hardening tests (session switching, TTS, deep research). |

## Reducer inventory

Located in `src/store/message-store-reducers/`:

- `shared.ts` — helper functions (`withRuntime`, `pathMatchKeys`, `normalizeMessageText`, runtime status mapping). Shared across reducers.
- `user-message-reducer.ts` — `reduceCreateUserMessageEvent`, `createLocalMessage`.
- `assistant-turn-reducer.ts` — `reduceCreateAssistantTurnEvent`, `reduceAppendAssistantTextEvent`, `reduceStopStreamingAssistantEvent`, `reduceEnsureStreamingAssistantEvent`, `mergeAssistantDuplicate`, `isAssistantCompanionForFileMessage`.
- `background-task-reducer.ts` — `reduceProjectTaskAnchorEvent`, `projectTaskAnchorMessage`, `mergeTaskAnchorMeta`, `sameTaskAnchorMeta`, `findTaskAnchorIndex`, `taskAnchorMessageId`, `taskIdentity`, `runtimeStatusForTask`, `taskMessageStatus`.
- `file-artifact-reducer.ts` — `reduceAppendFileArtifactEvent`, `parseLegacyFileDeliveries`, `findFileResultTargetIndex`, `findMessageIndexForFilePath`, `mergeFileResultIntoTarget`, `shouldCoalesceFileResult`.
- `history-replay-reducer.ts` — `reduceConvertHistoryReplayMessageEvent`, `reduceMergeAuthoritativeHistoryMessageEvent`, `findOptimisticMatchIndex`, `mergeAuthoritativeIntoMessage`, `shouldCollapseAuthoritativeDuplicate`, `convertApiMessage`.

A `src/store/message-store-reducer.ts` barrel re-exports the public surface.

## Invariants (do not regress)

- `_queued` does not exist anywhere. User sends POST immediately.
- `subscribeNew` is only wired after `replaceHistory` has hydrated from the
  authoritative API so that streamed `session_result` payloads do not land
  before the replay is applied.
- Task anchors are keyed by `taskAnchorMessageId(sessionId, taskId)`. Multiple
  anchors for the same task in the same session are a bug.
- `historySeq` ordering is authoritative; local-only bubbles without a seq
  sort after confirmed messages.
- `Message.role` stays `"user" | "assistant" | "system"`. Task anchors are
  tagged via `kind: "task_anchor"` (not a new role).
- Reducers are pure: no `Date.now()`, no `Math.random()`, no global state.
  Injection via `createId` / `now` callbacks.

## Testing

- `tests/message-store-reducer.spec.ts` — unit-style Playwright specs that run
  the pure reducers in isolation (no browser navigation).
- `tests/message-store-live.spec.ts` — live gate guarded by
  `LIVE_MESSAGE_STORE_GATE=1`. Exercises the full runtime.
- Existing spec suites (`session-switching`, `background-task-scope`,
  `tts-runtime-events`) remain the regression fence.
