import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // In dev, /api/rpc goes straight to the upstream RPC (surfpool or Helius); on Vercel it is api/rpc.ts.
  const upstream = env.DEV_RPC_UPSTREAM ?? "http://127.0.0.1:8899";
  return {
    plugins: [react()],
    define: { global: "globalThis" },
    resolve: { alias: { buffer: "buffer/" } },
    optimizeDeps: { esbuildOptions: { define: { global: "globalThis" } } },
    server: {
      port: 5173,
      proxy: { "/api/rpc": { target: upstream, changeOrigin: true, rewrite: () => "/" } },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  };
});
