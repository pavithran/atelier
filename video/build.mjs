// Builds the film from docs/video.md, data/, the captured screens and the
// scenes in scenes/: narration by text-to-speech (cached), a timeline that
// fits each scene to its narration, captions timed to the audio, frames
// rendered from HTML with the clock driven here, and the encode.
//
//   npm run build            the whole film
//   npm run build -- --only gate --preview   one scene, half size, fast
//
// The rendered film and contact sheet go to ~/Documents/ai-project-data/
// atelier/video/ unless VIDEO_OUT names another folder.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { synthAtTempo as synth, wavSeconds, spendSoFar, VOICE, wordTimes } from "./scripts/tts.mjs";
import { writeScore } from "./scripts/music.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const CACHE = HERE + ".cache/";
const OUT = process.env.VIDEO_OUT ?? homedir() + "/Documents/ai-project-data/atelier/video/";
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const FPS = 30;
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ONLY = opt("--only");
const PREVIEW = flag("--preview");
const WORKERS = Number(opt("--workers") ?? 8);
// The theme: "dark" (the Night theme, two scenes on the light ground) or
// "bright" (the light theme throughout). One timeline serves both.
const THEME = opt("--theme") ?? "dark";
if (!["dark", "bright"].includes(THEME)) throw new Error("--theme is dark or bright");
const NAME = opt("--name") ?? `atelier-v7-${THEME}`;

// ── the script ─────────────────────────────────────────────────────────────

function parseScript(md) {
  const scenes = [];
  let scene = null, cue = [];
  const endCue = () => { if (scene && cue.length) { scene.cues.push(cue.join(" ").trim()); cue = []; } };
  for (const line of md.split("\n")) {
    const h = line.match(/^## \d+\. (.+?) \{#([a-z0-9-]+)\}\s*$/);
    if (h) { endCue(); scene = { id: h[2], title: h[1], cues: [] }; scenes.push(scene); continue; }
    if (/^## /.test(line)) { endCue(); scene = null; continue; }
    if (!scene) continue;
    if (/^>\s?/.test(line)) {
      const text = line.replace(/^>\s?/, "").trim();
      if (text) cue.push(text); else endCue();
    } else endCue();
  }
  endCue();
  return scenes;
}

// ── captions ───────────────────────────────────────────────────────────────

// A sentence ends at . ! or ? followed by a space and a capital or a digit,
// so "Opus 5.5" and "atelier.zone" stay whole.
const sentencesOf = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim()).filter(Boolean);

// Splits a sentence into caption lines of at most MAX characters, at
// punctuation where it can, else at a word.
const MAX = 118;
function chunks(sentence) {
  if (sentence.length <= MAX) return [sentence];
  const words = sentence.split(" ");
  const parts = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length > MAX && cur) { parts.push(cur); cur = w; } else cur = next;
    if (/[,;:]$/.test(w) && cur.length > MAX * 0.45) { parts.push(cur); cur = ""; }
  }
  if (cur) parts.push(cur);
  // Join a short tail onto the line before it when they fit together.
  for (let i = parts.length - 1; i > 0; i--) if (parts[i].length < 18 && parts[i - 1].length + parts[i].length + 1 <= MAX + 10) { parts[i - 1] += " " + parts[i]; parts.splice(i, 1); }
  return parts;
}

// Times each caption line of a cue against its audio: the line starts when
// its first word is spoken, by the word timings of a transcription of the
// cue (cached). Script words and spoken words are matched in order; a line
// whose first word cannot be matched is placed by its share of characters.
const normWord = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
function captionCue(text, words, dur) {
  const lines = sentencesOf(text).flatMap(chunks);
  const spoken = words.map((w) => ({ ...w, n: normWord(w.w) })).filter((w) => w.n);
  const total = text.length;
  let j = 0, chars = 0;
  const starts = lines.map((line, i) => {
    const first = line.split(/\s+/).map(normWord).filter(Boolean);
    const est = chars / total * dur;
    chars += line.length + 1;
    if (i === 0) return 0;
    // Look ahead a few spoken words for this line's first two words.
    for (let k = j; k < Math.min(spoken.length, j + 40); k++) {
      if (spoken[k].n === first[0] && (!first[1] || !spoken[k + 1] || spoken[k + 1].n === first[1] || (first[2] && spoken[k + 2]?.n === first[2]))) {
        if (Math.abs(spoken[k].s - est) < 4) { j = k + 1; return Math.max(0, spoken[k].s - 0.12); }
      }
    }
    return est;
  });
  return lines.map((line, i) => ({ start: starts[i], end: i + 1 < lines.length ? starts[i + 1] : dur, text: line }));
}

