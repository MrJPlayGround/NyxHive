import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname),
  base: "/",
  build: {
    outDir: resolve(__dirname, "../../dist/gateway"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@gateway": resolve(__dirname, "src"),
      "@protocol": resolve(__dirname, "protocol"),
    },
  },
  server: {
    port: 4777,
    proxy: {
      "/ws": {
        target: "ws://localhost:3777",
        ws: true,
      },
    },
  },
});
