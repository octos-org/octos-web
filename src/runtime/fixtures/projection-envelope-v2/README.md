# Projection-envelope v2 fixtures

These fixtures are hand-authored to the Rust wire types: `EnvelopeWire`,
`Payload { tag = "type", content = "data" }`, and
`UiCursor { stream, seq }`. They are not captures from a live server and are
not client-normalized test data.

The six standard fixtures (`user-message`, `assistant-delta`,
`assistant-persisted-with-media`, `tool-outcome`, `terminal-error`, and
`background-spawn-complete`) represent the Stage 1 flattened
`projection/envelope` `params` wire. They use server field names, a 1-based
per-thread `seq`, explicit `turn_id`, and a durable top-level `cursor`.

`reconnect-cursor.json` isolates a replay frame whose per-thread `seq` and
ledger cursor differ, proving the two coordinates are never conflated.

The pure parser tests decode every fixture in isolation; Stage 2's bridge uses
that parser unchanged as its receive boundary.
