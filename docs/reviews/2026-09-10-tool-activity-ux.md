# Compact tool activity and contextual follow-ups

The reported conversation exposed two distinct problems: raw `web_search` / `web_fetch` rows crowded out the answer, and a short “北京呢” follow-up repeated a complete weather-report template while introducing an unrelated Shanghai comparison.

Tracked in [web #364](https://github.com/octos-org/octos-web/issues/364) and [core #2305](https://github.com/octos-org/octos/issues/2305), with fixes in [web PR #350](https://github.com/octos-org/octos-web/pull/350) and [core PR #2296](https://github.com/octos-org/octos/pull/2296).

## Behavior

- Consecutive web-only tool messages render as one collapsed activity card, with search/page counts and running/completed/failed state. Expanding it reveals individual calls, useful search queries or source paths, and their progress/error details.
- Grouping is presentation-only. Canonical message/tool IDs and stored history remain intact. Narration, files and other tool types retain their boundaries. Failures remain visible even while another call runs; expanding details survives progress updates.
- Search arguments support objects, JSON strings and the actual canonical `key: value` preview format. URL labels omit credentials, query parameters and fragments; malformed or truncated values fall back to a neutral label.
- The gateway default prompt treats short follow-ups as continuations of the current question. It defaults to one paragraph of 1–3 sentences and avoids repeating report layouts, boilerplate advice and unrelated comparisons. It retains current-data grounding and source requirements. Existing custom system prompts are preserved.

Prompt guidance influences model behavior; it is not a deterministic output filter. The client continues to render user-requested tables and detailed answers normally.

## Validation

The initial UI implementation (`27a66b9`) passed 1,249 unit tests across 169 files, 33 mocked Chromium tests, lint (zero errors; 104 warnings), and the production `/app/` build. Both web CI jobs passed in [run 34561006139](https://github.com/octos-org/octos-web/actions/runs/34561006139). After the final generic-tool indicator adjustment, 23 focused tests and the production build passed again.

The prompt revisions passed all 15 existing gateway prompt contract tests and `cargo fmt --check`. These contract tests are not a substitute for observing an actual model response.

After adding the canonical-preview regression, final web `1bb7263` passed **1,250 unit tests**, **33 mocked browser tests**, lint (zero errors; 104 warnings), and the production build. The initial type check caught a lost TypeScript narrowing in the new preview parser; retaining the original string fixes it, and the final build passes.

Both final-runtime web CI jobs pass in [run 34562064406](https://github.com/octos-org/octos-web/actions/runs/34562064406). Core `7590b73` [CI](https://github.com/octos-org/octos/actions/runs/34561840236) remains in progress at this point; the local prompt checks and compiled runtime are separately verified.

Responsive fixture checks exercise the user's eight-call sequence at desktop and mobile widths, keyboard expansion, complete/error/running states, and horizontal overflow. These screenshots use explicitly synthetic text, not current weather observations:

- [Collapsed desktop](evidence/2026-09-10-tool-activity/collapsed-desktop.png)
- [Expanded desktop](evidence/2026-09-10-tool-activity/expanded-desktop.png)
- [Running desktop](evidence/2026-09-10-tool-activity/running-desktop.png)
- [Mobile failure](evidence/2026-09-10-tool-activity/error-mobile.png)

## Actual mini3 browser observations

Playwright and Chromium execute on mini3 against its real production bundle, authentication, DeepSeek provider and web tools. No fulfilled API routes or automatic retries are used. The reusable runner is [`scripts/live-review/tool-activity.mjs`](../../scripts/live-review/tool-activity.mjs); setup and credential handling are documented in its [README](../../scripts/live-review/README.md).

The first attempt stopped at a harness error before sending a model request: New chat opened the session-template dialog, and the runner had not selected Chat. The corrected harness explicitly completes that dialog.

On web `27a66b9` / core `42ecf40`, the actual research turn completed four web calls (two searches, two fetches) and rendered one collapsed, completed activity card; expansion retained all four calls. Screenshot inspection exposed neutral labels in place of query/source context because canonical previews are not JSON objects. A subsequent regression and parser fix cover that actual wire format.

The same run failed the follow-up acceptance check: the model retained the supplied indoor/air-conditioning venue facts and avoided Shanghai, but still returned a repeated table and an unnecessary weather comparison. The [retained failure](evidence/2026-09-10-tool-activity/failed-followup.json) records that response without credentials or private reasoning. Core `7590b73` strengthens the brief-answer default and keeps the follow-up tied to the original question's purpose.

The final isolated runtime embeds web **`1bb7263`** and core **`7590b73`**, PID **19413**, binary SHA-256 `0bf70a892441d204da5112eb19380ad98dc53d3bf725fc7a6f61fb49906912ea`, served HTML SHA-256 `b763b488712b8d6ec0df240d0c2bb80925c95fb64894013b5a95405d10ce7685`. HTTP 200 and exact built/served HTML equality were verified before launching the final browser run.

The first run on this final runtime passed real documentation research (three calls, one card, both actual fetched paths visible) and the venue follow-up (65 characters, two sentences, no table, zero page errors). Its additional weather case stopped at an overly short harness wait for the persisted user row. A separate weather-only attempt reproduced that timeout; the failure screenshot shows the optimistic user message and completed tool activity, establishing that the request was actually running. The runner now checks visible optimistic text immediately, then allows 180 seconds for the durable row and still requires canonical completion. It also waits for an empty new conversation before typing and saves failure diagnostics before browser teardown. These failed/interrupted attempts are not counted as successful weather validation.

The corrected complete run **passes all three cases** on the final runtime, with zero page errors and no automatic retries:

| Case | Observed result |
|---|---|
| Actual documentation research | Four real calls (two searches, two fetches), one completed card, all calls retained, both actual source paths visible when expanded |
| Supplied venue facts → “北京呢” | 71 characters, two sentences, no table or unrelated Shanghai comparison; indoor/air-conditioning facts retained |
| Original Saratoga weather → “北京呢” | One actual Beijing lookup, 139 characters in one paragraph, no table or Shanghai comparison, canonical completion |

The [machine-readable result](evidence/2026-09-10-tool-activity/results.json) retains the observed answers. Inspected actual screenshots: [collapsed research](evidence/2026-09-10-tool-activity/real-research-collapsed.png), [expanded research](evidence/2026-09-10-tool-activity/real-research-expanded.png), [venue follow-up](evidence/2026-09-10-tool-activity/real-followup.png), and [weather follow-up](evidence/2026-09-10-tool-activity/real-weather-followup.png).

The weather model output omitted an inline citation despite the prompt's source guidance. Its observation time, meteorological explanation and claim about warning status are not independently certified by this UI test. Source attribution and factual grounding remain a model-quality follow-up under core #2305; this result establishes the exercised brevity/context behavior, not full weather-answer correctness.

## Scope

One follow-up fixture supplies two venue descriptions and asks about midday suitability, followed by “北京呢”. Another replays the original “saratoga ca 今天为什么这么热” → “北京呢” prompts and requires an actual current-data lookup. These check contextual response behavior and formatting; the harness does not independently certify returned weather measurements. The separate documentation-research turn exercises actual search/fetch tools and their rendered source labels.

The earlier completed 30m 38s soak belongs to web `355c7f5` / core `f94d219`; it is not attributed to this UI/prompt update. Complete image-driven slides/PPTX, speech and learning acceptance remain outstanding as recorded in the [live validation journal](2026-09-10-live-validation.md).
