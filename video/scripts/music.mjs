// The film's score: a light swing trio synthesised here, sample by sample.
// A Rhodes-style electric piano (two-operator FM with a bell tine) comps
// rootless voicings with sevenths and ninths; an upright bass walks quarter
// notes with chromatic approaches; brushes sweep and slap on two and four
// under a ride cymbal's swung pattern; a vibraphone plays a tune that rises
// for the outline and the close. Timing swings (the off-beat at 0.64 of a
// beat) and is humanised; velocities vary; a small stereo reverb places it
// in a room. The arrangement follows the timeline's scenes, thins out around
// the key reveals, and resolves on the tonic at the close. The sound events
// the scenes register are played by the same instruments, in key. Nothing
// is downloaded.
import { writeFileSync } from "node:fs";

const RATE = 48000;
const TAU = Math.PI * 2;
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const BPM = 118, BEAT = 60 / BPM, BAR = BEAT * 4, SWING = 0.64;

// I–vi–ii–V with a III–VI turn, in F: root (bass), rootless voicing, scale for the tune.
const PROG = [
  { root: 41, voice: [57, 60, 64, 67], tune: [65, 67, 69, 72, 74, 76] },   // Fmaj9
  { root: 38, voice: [53, 57, 60, 64], tune: [62, 64, 65, 69, 72, 74] },   // Dm9
  { root: 43, voice: [53, 57, 58, 62], tune: [65, 67, 69, 70, 74, 77] },   // Gm9
  { root: 36, voice: [58, 62, 64, 69], tune: [64, 67, 69, 70, 72, 74] },   // C13
  { root: 45, voice: [55, 60, 64, 67], tune: [64, 67, 69, 72, 76] },       // Am7
  { root: 38, voice: [54, 60, 63, 66], tune: [62, 66, 69, 72] },           // D7(b9)
  { root: 43, voice: [53, 57, 58, 62], tune: [65, 67, 69, 70, 74] },       // Gm9
  { root: 36, voice: [52, 58, 61, 64], tune: [64, 67, 70, 72] },           // C7(b9)
];
const TONIC = { root: 41, voice: [57, 60, 64, 67, 72], tune: [65, 69, 72, 77] };

// How much of each instrument a scene carries: piano, bass, drums, tune.
const MIX = {
  cold: [0.8, 0.0, 0.25, 0], cast: [1, 1, 0.8, 0.7], why: [1, 1, 1, 1], commit: [0.9, 0.9, 0.6, 0],
  forks: [1, 1, 0.8, 0.4], gate: [0.9, 1, 0.7, 0], plan: [1, 1, 0.9, 0.8], replay: [1, 1, 0.9, 0.6],
  metrics: [1, 1, 0.8, 0.3], cloud: [1, 1, 0.8, 0.5], close: [1, 1, 0.7, 1],
};

