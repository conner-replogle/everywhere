import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultAllowedOrigins, defineConfig } from "vite";

const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [
    // Must come before the React plugin.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    port: 5173,
    // Dashboards run in a sandboxed frame, whose requests come from origin
    // "null"; its module scripts need CORS to load.
    cors: { origin: [defaultAllowedOrigins, "null"] },
    proxy: {
      "/api": { target: worker, ws: true, changeOrigin: false },
      "/i": { target: worker },
      "/mcp": { target: worker },
      "/oauth": { target: worker },
      "/.well-known": { target: worker },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        // A process's dashboard, in a sandboxed frame (src/dashboard).
        dashboard: new URL("./dashboard.html", import.meta.url).pathname,
      },
    },
  },
});
