// Copy the @ricky0123/vad-web + onnxruntime-web runtime assets into public/vad/
// so the Vite dev server and the production build serve them at /vad/*.
//
// The VAD library defaults baseAssetPath/onnxWASMBasePath to "./", which makes
// it fetch the worklet, the Silero ONNX model, and the ORT wasm from the page
// origin root — those 404 in dev/prod. We self-host them under /vad/ (see
// src/home/use-voice-capture.ts) instead of relying on a CDN, which keeps the
// voice path working offline.
//
// Runs on `predev` and `prebuild`. public/vad/ is gitignored (generated).

import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vad");
mkdirSync(out, { recursive: true });

const vad = join(root, "node_modules", "@ricky0123", "vad-web", "dist");
const ort = join(root, "node_modules", "onnxruntime-web", "dist");

const files = [
  [vad, "silero_vad_legacy.onnx"],
  [vad, "silero_vad_v5.onnx"],
  [vad, "vad.worklet.bundle.min.js"],
  // ORT wasm — copy the threaded variants the loader requests. They run
  // single-threaded when SharedArrayBuffer is unavailable (no COOP/COEP needed).
  [ort, "ort-wasm-simd-threaded.mjs"],
  [ort, "ort-wasm-simd-threaded.wasm"],
  [ort, "ort-wasm-simd-threaded.jsep.mjs"],
  [ort, "ort-wasm-simd-threaded.jsep.wasm"],
];

let copied = 0;
for (const [dir, f] of files) {
  const src = join(dir, f);
  if (existsSync(src)) {
    copyFileSync(src, join(out, f));
    copied++;
  } else {
    console.warn(`[copy-vad-assets] missing (skipped): ${src}`);
  }
}
console.log(`[copy-vad-assets] copied ${copied} asset(s) to public/vad/`);
