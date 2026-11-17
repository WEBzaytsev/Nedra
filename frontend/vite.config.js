import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const versionFile = {
  name: "nedra-version",
  apply: "build",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "version.json",
      source: `${JSON.stringify({ version })}\n`,
    });
  },
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  define:
    mode === "desktop-qa"
      ? {
          "import.meta.env.VITE_DESKTOP_QA": JSON.stringify("1"),
          "import.meta.env.VITE_DESKTOP": JSON.stringify("1"),
        }
      : {},
  plugins: [react(), versionFile],
  server: {
    host: true, // listen on 0.0.0.0 so the dev server is reachable from Docker
    port: Number(process.env.VITE_PORT) || 3000,
    strictPort: true,
    // File-system polling is needed for hot-reload inside Docker bind mounts.
    watch: process.env.VITE_USE_POLLING ? { usePolling: true } : undefined,
  },
  build: {
    outDir: "dist",
  },
}));
