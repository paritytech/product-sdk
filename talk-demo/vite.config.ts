import { defineConfig } from "vite";

// Runs inside a Polkadot Host (Desktop / Web) pointed at this localhost URL.
export default defineConfig({
  base: "./",
  define: { "import.meta.vitest": "undefined" },
  server: { port: 4337 },
});
