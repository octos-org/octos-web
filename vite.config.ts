import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { existsSync, readFileSync } from "node:fs";

const localCertificate = path.resolve(__dirname, ".cert/octos-web.pem");
const localCertificateKey = path.resolve(__dirname, ".cert/octos-web-key.pem");

export default defineConfig(({ mode }) => {
  const useLocalHttps = mode === "local-https";
  if (
    useLocalHttps &&
    (!existsSync(localCertificate) || !existsSync(localCertificateKey))
  ) {
    throw new Error(
      "Local HTTPS certificate is missing. Run `pnpm setup:https` first.",
    );
  }

  return {
    optimizeDeps: {
      // OLL is pinned to an exact repository revision. Serve its ESM output
      // directly so a browser refresh cannot mix freshly HMR-ed host code with
      // an older node_modules/.vite snapshot of the Runtime.
      exclude: [
        "octos-lesson-language",
        "octos-lesson-language/player",
        "octos-lesson-language/web-runtime",
      ],
      // OLL's validator uses AJV's CommonJS 2020 entrypoint. Keep that leaf
      // dependency optimized so the directly served OLL modules receive Vite's
      // ESM interop wrapper.
      include: ["octos-lesson-language > ajv/dist/2020.js"],
    },
    base: process.env.BASE_URL || "/",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      https: useLocalHttps
        ? {
            cert: readFileSync(localCertificate),
            key: readFileSync(localCertificateKey),
          }
        : undefined,
      proxy: {
        "/api": {
          target: "http://localhost:50080",
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on("proxyReqWs", (proxyReq) => {
              proxyReq.removeHeader("origin");
            });
          },
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
