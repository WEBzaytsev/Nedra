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

export default defineConfig({
  plugins: [react(), versionFile],
  server: {
    host: true,
    port: Number(process.env.VITE_PORT) || 3000,
    strictPort: true,

    watch: process.env.VITE_USE_POLLING ? { usePolling: true } : undefined,
  },
  build: {
    outDir: "dist",
  },
});
