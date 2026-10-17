// X fetches a link's page and its og:image once, within a few seconds of the post, and caches a miss for that exact URL.
// So before anything posts a link, fetch the page as X's crawler would and then its image: both land in the edge cache.
export async function prewarm(url: string) {
  try {
    const html = await (await fetch(url, { headers: { "user-agent": "Twitterbot/1.0" }, signal: AbortSignal.timeout(12_000) })).text();
    const img = html.match(/(?:og|twitter):image" content="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    if (img) await fetch(img, { headers: { "user-agent": "Twitterbot/1.0" }, signal: AbortSignal.timeout(20_000) }).then((r) => r.arrayBuffer());
  } catch {
    /* best effort: the post still goes out */
  }
}
/** The link X builds the card from: the last URL in the text. */
export const lastUrl = (text: string) => text.match(/https?:\/\/\S+/g)?.pop() ?? null;
