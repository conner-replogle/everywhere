import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultAllowedOrigins, defineConfig, type Plugin } from "vite";

const worker = "http://localhost:8787";

/**
 * terminal-view.tsx always loads ghostty-vt.wasm from its emitted static URL
 * (Ghostty.load(ghosttyWasmUrl)) because CSP blocks data: fetches. Strip the
 * unused ~552 KB inline base64 WASM fallback from ghostty-web so browsers
 * don't download and parse the WASM twice.
 */
function stripGhosttyInlineWasm(): Plugin {
  return {
    name: "strip-ghostty-inline-wasm",
    transform(code, id) {
      if (!id.includes("ghostty-web") || !code.includes("data:application/wasm;base64,")) return null;
      return {
        code: code.replace(/data:application\/wasm;base64,[A-Za-z0-9+/=]+/g, ""),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [
    stripGhosttyInlineWasm(),
    // Must come before the React plugin.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: new URL("./src", import.meta.url).pathname },
    ],
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
    // Not "assets": browsers keep that path's files a year, and copies from
    // before they carried CORS (which a dashboard's sandboxed frame needs to
    // load them) would be reused as they are. Nothing is cached under here.
    assetsDir: "static",
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        // A process's dashboard, in a sandboxed frame (src/dashboard).
        dashboard: new URL("./dashboard.html", import.meta.url).pathname,
      },
    },
  },
});
