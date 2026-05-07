import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    nodePolyfills({ include: ["buffer", "util"] }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: process.env.VITE_PRICE_SERVER_URL ?? "ws://localhost:8080",
        ws: true,
      },
    },
  },
  build: {
    target: "es2020",
    sourcemap: mode === "development",
  },
  define: {
    global: "globalThis",
  },
}));