// ── the timeline ───────────────────────────────────────────────────────────

// Seconds before the first cue, between cues, and after the last; some
// scenes hold longer after their narration to show a real page.
// A chapter's first scene opens on its chapter card (scenes/film.js CARD),
// so its narration waits for the card; the midpoint card is longer.
const LEAD = { cold: 1.2, why: 1.9, cast: 1.9, gate: 1.9, plan: 3.2, metrics: 1.9, who: 1.9, cloud: 1.9, default: 0.8 };
const GAP = 0.32;
const TAIL = { default: 1.4, cold: 1.6, why: 3.6, cast: 1.6, gate: 2.6, stories: 1.6, plan: 1.4, metrics: 1.4, who: 1.6, cloud: 1.4, close: 2.6 };

async function timeline(scenes) {
  let t = 0;
  const out = [];
  for (const sc of scenes) {
    const lead = LEAD[sc.id] ?? LEAD.default;
    const cues = [];
    let c = lead;
    for (const text of sc.cues) {
      const file = await synth(text);
      const dur = wavSeconds(readFileSync(file));
      const words = await wordTimes(file);
      cues.push({ start: c, end: c + dur, file, text, words, captions: captionCue(text, words, dur).map((k) => ({ ...k, start: k.start + c, end: k.end + c })) });
      c += dur + GAP;
    }
    const dur = c - GAP + (TAIL[sc.id] ?? TAIL.default);
    out.push({ id: sc.id, title: sc.title, start: t, dur, cues });
    t += dur;
  }
  return { total: t, scenes: out };
}

// ── audio ──────────────────────────────────────────────────────────────────

function readPcm(file) {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); let len = buf.readUInt32LE(off + 4);
    if (id === "fmt ") { if (buf.readUInt32LE(off + 12) !== 24000 || buf.readUInt16LE(off + 10) !== 1) throw new Error("expected 24 kHz mono"); }
    if (id === "data") { if (len === 0xffffffff || off + 8 + len > buf.length) len = buf.length - off - 8; return buf.subarray(off + 8, off + 8 + len); }
    off += 8 + len + (len % 2);
  }
  throw new Error("no data chunk in " + file);
}
function wavHeader(bytes, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  return h;
}
function narrationTrack(tl, file) {
  const rate = 24000;
  const samples = Math.ceil(tl.total * rate);
  const pcm = Buffer.alloc(samples * 2);
  for (const sc of tl.scenes) for (const c of sc.cues) {
    const src = readPcm(c.file);
    const at = Math.round((sc.start + c.start) * rate) * 2;
    src.copy(pcm, at, 0, Math.min(src.length, pcm.length - at));
  }
  writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
}

// ── frames ─────────────────────────────────────────────────────────────────

