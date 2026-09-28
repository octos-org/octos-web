# Isolated mini3 live evidence

The [validation record](../../2026-09-10-live-validation.md) maps issues, fixes, runtimes, failed attempts and acceptance limits. `acceptance-manifest.json` distinguishes the exact completed-soak binary from later slide fixes.

- `soak-summary.json`: 38 real cycles over 30m 38s, final live reply, latency and resource summary.
- `soak-metrics.jsonl`: original sanitized per-cycle measurements; no authenticated URLs.
- `soak-process-samples.jsonl`: browser/runner process observations beginning after startup. Summed RSS includes shared pages.
- `feature-results.json`: actual site, file, auth, queue, calendar and long-conversation results across recorded runtime iterations.
- `slides-capability.json`: persisted renderer task failure (`Gemini API key required`), with zero generated PPTX/PNG outputs.
- Screenshots show exercised site preview isolation, file mutation state, retained long history, accepted long tool turn, an idle soak session, and fresh slide editor/presentation restoration.

The empty slide preview/presentation screenshots demonstrate recovered direct links. They do **not** establish successful rendering/export. All accounts/projects and generated content are synthetic. Credentials, browser storage, signed links, raw traces and failed private transcripts are excluded from this published directory. Earlier failed/interrupted attempts remain in the private run artifacts and are described in the validation record.
