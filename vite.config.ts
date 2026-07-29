import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  optimizeDeps: {
    // OLL is intentionally consumed through a local file: dependency while its
    // Runtime is under active development. Rebuild Vite's compatible dependency
    // bundle on every server start so OLL changes are not served from a stale
    // node_modules/.vite snapshot.
    force: true,
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
      "/smart-home-api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/smart-home-api/, "/api"),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
