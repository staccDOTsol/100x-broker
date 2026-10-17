// The three Stars War teams as little creatures (same art as @lastbidwins' avatar and banner). SVG strings, so share cards can
// embed them as data URIs.
export const PAL = { paper: "#171412", paper2: "#1f1b18", rule: "#3a332d", ink: "#ece6da", ink2: "#bdb4a6", ink3: "#8a8073", up: "#5fcf8f", down: "#f0825d", gold: "#f2c14e", tongue: "#e0533d" };
const C = PAL;
const drop = (cx: number, cy: number, s: number, fill: string) =>
  `<path d="M ${cx} ${cy - s} C ${cx + 0.15 * s} ${cy - 0.6 * s}, ${cx + 0.75 * s} ${cy - 0.1 * s}, ${cx + 0.75 * s} ${cy + 0.35 * s} C ${cx + 0.75 * s} ${cy + 0.85 * s}, ${cx - 0.75 * s} ${cy + 0.85 * s}, ${cx - 0.75 * s} ${cy + 0.35 * s} C ${cx - 0.75 * s} ${cy - 0.1 * s}, ${cx - 0.15 * s} ${cy - 0.6 * s}, ${cx} ${cy - s} Z" fill="${fill}"/>`;
const eyes = (cx: number, cy: number, s: number, slit = false) =>
  [-1, 1].map((k) => `<ellipse cx="${cx + k * 0.22 * s}" cy="${cy + 0.22 * s}" rx="${(slit ? 0.045 : 0.075) * s}" ry="${0.12 * s}" fill="${C.paper}"/>`).join("");
const horn = (cx: number, cy: number, s: number, k: number) =>
  `<path d="M ${cx + k * 0.42 * s} ${cy - 0.05 * s} C ${cx + k * 0.8 * s} ${cy - 0.12 * s}, ${cx + k * 0.92 * s} ${cy - 0.42 * s}, ${cx + k * 0.78 * s} ${cy - 0.62 * s}" stroke="${C.ink}" stroke-width="${0.11 * s}" stroke-linecap="round" fill="none"/>`;
export const bullSvg = (cx: number, cy: number, s: number) =>
  `${horn(cx, cy, s, -1)}${horn(cx, cy, s, 1)}${drop(cx, cy, s, C.gold)}${eyes(cx, cy, s)}<circle cx="${cx}" cy="${cy + 0.56 * s}" r="${0.09 * s}" stroke="${C.ink}" stroke-width="${0.035 * s}" fill="none"/>`;
export const snekSvg = (cx: number, cy: number, s: number) =>
  `${drop(cx, cy, s, C.up)}${eyes(cx, cy, s, true)}<path d="M ${cx} ${cy + 0.5 * s} L ${cx} ${cy + 0.74 * s} M ${cx} ${cy + 0.74 * s} L ${cx - 0.08 * s} ${cy + 0.86 * s} M ${cx} ${cy + 0.74 * s} L ${cx + 0.08 * s} ${cy + 0.86 * s}" stroke="${C.tongue}" stroke-width="${0.045 * s}" stroke-linecap="round" fill="none"/>`;
export const bearSvg = (cx: number, cy: number, s: number) =>
  `${[-1, 1].map((k) => `<circle cx="${cx + k * 0.5 * s}" cy="${cy - 0.02 * s}" r="${0.2 * s}" fill="${C.down}"/><circle cx="${cx + k * 0.5 * s}" cy="${cy - 0.02 * s}" r="${0.09 * s}" fill="#b85a3c"/>`).join("")}${drop(cx, cy, s, C.down)}${eyes(cx, cy, s)}<ellipse cx="${cx}" cy="${cy + 0.5 * s}" rx="${0.12 * s}" ry="${0.08 * s}" fill="${C.paper}" opacity="0.55"/>`;
export const crownSvg = (cx: number, cy: number, w: number) => {
  const h = w * 0.55;
  return `<path d="M ${cx - w / 2} ${cy + h / 2} L ${cx - w / 2} ${cy - h / 4} L ${cx - w / 4} ${cy + h / 8} L ${cx} ${cy - h / 2} L ${cx + w / 4} ${cy + h / 8} L ${cx + w / 2} ${cy - h / 4} L ${cx + w / 2} ${cy + h / 2} Z" fill="${C.gold}" stroke="${C.paper}" stroke-width="${w * 0.04}" stroke-linejoin="round"/>`;
};
const TEAM_SVG = [bullSvg, snekSvg, bearSvg];
/** One team's creature, optionally crowned, as a data URI for <img>. Team 0 Bull, 1 Snek, 2 Bear. */
export function creatureUri(team: number, crowned = false, size = 200) {
  const s = size * 0.36;
  const cx = size / 2;
  const cy = size * (crowned ? 0.6 : 0.55);
  const body = (TEAM_SVG[team] ?? snekSvg)(cx, cy, s) + (crowned ? crownSvg(cx, cy - s * 1.25, s * 0.85) : "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
export const TEAM_COLOR = [C.gold, C.up, C.down];
