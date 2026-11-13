import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
} as any);
