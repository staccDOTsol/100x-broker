// JSON-RPC proxy between the surfpool fork and mainnet: logs what the fork asks for, and retries upstream calls that hang.
// Surfpool gives up on a datasource call after 30s and fails the whole transaction ("Failed to fetch accounts from
// remote"), so each upstream attempt gets 8s and up to 3 tries. Every response says connection: close, so the fork's HTTP
// client never reuses a pooled socket (a stale one hung its send path for 30s).
const UP = process.env.UP ?? "https://api.mainnet-beta.solana.com";
let n = 0;
Bun.serve({
  port: 8877,
  idleTimeout: 0,
  async fetch(req) {
    const id = ++n;
    const body = await req.text();
    const t0 = Date.now();
    let desc = "";
    try {
      const j = JSON.parse(body);
      desc = (Array.isArray(j) ? j : [j]).map((x: any) => `${x.method}(${Array.isArray(x.params?.[0]) ? x.params[0].length + " keys" : String(x.params?.[0] ?? "").slice(0, 12)})`).join(",");
    } catch {
      desc = body.slice(0, 80);
    }
    const ts = () => new Date().toISOString().slice(11, 19);
    console.log(`${ts()} #${id} -> ${desc}`);
    // public mainnet caps getMultipleAccounts at 100 keys; the fork forwards whatever the page asked for in one call
    const j = (() => { try { return JSON.parse(body); } catch { return null; } })();
    if (j && !Array.isArray(j) && j.method === "getMultipleAccounts" && Array.isArray(j.params?.[0]) && j.params[0].length > 100) {
      const keys: string[] = j.params[0];
      const parts = await Promise.all(
        Array.from({ length: Math.ceil(keys.length / 100) }, (_, i) =>
          upstream(JSON.stringify({ ...j, params: [keys.slice(i * 100, i * 100 + 100), ...j.params.slice(1)] })).then((t) => JSON.parse(bigOut(t.text))),
        ),
      );
      const bad = parts.find((x) => x.error || !x.result);
      const merged = bad ?? { jsonrpc: "2.0", id: j.id, result: { context: parts[0].result.context, value: parts.flatMap((x) => x.result.value) } };
      console.log(`${ts()} #${id} <- split ${keys.length} keys into ${parts.length}${bad ? " (error)" : ""}`);
      return new Response(bigIn(JSON.stringify(merged)), { headers: { "content-type": "application/json", connection: "close" } });
    }
    const out = await upstream(body);
    console.log(`${ts()} #${id} <- ${out.status} ${Date.now() - t0}ms ${out.text.length}b${out.note}`);
    return new Response(out.text, { status: out.status, headers: { "content-type": "application/json", connection: "close" } });
  },
});

// u64s past 2^53 (rentEpoch is u64::MAX) must survive the parse/merge as integers: surfpool rejects floats
const bigOut = (t: string) => t.replace(/:(\d{16,})(?=[,}\]])/g, ':"__big$1"');
const bigIn = (t: string) => t.replace(/"__big(\d+)"/g, "$1");

/** One upstream call: 8s per attempt, up to 3 attempts, one retry on 429. */
async function upstream(body: string): Promise<{ status: number; text: string; note: string }> {
  const ts = () => new Date().toISOString().slice(11, 19);
  {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(UP, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8_000) });
        const text = await r.text();
        if (r.status === 429 && attempt < 3) {
          console.log(`${ts()} 429, retrying`);
          await Bun.sleep(1_000);
          continue;
        }
        return { status: r.status, text, note: attempt > 1 ? ` (try ${attempt})` : "" };
      } catch (e) {
        console.log(`${ts()} !! ${String(e).slice(0, 100)} (try ${attempt})`);
      }
    }
    return { status: 502, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "upstream failed 3 times" } }), note: "" };
  }
}
console.log(`rpc proxy :8877 -> ${UP}`);
