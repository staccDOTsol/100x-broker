import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // In dev, /api/rpc goes straight to the upstream RPC (surfpool or Helius); on Vercel it is api/rpc.ts.
  // A keyed upstream (https://mainnet.helius-rpc.com/?api-key=…) keeps its path + query; the proxy targets the origin only.
  const upstream = new URL(env.DEV_RPC_UPSTREAM ?? "http://127.0.0.1:8899");
  return {
    plugins: [react()],
    define: { global: "globalThis" },
    resolve: { alias: { buffer: "buffer/" } },
    optimizeDeps: { esbuildOptions: { define: { global: "globalThis" } } },
    server: {
      port: 5173,
      proxy: {
        "/api/rpc": { target: upstream.origin, changeOrigin: true, rewrite: () => (upstream.pathname || "/") + upstream.search },
        // Every other /api/* is a Vercel function vite can't run (it would try to bundle api/*.ts, resvg and all, for the browser):
        // send it to the live site, or DEV_API_UPSTREAM (e.g. a `vercel dev` on another port) to test local API edits.
        "/api": { target: env.DEV_API_UPSTREAM ?? "https://100x.broker", changeOrigin: true },
      },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  };
});
