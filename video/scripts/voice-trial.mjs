// Speaks one paragraph in several voices, to choose one.
import { synth, wavSeconds } from "./tts.mjs";
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
const text = "Git records commits, but a commit message is the agent talking about itself. Atelier records what it observed instead. The harder question is what to believe. An agent can say its tests pass when they never ran. So Atelier counts only what it observes: it reads the pushed head from Artifacts, and runs the required checks in a clean clone of exactly that revision. Task t278, on 7 October: Opus 5.5 built it, and Gemini 3.1 Pro rejected it twice.";
const words = text.split(/\s+/).length;
mkdirSync(new URL("../.cache/trial/", import.meta.url).pathname, { recursive: true });
for (const voice of (process.argv.slice(2).length ? process.argv.slice(2) : ["cedar", "ash", "onyx"])) {
  const f = await synth(text, { voice });
  const s = wavSeconds(readFileSync(f));
  copyFileSync(f, new URL(`../.cache/trial/v4-${voice}.wav`, import.meta.url).pathname);
  console.log(voice, s.toFixed(1) + "s", Math.round(words / s * 60) + " wpm");
}
