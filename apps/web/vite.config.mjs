import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:3001";
const proxy = { "/api": apiTarget, "/health": apiTarget, "/metrics": apiTarget };

export default defineConfig({
  plugins: [react()],
  build: {
    // The lazily loaded map chunk is about 1 MB because MapLibre alone is close to that size;
    // splitting it further cannot bring it under Vite's 500 kB default.
    chunkSizeWarningLimit: 1100
  },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy }
});
