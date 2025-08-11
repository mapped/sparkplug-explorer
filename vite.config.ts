import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Conditional proxy: disable when running embedded (middlewareMode) to avoid loop
export default defineConfig(() => {
  const inMiddleware = process.env.VITE_MIDDLEWARE === "1";
  return {
    plugins: [react()],
    build: {
      outDir: "dist/ui",
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: inMiddleware
        ? undefined
        : {
            "/api": {
              target: "http://localhost:3000",
              changeOrigin: true,
            },
          },
    },
  };
});
