// Static server for the fork-mode production build (site/), isolated from the live dev server:
//   /api/rpc     -> the local surfpool fork (every transaction lands there)
//   /api/vanity  -> refused (it hands out production's pre-ground mint keys; /new falls back to random keys)
//   /api/*       -> https://100x.broker (read-only feeds, quotes and transaction plans)
//   anything else -> site/, SPA fallback to index.html
const FORK = process.env.FORK ?? "http://127.0.0.1:8899";
const UPSTREAM = process.env.API_UPSTREAM ?? "https://100x.broker";
const ROOT = new URL("./site/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 5180);

const rpc = (body: unknown) => fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

/** Surfpool's sendTransaction path sometimes fails to reach its datasource for accounts it hasn't cached yet ("Failed to
 *  fetch account(s) from remote: error sending request"), while simulateTransaction fetches the same accounts fine. So
 *  simulate first (which pulls every account, lookup tables included, into the fork) and retry the send on that error. */
async function sendViaFork(body: string) {
  const req = JSON.parse(body);
  const [tx, opts] = req.params ?? [];
  await rpc({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [tx, { encoding: opts?.encoding ?? "base58", sigVerify: false, replaceRecentBlockhash: true }] }).catch(() => null);
  let out: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    out = await rpc(req);
    if (!/from remote/.test(out?.error?.message ?? "")) break;
    console.log(`send retry ${attempt}: ${out.error.message.slice(0, 120)}`);
    await Bun.sleep(1500);
  }
  return Response.json(out);
}

Bun.serve({
  port: PORT,
  idleTimeout: 255, // the fork can take a while on the first transaction that touches many mainnet accounts
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/rpc") {
      const body = await req.text();
      if (body.includes('"sendTransaction"')) return sendViaFork(body);
      const r = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await r.text();
      if (text.includes('"error"')) console.log(`rpc error: ${body.slice(0, 160)} -> ${text.slice(0, 200)}`);
      return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/vanity")) return new Response("disabled in the walkthrough", { status: 503 });
    if (url.pathname.startsWith("/api/")) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const r = await fetch(UPSTREAM + url.pathname + url.search, {
        method: req.method,
        headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
        body,
      });
      return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
    }
    const file = Bun.file(ROOT + (url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    if (url.pathname !== "/" && (await file.exists())) return new Response(file);
    return new Response(Bun.file(ROOT + "index.html"), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`walkthrough site on http://localhost:${PORT} (rpc -> ${FORK})`);
