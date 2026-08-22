# Silero v6 browser experiment

This is an isolated browser experiment. It does not change `/voice`, `/learn`,
or the production VAD preference. The production path remains on the
`@ricky0123/vad-web` models.

The page sends each 16 kHz, 512-sample microphone frame to both:

- the current browser Silero v5 model bundled by `@ricky0123/vad-web@0.0.30`;
- the official Silero v6.2.1 16 kHz opset-15 ONNX model.

Both probability streams use the same threshold, minimum-speech, and
redemption settings. The page shows live probabilities, detection events,
model load time, inference latency, and exports the raw comparison as JSON.

## Run

```bash
pnpm dev:vad-v6
```

Open the URL printed by Vite. The script normally opens:

```text
http://127.0.0.1:5173/silero-v6-lab.html
```

`localhost`/`127.0.0.1` is a secure browser context for microphone access. If
the port is occupied, use the actual port printed by Vite.

## Suggested comparison

Use one scenario label at a time and keep each noise scenario running for at
least 20 seconds:

1. quiet room;
2. isolated keyboard taps;
3. continuous typing;
4. mouse clicks;
5. desk or fabric friction;
6. coughs and throat clearing;
7. short Chinese speech;
8. long Chinese speech;
9. noise immediately followed by speech.

For a candidate production upgrade, v6 must reduce confirmed noise segments
without materially increasing missed real speech. Also compare model load time
and inference P95. Export the JSON after each controlled run rather than
combining unrelated environments into one result.

## Decision boundary

This lab compares the acoustic model outputs and a shared, deterministic
segmentation rule. It does not exercise Octos upload, ASR, Agent routing, or
course generation. Passing this lab is necessary evidence for a model upgrade,
but it is not a substitute for a final `/voice` and `/learn` E2E run.

## Model provenance

- Source: <https://github.com/snakers4/silero-vad/releases/tag/v6.2.1>
- Asset: `src/silero_vad/data/silero_vad_16k_op15.onnx`
- SHA-256: `7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49`
- License: Silero VAD repository MIT license

The v6 model requires 64 samples of rolling context in addition to each
512-sample frame. The adapter follows the official v6.2.1 `OnnxWrapper`
contract: `input`, `state`, and `sr` inputs; `output` and `stateN` outputs; state
shape `[2, 1, 128]`.
