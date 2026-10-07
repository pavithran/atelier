// Speaks one paragraph in several voices, to choose one.
import { synth, wavSeconds } from "./tts.mjs";
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
const text = "Work reaches main only through the gate. Take task t278, from 7 October: the Worker pulls Cloudflare AI Gateway's logs into Analytics Engine. Opus 5.5 built it. Atelier read the pushed head from Artifacts and ran the project's two required checks in a clean clone of exactly that revision.";
const words = text.split(/\s+/).length;
mkdirSync(new URL("../.cache/trial/", import.meta.url).pathname, { recursive: true });
for (const voice of (process.argv.slice(2).length ? process.argv.slice(2) : ["cedar", "ash", "onyx"])) {
  const f = await synth(text, { voice });
  const s = wavSeconds(readFileSync(f));
  copyFileSync(f, new URL(`../.cache/trial/${voice}.wav`, import.meta.url).pathname);
  console.log(voice, s.toFixed(1) + "s", Math.round(words / s * 60) + " wpm");
}
