// Cut the raw Playwright recording into one short per scene plus the whole run, as H.264 MP4s that play anywhere
// (X, Telegram, QuickTime). Reads scenes.json from the last `bun tour.ts` run; writes out/full.mp4 and out/<n>-<scene>.mp4.
// Playwright's video runs ~10% longer than the wall clock it recorded, so full.mp4 is retimed to wall clock first and the
// shorts are cut from it by the scene timestamps.
import fs from "node:fs";

type Scenes = { video: string; runEnd?: number; scenes: { id: string; title: string; start: number; end: number }[] };
const { video, runEnd, scenes } = JSON.parse(fs.readFileSync(process.argv[2] ?? "scenes.json", "utf8")) as Scenes;
fs.mkdirSync("out", { recursive: true });
const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"];

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(cmd.join(" "));
  return out;
}
const ff = (args: string[]) => run(["ffmpeg", "-loglevel", "error", "-y", ...args]);

const dur = Number(await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]));
const wall = runEnd ?? scenes.at(-1)!.end + 3; // older runs didn't record runEnd: last scene + the closing caption
const k = wall / dur;
await ff(["-i", video, "-vf", `setpts=PTS*${k.toFixed(5)}`, "-r", "25", ...enc, "out/full.mp4"]);
console.log(`out/full.mp4  ${wall.toFixed(0)}s (raw ${dur.toFixed(0)}s, x${k.toFixed(4)})`);
for (const [i, s] of scenes.entries()) {
  const from = Math.max(0, s.start - 0.2);
  const out = `out/${String(i + 1).padStart(2, "0")}-${s.id}.mp4`;
  await ff(["-ss", from.toFixed(2), "-i", "out/full.mp4", "-t", (s.end - from + 0.4).toFixed(2), ...enc, out]);
  console.log(`${out}  ${s.title}  ${(s.end - s.start).toFixed(0)}s`);
}
