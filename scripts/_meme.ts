import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "fs";
const F = (f: string) => readFileSync(`/Users/stacc/hooked/app/api/_fonts/${f}`);
const fonts: any = [
  { name: "Display", data: F("IBMPlexSansCondensed-Bold.ttf"), weight: 700, style: "normal" },
  { name: "Mono", data: F("IBMPlexMono-SemiBold.ttf"), weight: 600, style: "normal" },
  { name: "Sans", data: F("IBMPlexSans-SemiBold.ttf"), weight: 600, style: "normal" },
];
const C = { paper: "#171412", paper2: "#221d19", ink: "#ece6da", ink3: "#8a8073", up: "#5fcf8f", down: "#f0825d", signal: "#f2c14e" };
const h = (type: string, props: any = {}, ...children: any[]) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
const t = (s: string, style: any) => h("div", { style: { display: "flex", ...style } }, s);
const sticker = (s: string, rot: number, top: number, left: number) =>
  t(s, { position: "absolute", top, left, transform: `rotate(${rot}deg)`, background: C.signal, color: "#1c1a17", fontFamily: "Display", fontSize: 44, padding: "8px 18px", borderRadius: 6, textTransform: "uppercase", letterSpacing: 2, boxShadow: `6px 6px 0 ${C.ink}` });
const el = h("div", { style: { width: 1000, height: 1000, display: "flex", flexDirection: "column", background: C.paper, color: C.ink, padding: 64, position: "relative", fontFamily: "Sans" } },
  t("I REALLY DIDN'T WANT A MEMECOIN FOR THIS", { fontFamily: "Mono", fontSize: 30, color: C.ink3, letterSpacing: 2 }),
  h("div", { style: { display: "flex", flexDirection: "column", marginTop: 40, lineHeight: 0.82 } },
    t("100×", { fontFamily: "Display", fontSize: 420, letterSpacing: -14, color: C.ink }),
    h("div", { style: { display: "flex", gap: 28, marginTop: 10 } },
      t("UP", { fontFamily: "Display", fontSize: 200, color: C.up, letterSpacing: -6 }),
      t("OR", { fontFamily: "Display", fontSize: 200, color: C.ink3, letterSpacing: -6 }),
      t("DOWN", { fontFamily: "Display", fontSize: 200, color: C.down, letterSpacing: -6 }),
    ),
  ),
  h("div", { style: { display: "flex", flexDirection: "column", marginTop: "auto", gap: 14 } },
    t("platform's been live an hour. zero users.", { fontFamily: "Mono", fontSize: 38, color: C.ink }),
    t("so. yolo, i guess.", { fontFamily: "Mono", fontSize: 38, color: C.ink3 }),
  ),
  h("div", { style: { position: "absolute", bottom: 40, right: 56, display: "flex", alignItems: "baseline", gap: 2 } },
    t("100x", { fontFamily: "Display", fontSize: 48 }), t(".broker", { fontFamily: "Display", fontSize: 34, color: C.ink3 })),
  sticker("no liquidations", -7, 150, 560),
  sticker("the loser pays you", 4, 690, 520),
);
const svg = await satori(el as any, { width: 1000, height: 1000, fonts });
writeFileSync("/Users/stacc/hooked/meme.png", new Resvg(svg, { fitTo: { mode: "width", value: 1000 } }).render().asPng());
console.log("ok");
