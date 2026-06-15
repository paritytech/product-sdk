import { defineConfig } from "vite";

// Runs inside a Polkadot Host (Desktop / Web) pointed at this localhost URL.
export default defineConfig({
  base: "./",
  define: { "import.meta.vitest": "undefined" },
  server: { port: 4337 },
  // Snippets use top-level await (createApp at module scope), which needs es2022+.
  build: { target: "es2022" },
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
