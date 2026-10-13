/**
 * Phone browsers can't see wallet apps: nothing injects a provider the way a desktop extension does, and iOS has no
 * Mobile Wallet Adapter at all. The wallets' own in-app browsers DO inject, so the fix is to hand this page to them via
 * their universal "browse" links. The current URL (with any ?ref= on it) rides along.
 */
export const isMobileBrowser = () => typeof navigator !== "undefined" && /android|iphone|ipad|ipod/i.test(navigator.userAgent);

/** The name wallet-adapter-react gives the Solana Mobile Wallet Adapter it adds by itself on Android. */
export const MWA_NAME = "Mobile Wallet Adapter";

export function walletBrowserLinks(): { name: string; href: string }[] {
  const here = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${here}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${here}?ref=${ref}` },
  ];
}
