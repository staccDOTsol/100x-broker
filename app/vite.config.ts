import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const PUBLIC_RPC = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

/** Dev /api/rpc. A 429 from the keyed upstream is not an answer: try a public endpoint so the page and the wallet still read. */
function devRpc(upstream: URL): Plugin {
  const local = upstream.hostname === "127.0.0.1" || upstream.hostname === "localhost";
  const targets = local ? [upstream.toString()] : [upstream.toString(), ...PUBLIC_RPC];
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== "POST") return next();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      for (const url of targets) {
        try {
          const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
          const text = await r.text();
          const limited = r.status === 429 || r.status === 401 || r.status === 403 || /Too Many Requests|"code":\s*-32429/i.test(text);
          if (!limited && r.status < 500) {
            res.statusCode = r.status;
            res.setHeader("content-type", "application/json");
            res.end(text);
            return;
          }
        } catch {
          /* next endpoint */
        }
      }
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "rpc unavailable" }));
    });
  };
  return {
    name: "dev-rpc",
    configureServer(server) {
      server.middlewares.use("/api/rpc", handle);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // In dev, /api/rpc goes straight to the upstream RPC (surfpool or Helius); on Vercel it is api/rpc.ts.
  // A keyed upstream keeps its path + query. A 429 falls through to a public endpoint.
  const upstream = new URL(env.DEV_RPC_UPSTREAM ?? "http://127.0.0.1:8899");
  return {
    plugins: [devRpc(upstream), react()],
    define: { global: "globalThis" },
    resolve: {
      alias: [
        { find: "buffer", replacement: "buffer/" },
        // the browser takes the pump.fun SDK's ESM build; the server file loads its CommonJS build (src/lib/pumpsdk.ts)
        { find: /^\.\/pumpsdk\.js$/, replacement: fileURLToPath(new URL("./src/lib/pumpsdk.browser.ts", import.meta.url)) },
      ],
    },
    optimizeDeps: { esbuildOptions: { define: { global: "globalThis" } } },
    server: {
      port: 5173,
      proxy: {
        // Every other /api/* is a Vercel function vite can't run (it would try to bundle api/*.ts, resvg and all, for the browser):
        // send it to the live site, or DEV_API_UPSTREAM (e.g. a `vercel dev` on another port) to test local API edits.
        "/api": {
          target: env.DEV_API_UPSTREAM ?? "https://100x.broker",
          changeOrigin: true,
          // src/pages/War*.tsx import the SVG creatures straight from api/_lib: those are modules for vite to serve, not API calls
          bypass: (req) => (req.url?.startsWith("/api/_lib/") ? req.url : undefined),
        },
      },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  };
});
