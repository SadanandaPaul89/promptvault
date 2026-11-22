import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_PORT = process.env.PORT ?? "3000";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header so the server's same-origin (CSRF) check matches.
      "/api": { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