async function renderSegment(index, from, to, tl, data, size, segFile) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: size });
  await page.goto("file://" + HERE + "scenes/film.html");
  await page.evaluate(async ([tl, data, theme]) => { await window.film.init(tl, data, theme); }, [tl, data, THEME]);
  const w = Math.round(1920 * size), h = Math.round(1080 * size);
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", PREVIEW ? "veryfast" : "medium", "-crf", PREVIEW ? "26" : "17", "-tune", "animation",
    "-vf", `scale=${w}:${h}:in_range=pc:out_range=tv,format=yuv420p`, "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-r", String(FPS), segFile], { stdio: ["pipe", "inherit", "inherit"] });
  for (let f = from; f < to; f++) {
    await page.evaluate((t) => window.film.seek(t), f / FPS);
    const jpg = await page.screenshot({ type: "jpeg", quality: 94 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    if ((f - from) % 300 === 0) console.log(`  worker ${index}: frame ${f - from} of ${to - from}`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (code) => code === 0 ? r() : j(new Error("ffmpeg exited " + code))));
  await browser.close();
}

async function renderFrames(tl, data, startSec, endSec, size, dir) {
  const first = Math.round(startSec * FPS), last = Math.round(endSec * FPS);
  const n = Math.max(1, Math.min(WORKERS, Math.ceil((last - first) / 120)));
  const per = Math.ceil((last - first) / n);
  const segs = [];
  await Promise.all(Array.from({ length: n }, (_, i) => {
    const a = first + i * per, b = Math.min(last, a + per);
    const seg = `${dir}seg-${String(i).padStart(2, "0")}.mp4`;
    segs.push(seg);
    return renderSegment(i, a, b, tl, data, size, seg);
  }));
  segs.sort();
  writeFileSync(dir + "segments.txt", segs.map((s) => `file '${s}'`).join("\n"));
  return dir + "segments.txt";
}

// ── main ───────────────────────────────────────────────────────────────────

const script = parseScript(readFileSync(HERE + "../docs/video.md", "utf8"));
if (!script.length) throw new Error("no scenes found in docs/video.md");
if (!existsSync(CACHE + "screens/meta.json")) execFileSync("node", [HERE + "scripts/capture.mjs"], { stdio: "inherit" });
// The live page of t278, captured signed in at 3840 by 1906 (two pixels a
// CSS pixel) and kept out of Git in public/footage/, cut to the two panels
// the film shows: the Thread, and Checks and reviews.
mkdirSync(CACHE + "footage", { recursive: true });
for (const [name, from, crop] of [["t278-thread", "t278-2-thread", "1740:380:1060:20"], ["t278-reviews", "t278-3-reviews", "1740:720:1060:630"]]) {
  if (!existsSync(`${CACHE}footage/${name}.png`)) execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", `${HERE}public/footage/${from}.png`, "-vf", `crop=${crop}`, `${CACHE}footage/${name}.png`]);
}

console.log(`Narration: ${script.reduce((n, s) => n + s.cues.join(" ").split(/\s+/).length, 0)} words in ${script.length} scenes, voice ${VOICE}.`);
const tl = await timeline(script);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
for (const s of tl.scenes) console.log(`  ${s.id.padEnd(9)} ${fmt(s.start).padStart(5)}  ${fmt(s.dur)}  ${s.title}`);
console.log(`Total ${fmt(tl.total)} (${tl.total.toFixed(1)} s). TTS so far: ${JSON.stringify(spendSoFar())}`);

const data = JSON.parse(readFileSync(HERE + "data/ledger.json", "utf8"));
const term = (f) => readFileSync(HERE + "data/terminal/" + f, "utf8");
data.terminal = { note: term("note-5af22431.txt"), noteFull: term("note-5af22431-full.txt"), commit: term("commit-de67194.txt"), freshLog: term("fresh-log.txt"), freshNote: term("fresh-note.txt") };
data.screens = JSON.parse(readFileSync(CACHE + "screens/meta.json", "utf8"));
writeFileSync(CACHE + "timeline.json", JSON.stringify(tl, null, 1));

// Subtitles as a side file too, from the same timings.
const srtTime = (s) => { const ms = Math.round(s * 1000); const z = (n, w = 2) => String(n).padStart(w, "0"); return `${z(Math.floor(ms / 3600000))}:${z(Math.floor(ms / 60000) % 60)}:${z(Math.floor(ms / 1000) % 60)},${z(ms % 1000, 3)}`; };
const caps = tl.scenes.flatMap((s) => s.cues.flatMap((c) => c.captions.map((k) => ({ start: s.start + k.start, end: s.start + k.end, text: k.text }))));
mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + NAME + ".srt", caps.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n"));

if (flag("--timeline-only")) process.exit(0);

// Stills to look at: a few frames of each scene, or of the scenes --only names.
if (flag("--stills")) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto("file://" + HERE + "scenes/film.html");
  await page.evaluate(async ([tl, data, theme]) => { await window.film.init(tl, data, theme); }, [tl, data, THEME]);
  const dir = CACHE + "stills/";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const at = (opt("--at") ?? "0.12,0.35,0.6,0.85,0.97").split(",").map(Number);
  for (const sc of tl.scenes.filter((x) => !ONLY || ONLY.split(",").includes(x.id))) {
    for (const f of at) {
      const T = sc.start + sc.dur * f;
      await page.evaluate((T) => window.film.seek(T), T);
      await page.screenshot({ path: `${dir}${sc.id}-${String(Math.round(f * 100)).padStart(2, "0")}.png` });
    }
  }
  await browser.close();
  console.log("stills in " + dir);
  process.exit(0);
}

