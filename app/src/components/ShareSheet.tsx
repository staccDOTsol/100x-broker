// One share surface for cards: native share sheet with the image where it exists (phones),
// tweet-intent + copy + download everywhere else.
import { useEffect, useState } from "react";
import { tweetUrl } from "../lib/ref";
import { useToasts } from "./Toasts";

export type ShareTarget = { title: string; text: string; url: string; image: string; filename: string };

export function ShareSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const toasts = useToasts();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const canNative = typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  async function native() {
    setSharing(true);
    try {
      let files: File[] | undefined;
      try {
        const blob = await (await fetch(target.image)).blob();
        const f = new File([blob], target.filename, { type: "image/png" });
        if (navigator.canShare?.({ files: [f] })) files = [f];
      } catch {
        /* share without the image */
      }
      await navigator.share({ title: target.title, text: target.text, url: target.url, ...(files ? { files } : {}) });
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) window.open(tweetUrl(target.text, target.url), "_blank", "noopener");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Share ${target.title}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-img">
          {!ready && !failed && <span className="skeleton" style={{ position: "absolute", inset: 0 }} />}
          {failed ? (
            <div className="sheet-fail">Card's sulking. The link still works.</div>
          ) : (
            <img src={target.image} alt={target.title} onLoad={() => setReady(true)} onError={() => setFailed(true)} style={{ opacity: ready ? 1 : 0 }} />
          )}
        </div>
        <div className="sheet-body">
          <b>{target.title}</b>
          <p className="muted">{target.text}</p>
          <div className="sheet-actions">
            {canNative && (
<button className="btn" data-loading={sharing} onClick={native}>
                Flex…
              </button>
            )}
            <a className={canNative ? "btn ghost" : "btn"} href={tweetUrl(target.text, target.url)} target="_blank" rel="noreferrer">
              Tweet
            </a>
            <button
              className="btn ghost"
              onClick={() => {
                navigator.clipboard?.writeText(target.url);
                toasts.push({ s: "ok", title: "Link copied. Go be insufferable." });
              }}
            >
              Copy link
            </button>
            <a className="btn ghost" href={target.image} download={target.filename}>
              Save card
            </a>
          </div>
        </div>
        <button className="x sheet-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}
