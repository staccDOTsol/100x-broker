const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** Prices to 6 digits of precision: 6 decimals from 1 up, 6 significant below, subscript zero-count when tiny. */
export function price(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (x >= 1) return x.toFixed(6);
  const [mant, exp] = x.toExponential(5).split("e");
  const zeros = -Number(exp) - 1;
  const digits = mant.replace(".", "");
  if (zeros < 4) return x.toFixed(zeros + 6);
  return `0.0${[...String(zeros)].map((d) => SUB[Number(d)]).join("")}${digits}`;
}

export function amount(raw: bigint, decimals: number, dp = 4): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

export function compact(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;
// past 10,000× the number is "the other pot is empty", not a payout anyone will see; say that instead of printing billions
export const lev = (x: number) =>
  Number.isNaN(x) ? "—" : !Number.isFinite(x) || x >= 10_000 ? ">10,000×" : `${x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(x < 10 ? 1 : 0)}×`;
export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
export function ago(ts: number) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Money amounts (vaults, holdings, fees): $1,234.56 · $12.34; tiny amounts fall back to price precision. */
export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x >= 1) return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (x === 0) return "$0";
  return `$${price(x)}`;
}
/** Prices (oracle, curve, per token): always 6 digits of precision. */
export function usdPrice(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `$${price(x)}`;
}