const work = CACHE + "render/";
const MUX_ONLY = flag("--mux-only") && existsSync(work + "segments.txt");
if (!MUX_ONLY) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const range = ONLY ? tl.scenes.find((s) => s.id === ONLY) : null;
if (ONLY && !range) throw new Error("no scene " + ONLY);
const t0 = range ? range.start : 0, t1 = range ? range.start + range.dur : tl.total;
const size = PREVIEW ? 0.5 : 1;
const began = Date.now();
const list = MUX_ONLY ? work + "segments.txt" : await renderFrames(tl, data, t0, t1, size, work);
console.log(`Frames rendered in ${Math.round((Date.now() - began) / 1000)} s.`);

narrationTrack(tl, work + "narration.wav");
// The score, from the sound events the scenes registered on the same clock.
{
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto("file://" + HERE + "scenes/film.html");
  await page.evaluate(async ([tl, data, theme]) => { await window.film.init(tl, data, theme); }, [tl, data, THEME]);
  const sounds = await page.evaluate(() => window.film.sounds());
  await browser.close();
  writeScore(work + "score.wav", tl, sounds);
  console.log(`Score: ${sounds.length} sound events.`);
}
const final = range ? `${CACHE}preview-${ONLY}.mp4` : OUT + NAME + ".mp4";
// The mix: the voice brought to -16 LUFS, the score to -24 LUFS and ducked
// under the voice, then summed and limited.
const mixFilter = "[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-2:LRA=9,asplit=2[v1][v2];" +
  "[2:a]loudnorm=I=-24:TP=-6:LRA=14[bed];[bed][v1]sidechaincompress=threshold=0.03:ratio=5:attack=60:release=700:makeup=1[ducked];" +
  "[ducked][v2]amix=inputs=2:normalize=0,alimiter=limit=0.93,aresample=48000[aout]";
if (range) {
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-ss", String(t0), "-t", String(t1 - t0), "-i", work + "narration.wav", "-ss", String(t0), "-t", String(t1 - t0), "-i", work + "score.wav",
    "-filter_complex", mixFilter, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", final], { stdio: "inherit" });
} else {
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", work + "narration.wav", "-i", work + "score.wav",
    "-filter_complex", mixFilter, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(tl.total), "-movflags", "+faststart", final], { stdio: "inherit" });
}
console.log("Wrote " + final);
if (!range) {
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", final, "-vf", "scale=1280:720", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "copy", "-movflags", "+faststart", OUT + NAME + "-720p.mp4"]);
  console.log("Wrote " + OUT + NAME + "-720p.mp4");
}

// One frame per scene, taken a little past the middle, as a contact sheet.
if (!range) {
  const frames = tl.scenes.map((s, i) => {
    const f = `${work}sheet-${i}.png`;
    const last = s.cues.at(-1);
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-ss", (s.start + last.start + (last.end - last.start) * 0.7).toFixed(2), "-i", final, "-frames:v", "1", "-vf", "scale=640:360", f]);
    return f;
  });
  const cols = 2, rows = Math.ceil(frames.length / cols);
  const inputs = frames.flatMap((f) => ["-i", f]);
  const pads = frames.length < cols * rows ? 1 : 0;
  const layout = frames.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join("|");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `xstack=inputs=${frames.length}:layout=${layout}:fill=black`, OUT + NAME + "-contact-sheet.png"]);
  console.log("Wrote " + OUT + NAME + "-contact-sheet.png");
}
console.log(`TTS spend so far (estimate): ${JSON.stringify(spendSoFar())}`);
