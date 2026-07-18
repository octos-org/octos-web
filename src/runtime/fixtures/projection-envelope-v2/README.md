# Projection-envelope v2 fixtures

These fixtures are hand-authored to the Rust wire types: `EnvelopeWire`,
`Payload { tag = "type", content = "data" }`, and
`UiCursor { stream, seq }`. They are not captures from a live server and are
not client-normalized test data.

The six standard fixtures (`user-message`, `assistant-delta`,
`assistant-persisted-with-media`, `tool-outcome`, `terminal-error`, and
`background-spawn-complete`) represent the current flattened
`projection/envelope` `params` wire. They use the server field names and its
1-based per-thread `seq`, and deliberately omit a top-level `cursor` because
the server does not emit one today.

`reconnect-cursor.json` is the one fixture for the v2 cursor addition. It
shows the optional `UiCursor` shape that a future server may emit for
reconnect/replay; it is not part of the current server wire.

The Stage 0 parser tests decode every fixture in isolation. Nothing in this
directory is wired into the live bridge or a renderer.
