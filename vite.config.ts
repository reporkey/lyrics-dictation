import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(process.env.GITHUB_SHA ?? "development"),
  },
  plugins: [
    react(),
    cloudflare({
      persistState: process.env.LYRICS_E2E_STATE_DIR
        ? { path: process.env.LYRICS_E2E_STATE_DIR }
        : true,
    }),
  ],
  server: {
    port: 5173,
  },
});
