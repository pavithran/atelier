// Text-to-speech through OpenAI's gpt-4o-mini-tts, cached by a hash of
// everything that shapes the audio, so a rebuild pays only for changed text.
// The key is read from ~/.config/api-keys/openai.key into the request's
// Authorization header and nowhere else.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CACHE = new URL("../.cache/tts/", import.meta.url).pathname;
const LEDGER = CACHE + "spend.json";
export const MODEL = "gpt-4o-mini-tts";
export const VOICE = process.env.VIDEO_VOICE ?? "nova";
// The spoken audio is sped up by this factor, pitch kept, for a brisker read.
export const TEMPO = Number(process.env.VIDEO_TEMPO ?? 0.95);
export const INSTRUCTIONS = process.env.VIDEO_INSTRUCTIONS ?? "Voice: casual, friendly and natural, someone in their early twenties showing a friend a thing they built. Conversational and light, quick but relaxed, like talking across a desk. Not dramatic, not an announcer, no big pauses, no emphasis for effect. Pronounce 'Atelier' as 'a-tel-yay'. Say 'Artifacts' as the plain word. Read t278 as 't two seventy-eight', UTC as 'U T C', GLM as 'G L M'.";

// Estimated price: $0.60 per million text tokens in and $12 per million audio
// tokens out, which OpenAI gives as about $0.015 a minute of speech.
const PER_MINUTE = 0.015;

function spend() { return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { calls: 0, seconds: 0, estimatedUsd: 0 }; }

export function wavSeconds(buf) {
  // PCM WAV: find the fmt and data chunks.
  let off = 12, rate = 24000, channels = 1, bits = 16, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); let len = buf.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    if (id === "data") { if (len === 0xffffffff || off + 8 + len > buf.length) len = buf.length - off - 8; dataLen = len; break; }
    off += 8 + len + (len % 2);
  }
  return dataLen / (rate * channels * bits / 8);
}

export async function synth(text, { voice = VOICE, instructions = INSTRUCTIONS } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const hash = createHash("sha256").update(JSON.stringify([MODEL, voice, instructions, text])).digest("hex").slice(0, 24);
  const file = CACHE + hash + ".wav";
  if (existsSync(file)) return file;
  const s = spend();
  if (s.estimatedUsd > 2.5) throw new Error(`TTS spend estimate is $${s.estimatedUsd.toFixed(2)}; stopping below the $3 limit`);
  const key = readFileSync(homedir() + "/.config/api-keys/openai.key", "utf8").trim();
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, voice, input: text, instructions, response_format: "wav" }),
    });
    if (res.ok) break;
    if (attempt === 3 || res.status < 500 && res.status !== 429) throw new Error(`TTS failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  const secs = wavSeconds(buf);
  s.calls++; s.seconds += secs; s.estimatedUsd = s.seconds / 60 * PER_MINUTE + s.calls * 0; s.chars = (s.chars ?? 0) + text.length;
  writeFileSync(LEDGER, JSON.stringify(s, null, 1));
  return file;
}

export function spendSoFar() { return spend(); }

// Word timings for a narration file, from OpenAI's whisper-1, cached beside
// the audio. Captions use them to start each line on its first spoken word.
// Priced at $0.006 a minute; counted in the same spend file.
export async function wordTimes(file) {
  const out = file.replace(/\.wav$/, ".words.json");
  if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8"));
  const key = readFileSync(homedir() + "/.config/api-keys/openai.key", "utf8").trim();
  const buf = readFileSync(file);
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("file", new Blob([buf], { type: "audio/wav" }), "cue.wav");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
  const j = await res.json();
  const words = (j.words ?? []).map((w) => ({ w: w.word, s: w.start, e: w.end }));
  writeFileSync(out, JSON.stringify(words));
  const s = spend();
  s.transcribedSeconds = (s.transcribedSeconds ?? 0) + wavSeconds(buf);
  s.transcriptionUsd = s.transcribedSeconds / 60 * 0.006;
  writeFileSync(LEDGER, JSON.stringify(s, null, 1));
  return words;
}

// The cue at the film's tempo: the synthesised audio through ffmpeg's
// atempo, which keeps the pitch, cached beside the original.
import { execFileSync } from "node:child_process";
export async function synthAtTempo(text, opts) {
  const file = await synth(text, opts);
  if (TEMPO === 1) return file;
  const out = file.replace(/\.wav$/, `.t${TEMPO}.wav`);
  if (!existsSync(out)) execFileSync(existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-af", `atempo=${TEMPO}`, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  return out;
}
