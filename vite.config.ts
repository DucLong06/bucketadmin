import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Tauri devUrl expects this exact port (src-tauri/tauri.conf.json).
  server: { port: 1420, strictPort: true },
});
