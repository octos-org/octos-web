import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Coding-blue side-by-side deploy: when CODING_BLUE_NEXT=1, the build emits a
// bundle rooted at "/next/" and written to dist-next/ so it can be deployed
// alongside the legacy bundle at "/". See docs/CODING_BLUE_DEPLOY.md for the
// deployment layout. Explicit BASE_URL / OUT_DIR overrides still win.
const codingBlueNext =
  process.env.CODING_BLUE_NEXT === "1" || process.env.CODING_BLUE_NEXT === "true";
const resolvedBase =
  process.env.BASE_URL || (codingBlueNext ? "/next/" : "/");
const resolvedOutDir =
  process.env.OUT_DIR || (codingBlueNext ? "dist-next" : "dist");

export default defineConfig({
  base: resolvedBase,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:9326",
        headers: {
          "X-Profile-Id": "dspfac",
        },
      },
    },
  },
  build: {
    outDir: resolvedOutDir,
    emptyOutDir: true,
  },
});