function rng(seed) { let x = (seed >>> 0) || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

export function score(timeline, sounds) {
  const total = timeline.total + 1.5;
  const n = Math.ceil(total * RATE);
  const L = new Float32Array(n), R = new Float32Array(n), SL = new Float32Array(n), SR = new Float32Array(n);
  const put = (i, l, r, send = 0) => { if (i >= 0 && i < n) { L[i] += l; R[i] += r; if (send) { SL[i] += l * send; SR[i] += r * send; } } };
  const rnd = rng(1234);
  const sceneAt = (t) => timeline.scenes.find((s) => t >= s.start && t < s.start + s.dur) ?? timeline.scenes[timeline.scenes.length - 1];
  const close = timeline.scenes.find((s) => s.id === "close");
  const tEnd = timeline.total;
  const reveals = sounds.filter((s) => ["reject", "approve", "swell"].includes(s.type)).map((s) => s.t);
  const thin = (t) => { const d = reveals.reduce((m, r) => Math.min(m, Math.abs(t - r)), 99); return Math.min(1, 0.35 + Math.max(0, d - 0.3) / 1.2); };
  // Each instrument's level at time t: the scene's mix, eased across cuts.
  const level = (t, k) => {
    const sc = sceneAt(t), mx = MIX[sc.id] ?? [1, 1, 0.8, 0];
    const prev = timeline.scenes[timeline.scenes.indexOf(sc) - 1];
    const into = Math.min(1, (t - sc.start) / 1.5);
    const before = prev ? (MIX[prev.id] ?? mx)[k] : mx[k];
    let v = before + (mx[k] - before) * into;
    if (sc.id === "cold") v *= Math.min(1, t / 6);
    return v;
  };
  const chordAt = (t) => (close && t >= close.start + close.dur - 6 ? TONIC : PROG[Math.floor(t / BAR) % PROG.length]);
  const swung = (beat) => Math.floor(beat) + (beat % 1 ? SWING : 0);   // beat in eighths .5 → swung

  // ── instruments ──────────────────────────────────────────────────────────
  function rhodes(t0, m, vel, dur, pan = 0.5) {
    const f = hz(m), i0 = Math.floor(t0 * RATE), len = Math.floor((dur + 0.6) * RATE);
    const idx0 = 1.2 + 1.3 * vel, a = 0.11 * vel * Math.pow(0.97, m - 55);
    for (let j = 0; j < len; j++) {
      const u = j / RATE;
      const env = Math.min(1, u / 0.004) * Math.exp(-u / 1.7) * (u > dur ? Math.exp(-(u - dur) / 0.12) : 1);
      const index = idx0 * Math.exp(-u / 0.22);
      const tine = 0.06 * vel * Math.exp(-u / 0.02) * Math.sin(TAU * f * 14 * u);
      const v = (Math.sin(TAU * f * u + index * Math.sin(TAU * f * u)) + tine) * env * a;
      const trem = 1 + 0.12 * Math.sin(TAU * 4.6 * (t0 + u));
      put(i0 + j, v * (1 - pan) * 1.6 * trem, v * pan * 1.6 * (2 - trem), 0.35);
    }
  }
  function bass(t0, m, vel, dur) {
    const f = hz(m), i0 = Math.floor(t0 * RATE), len = Math.floor((dur + 0.15) * RATE);
    let lp = 0, hpx = 0;
    for (let j = 0; j < len; j++) {
      const u = j / RATE;
      const env = Math.min(1, u / 0.006) * (0.55 * Math.exp(-u / 0.09) + 0.45 * Math.exp(-u / 0.9)) * (u > dur ? Math.exp(-(u - dur) / 0.05) : 1);
      const x = Math.sin(TAU * f * u) + 0.45 * Math.sin(TAU * 2 * f * u) * Math.exp(-u / 0.25) + 0.18 * Math.sin(TAU * 3 * f * u) * Math.exp(-u / 0.12);
      lp += 0.35 * (x - lp);
      const thump = u < 0.03 ? (rnd() * 2 - 1) * 0.15 * (1 - u / 0.03) : 0;
      hpx += 0.006 * ((lp + thump) - hpx);
      const v = ((lp + thump) - hpx) * env * 0.11 * vel;
      put(i0 + j, v, v, 0.08);
    }
  }
  const RIDE = [3127, 4231, 5163, 6527, 7411, 8893].map((f, k) => [f, k * 1.7]);
  function ride(t0, vel) {
    const i0 = Math.floor(t0 * RATE), len = Math.floor(1.6 * RATE);
    let hp = 0;
    for (let j = 0; j < len; j++) {
      const u = j / RATE;
      let bell = 0;
      for (const [f, ph] of RIDE) bell += Math.sin(TAU * f * u + ph);
      const w = rnd() * 2 - 1, h = w - hp; hp = w;
      const v = (bell * 0.035 * Math.exp(-u / 0.45) + h * 0.45 * Math.exp(-u / 0.3) + (u < 0.004 ? (rnd() - 0.5) * 0.8 : 0)) * 0.03 * vel;
      put(i0 + j, v * 0.7, v * 1.15, 0.3);
    }
  }
  function brushSlap(t0, vel) {
    const i0 = Math.floor(t0 * RATE), len = Math.floor(0.25 * RATE);
    let lp = 0;
    for (let j = 0; j < len; j++) {
      const u = j / RATE; lp += 0.45 * ((rnd() * 2 - 1) - lp);
      const v = lp * Math.exp(-u / 0.07) * 0.10 * vel;
      put(i0 + j, v * 1.1, v * 0.9, 0.4);
    }
  }
  function swish(t0, d, vel) {
    const i0 = Math.floor(t0 * RATE), len = Math.floor(d * RATE);
    let lp = 0;
    for (let j = 0; j < len; j++) {
      const u = j / len; lp += 0.25 * ((rnd() * 2 - 1) - lp);
      const v = lp * Math.sin(Math.PI * u) * 0.035 * vel;
      put(i0 + j, v * (1 - u * 0.5), v * (0.5 + u * 0.5), 0.3);
    }
  }
  function hat(t0, vel) {
    const i0 = Math.floor(t0 * RATE);
    let p = 0;
    for (let j = 0; j < 0.05 * RATE; j++) { const w = rnd() * 2 - 1, v = (w - p) * Math.exp(-(j / RATE) / 0.012) * 0.03 * vel; p = w; put(i0 + j, v * 0.8, v, 0.1); }
  }
  function vibe(t0, m, vel, dur = 1.4, pan = 0.5) {
    const f = hz(m), i0 = Math.floor(t0 * RATE), len = Math.floor((dur + 1.2) * RATE);
    for (let j = 0; j < len; j++) {
      const u = j / RATE;
      const env = Math.min(1, u / 0.003) * Math.exp(-u / 1.3) * (u > dur ? Math.exp(-(u - dur) / 0.4) : 1);
      const motor = 1 + 0.25 * Math.sin(TAU * 5.4 * u);
      const v = (Math.sin(TAU * f * u) + 0.22 * Math.sin(TAU * 4 * f * u) * Math.exp(-u / 0.2) + 0.08 * Math.sin(TAU * 10 * f * u) * Math.exp(-u / 0.05)) * env * motor * 0.07 * vel;
      put(i0 + j, v * (1 - pan) * 1.6, v * pan * 1.6, 0.45);
    }
  }

  // ── the band ─────────────────────────────────────────────────────────────
  const bars = Math.ceil(tEnd / BAR);
  const COMP = [[[0, 1.0], [1.5, 0.8]], [[0.5, 0.9], [2, 0.8], [3.5, 0.7]], [[0, 0.9], [2.5, 0.8]], [[1.5, 0.85], [3, 0.7]]];
  for (let b = 0; b < bars; b++) {
    const t0 = b * BAR;
    const ch = chordAt(t0), next = chordAt(t0 + BAR);
    const lv = (t) => [0, 1, 2, 3].map((k) => level(t, k));
    // Piano.
    const [pl] = lv(t0);
    if (pl > 0.02) {
      const isCold = sceneAt(t0).id === "cold";
      const pattern = isCold ? [[0, 0.7]] : COMP[Math.floor(rnd() * COMP.length)];
      for (const [beat, v0] of pattern) {
        const at = t0 + swung(beat) * BEAT + (rnd() - 0.5) * 0.016;
        const vel = v0 * (0.85 + rnd() * 0.25) * pl * thin(at);
        const dur = isCold ? BAR * 0.95 : BEAT * (beat % 1 ? 1.2 : 1.6);
        ch.voice.forEach((m, k) => rhodes(at + k * 0.007, m, vel, dur, 0.38 + k * 0.08));
      }
    }
    // Bass: root, then chord tones, then a chromatic approach to the next root.
    const [, bl] = lv(t0);
    if (bl > 0.02) {
      const r = ch.root;
      const minor = ch.voice.some((m) => (((m - r) % 12) + 12) % 12 === 3);
      const third = r + (minor ? 3 : 4), fifth = r + 7, sixth = r + (minor ? 10 : 9) - 12;
      const approach = next.root + (rnd() < 0.5 ? 1 : -1);
      const line = [r, rnd() < 0.5 ? third : fifth, rnd() < 0.5 ? fifth : sixth + 12, approach];
      line.forEach((m, k) => {
        const at = t0 + k * BEAT + (rnd() - 0.5) * 0.01;
        bass(at, Math.max(28, Math.min(48, m < 30 ? m + 12 : m)), (k === 0 ? 1 : 0.85 + rnd() * 0.15) * bl, BEAT * 0.92);
      });
    }
    // Drums: ride "ding, ding-a, ding, ding-a", brushes on 2 and 4, hat foot on 2 and 4.
    const [, , dl] = lv(t0);
    if (dl > 0.02) {
      for (const beat of [0, 1, 1.5, 2, 3, 3.5]) {
        const at = t0 + swung(beat) * BEAT + (rnd() - 0.5) * 0.008;
        ride(at, (beat % 1 ? 0.6 : beat % 2 ? 1 : 0.85) * (0.85 + rnd() * 0.2) * dl * thin(at));
      }
      for (const beat of [1, 3]) { const at = t0 + beat * BEAT; brushSlap(at, (0.8 + rnd() * 0.2) * dl * thin(at)); hat(at + 0.005, dl); }
      for (let k = 0; k < 4; k++) swish(t0 + k * BEAT, BEAT, 0.8 * dl);
    }
    // The tune: a two-bar phrase every two bars, swung eighths with rests,
    // an octave higher in the second half of a scene that carries it.
    const [, , , tl] = lv(t0);
    if (tl > 0.02 && b % 2 === 0) {
      const sc = sceneAt(t0);
      const lift = (t0 - sc.start) / sc.dur > 0.5 || sc.id === "close" ? 12 : 0;
      const shape = [[0.5, 0], [1, 1], [1.5, 2], [2.5, 3], [3, 2], [4.5, 1], [5, 2], [5.5, 4], [6, 3]];
      const rhythm = shape.filter(() => rnd() < 0.78);
      for (const [beat, step] of rhythm) {
        const at = t0 + swung(beat) * BEAT + (rnd() - 0.5) * 0.012;
        const c2 = chordAt(at);
        const m = c2.tune[Math.min(c2.tune.length - 1, step)] + lift - 12;
        vibe(at, m, (0.7 + rnd() * 0.3) * tl * thin(at), BEAT * 0.9, 0.62);
      }
    }
  }
  // The close resolves: the tonic, held, with a cymbal swell into it.
  if (close) {
    const tz = close.start + close.dur - 6;
    TONIC.voice.forEach((m, k) => rhodes(tz + k * 0.03, m, 0.9, 5.5, 0.35 + k * 0.08));
    bass(tz, 41, 1, 3.5);
    vibe(tz + 0.4, 77, 0.8, 3, 0.65); vibe(tz + 0.9, 81, 0.7, 3, 0.7);
    for (let k = 0; k < 24; k++) ride(tz - 1.2 + k * 0.05, 0.12 + k * 0.03);
  }

  // ── the scenes' sound events, played in key ───────────────────────────────
  for (const sd of sounds) {
    const g = sd.gain ?? 1, ch = chordAt(sd.t);
    if (sd.type === "tick") vibe(sd.t, ch.tune[Math.floor(rnd() * ch.tune.length)] + 12, 0.25 * g, 0.2, 0.3 + rnd() * 0.4);
    else if (sd.type === "whoosh") swish(sd.t - 0.35, 0.7, 2.2 * g);
    else if (sd.type === "swell") for (let k = 0; k < 30; k++) ride(sd.t - 1.5 + k * 0.05, (0.05 + k * 0.025) * g);
    else if (sd.type === "chime") ch.tune.slice(0, 3).forEach((m, k) => vibe(sd.t + k * 0.09, m + 12, 0.55 * g, 0.6, 0.4 + k * 0.1));
    else if (sd.type === "approve") { vibe(sd.t, ch.tune[2] + 12, 0.8 * g, 0.5); vibe(sd.t + 0.14, ch.tune[0] + 24, 0.8 * g, 0.9); }
    else if (sd.type === "reject") { bass(sd.t, 37, 0.9 * g, 0.5); rhodes(sd.t, 59, 0.6 * g, 0.4); rhodes(sd.t, 60, 0.6 * g, 0.4); }
  }

  // ── room: a small stereo reverb on the send ──────────────────────────────
  const reverb = (inp, offset) => {
    const out = new Float32Array(n);
    const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(Math.round((d + offset) * RATE / 44100)), i: 0, lp: 0 }));
    const alls = [556, 441].map((d) => ({ buf: new Float32Array(Math.round((d + offset) * RATE / 44100)), i: 0 }));
    for (let j = 0; j < n; j++) {
      const x = inp[j] * 0.3;
      let y = 0;
      for (const c of combs) { const o = c.buf[c.i]; c.lp = o * 0.75 + c.lp * 0.25; c.buf[c.i] = x + c.lp * 0.8; c.i = (c.i + 1) % c.buf.length; y += o; }
      for (const a of alls) { const o = a.buf[a.i]; const v = -y + o; a.buf[a.i] = y + o * 0.5; a.i = (a.i + 1) % a.buf.length; y = v; }
      out[j] = y;
    }
    return out;
  };
  const wl = reverb(SL, 0), wr = reverb(SR, 23);
  for (let j = 0; j < n; j++) { L[j] += wl[j] * 0.5; R[j] += wr[j] * 0.5; }
  // Fade in and out; soft clip; 16-bit stereo WAV.
  const pcm = Buffer.alloc(n * 4);
  for (let j = 0; j < n; j++) {
    const t = j / RATE, fade = Math.min(1, t / 2.5) * Math.min(1, Math.max(0, (total - t) / 2));
    pcm.writeInt16LE(Math.round(Math.tanh(L[j] * fade * 1.4) * 30000), j * 4);
    pcm.writeInt16LE(Math.round(Math.tanh(R[j] * fade * 1.4) * 30000), j * 4 + 2);
  }
  const hd = Buffer.alloc(44);
  hd.write("RIFF", 0); hd.writeUInt32LE(36 + pcm.length, 4); hd.write("WAVE", 8); hd.write("fmt ", 12);
  hd.writeUInt32LE(16, 16); hd.writeUInt16LE(1, 20); hd.writeUInt16LE(2, 22); hd.writeUInt32LE(RATE, 24);
  hd.writeUInt32LE(RATE * 4, 28); hd.writeUInt16LE(4, 32); hd.writeUInt16LE(16, 34); hd.write("data", 36); hd.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hd, pcm]);
}

export function writeScore(file, timeline, sounds) { writeFileSync(file, score(timeline, sounds)); }
