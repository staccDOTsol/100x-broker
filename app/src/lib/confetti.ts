// One cheap burst on a confirmed buy. DOM spans, CSS-driven, gone in a second. Skipped under reduced motion.
export function confetti(side: 0 | 1) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = document.createElement("div");
  host.className = "confetti";
  host.setAttribute("aria-hidden", "true");
  const colors = side === 0 ? ["var(--up)", "var(--signal)", "var(--ink)"] : ["var(--down)", "var(--signal)", "var(--ink)"];
  for (let i = 0; i < 48; i++) {
    const p = document.createElement("i");
    const angle = (Math.PI * 2 * i) / 48 + Math.random() * 0.4;
    const dist = 160 + Math.random() * 220;
    p.style.setProperty("--x", `${Math.cos(angle) * dist}px`);
    p.style.setProperty("--y", `${Math.sin(angle) * dist - 120}px`);
    p.style.setProperty("--r", `${Math.random() * 720 - 360}deg`);
    p.style.setProperty("--d", `${700 + Math.random() * 500}ms`);
    p.style.background = colors[i % colors.length];
    p.style.width = p.style.height = `${6 + Math.random() * 8}px`;
    host.appendChild(p);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 1400);
}
