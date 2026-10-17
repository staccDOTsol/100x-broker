// @lastbidwins posting over X API v2 with OAuth 1.0a user context (keys in Vercel env, never in the bundle).
// The bot posts once per game, when it opens; every player after that replies or quotes through their own intents.
import { createHmac, randomBytes } from "node:crypto";

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function oauthHeader(method: string, url: string, keys = creds()) {
  const u = new URL(url);
  const params: Record<string, string> = {
    oauth_consumer_key: keys.key, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: keys.token, oauth_version: "1.0",
  };
  // JSON bodies are not part of the signature; query parameters are
  const all = { ...params, ...Object.fromEntries(u.searchParams) };
  const base = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join("&");
  const sigBase = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(base)].join("&");
  const sig = createHmac("sha1", `${enc(keys.secret)}&${enc(keys.tokenSecret)}`).update(sigBase).digest("base64");
  return "OAuth " + Object.entries({ ...params, oauth_signature: sig }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

function creds() {
  const key = process.env.X_API_KEY, secret = process.env.X_API_SECRET, token = process.env.X_ACCESS_TOKEN, tokenSecret = process.env.X_ACCESS_SECRET;
  if (!key || !secret || !token || !tokenSecret) throw new Error("X keys not configured");
  return { key, secret, token, tokenSecret };
}

export async function xMe(): Promise<{ id: string; username: string }> {
  const url = "https://api.x.com/2/users/me";
  const r = await fetch(url, { headers: { authorization: oauthHeader("GET", url) } });
  const j = (await r.json()) as { data?: { id: string; username: string }; detail?: string; title?: string };
  if (!r.ok || !j.data) throw new Error(`x me ${r.status}: ${j.detail ?? j.title ?? ""}`);
  return j.data;
}

/** Post as @lastbidwins. `replyTo` threads it under another post. Returns the new post's id. */
export async function xPost(text: string, replyTo?: string | null): Promise<string> {
  const url = "https://api.x.com/2/tweets";
  const body: Record<string, unknown> = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
  const r = await fetch(url, { method: "POST", headers: { authorization: oauthHeader("POST", url), "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as { data?: { id: string }; detail?: string; title?: string; errors?: { message: string }[] };
  if (!r.ok || !j.data) throw new Error(`x post ${r.status}: ${j.detail ?? j.title ?? j.errors?.[0]?.message ?? ""}`);
  return j.data.id;
}
