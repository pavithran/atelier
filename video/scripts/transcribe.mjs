// Transcribes a WAV with gpt-4o-mini-transcribe, to check what a listener hears.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const key = readFileSync(homedir() + "/.config/api-keys/openai.key", "utf8").trim();
for (const f of process.argv.slice(2)) {
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("file", new Blob([readFileSync(f)], { type: "audio/wav" }), "a.wav");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  console.log(f.split("/").pop(), res.ok ? (await res.json()).text : res.status);
}
