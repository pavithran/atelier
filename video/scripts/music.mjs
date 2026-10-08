// The film's score and sound design, synthesised here from the timeline:
// warm pads on a slow chord progression, a soft pulse that builds through
// the outline and the plan and drops away around the key reveals, and the
// sound events the scenes register (ticks as tasks appear, swells, a low
// thud on a rejection, a bright two-note chime on an approval). Nothing is
// downloaded; every sample is computed here.
import { writeFileSync } from "node:fs";

const RATE = 48000;
const TAU = Math.PI * 2;
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
// A minor, warm voicings: Am9, Fmaj7, C(add9), G6; the close resolves on C(add9).
const CHORDS = [
  [45, 52, 55, 59, 60, 64],
  [41, 48, 52, 57, 60, 64],
  [36, 48, 55, 62, 64, 67],
  [43, 50, 55, 59, 62, 64],
];
const RESOLVE = [36, 43, 52, 55, 62, 64, 67];

// How much pulse each scene carries, from 0 to 1; the outline builds.
const PULSE = { cold: 0, outline: [0.25, 0.9], forks: 0.45, gate: 0.35, catches: 0.3, plan: 0.8, replay: 0.75, runners: 0.45, cloud: 0.6, close: 0 };

function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); }; }

export function score(timeline, sounds) {
  const total = timeline.total;
  const n = Math.ceil(total * RATE);
  const L = new Float32Array(n), R = new Float32Array(n);
  const add = (i, l, r) => { if (i >= 0 && i < n) { L[i] += l; R[i] += r; } };
  const close = timeline.scenes.find((s) => s.id === "close");
  const tClose = close ? close.start : total;

  // Pads: each chord lasts two bars at 84 bpm; voices overlap as they cross-fade.
  const BEAT = 60 / 84, BAR = BEAT * 4, SEG = BAR * 2;
  const segs = [];
  for (let t = 0, i = 0; t < tClose; t += SEG, i++) segs.push({ t0: t, t1: Math.min(t + SEG, tClose), notes: CHORDS[i % CHORDS.length] });
  segs.push({ t0: tClose, t1: total + 2, notes: RESOLVE, last: true });
  for (const sg of segs) {
    const a = 1.6, r = sg.last ? 4.5 : 2.4;
    const i0 = Math.floor(Math.max(0, sg.t0 - 0.2) * RATE), i1 = Math.min(n, Math.floor((sg.t1 + r) * RATE));
    sg.notes.forEach((m, k) => {
      const f = hz(m);
      const gain = (m < 48 ? 0.05 : 0.028) * (sg.last ? 1.15 : 1);
      const pan = 0.5 + 0.35 * Math.sin(k * 1.7);
      const ph = [k * 0.7, k * 1.3, k * 2.1];
      for (let i = i0; i < i1; i++) {
        const t = i / RATE;
        let env = Math.min(1, (t - sg.t0 + 0.2) / a);
        if (t > sg.t1) env *= Math.max(0, 1 - (t - sg.t1) / r);
        if (sg.last) env *= Math.max(0, Math.min(1, (total - t) / 3.5));
        if (env <= 0) continue;
        const lfo = 1 + 0.18 * Math.sin(TAU * 0.11 * t + k);
        const v = (Math.sin(TAU * f * 0.997 * t + ph[0]) + Math.sin(TAU * f * 1.003 * t + ph[1]) + 0.35 * Math.sin(TAU * f * 2 * t + ph[2])) * gain * env * lfo;
        add(i, v * (1 - pan) * 1.4, v * pan * 1.4);
      }
    });
  }

  // The pulse: a soft low kick on each beat, a bass note on each bar, a
  // shaker on the off-beats; quieter around reveals.
  const reveals = sounds.filter((s) => ["reject", "approve", "swell", "chime"].includes(s.type)).map((s) => s.t);
  const pulseAt = (t) => {
    const sc = timeline.scenes.find((s) => t >= s.start && t < s.start + s.dur);
    if (!sc) return 0;
    let p = PULSE[sc.id] ?? 0;
    if (Array.isArray(p)) p = p[0] + (p[1] - p[0]) * ((t - sc.start) / sc.dur);
    const edge = Math.min(1, (t - sc.start) / 2, (sc.start + sc.dur - t) / 1.2);
    const near = reveals.reduce((m, r) => Math.min(m, Math.abs(t - r)), 99);
    return p * Math.max(0, edge) * Math.min(1, Math.max(0.15, (near - 0.4) / 1.6));
  };
  const rnd = rng(7);
  for (let b = 0, t = 0; t < total; b++, t = b * BEAT) {
    const p = pulseAt(t);
    if (p <= 0.01) continue;
    const i0 = Math.floor(t * RATE);
    for (let j = 0; j < 0.32 * RATE; j++) {
      const u = j / RATE;
      const f = 48 + 70 * Math.exp(-u / 0.03);
      const v = Math.sin(TAU * f * u) * Math.exp(-u / 0.11) * 0.16 * p;
      add(i0 + j, v, v);
    }
    if (b % 4 === 0) {
      const seg = segs.find((sg) => t >= sg.t0 && t < sg.t1) ?? segs[0];
      const f = hz(seg.notes[0] + 12);
      for (let j = 0; j < 1.4 * RATE; j++) { const u = j / RATE; const v = (Math.sin(TAU * f * u) + 0.3 * Math.sin(TAU * 2 * f * u)) * Math.exp(-u / 0.5) * 0.06 * p; add(i0 + j, v, v); }
    }
    const io = Math.floor((t + BEAT / 2) * RATE);
    let prev = 0;
    for (let j = 0; j < 0.05 * RATE; j++) { const w = rnd() * 2 - 1; const hp = w - prev; prev = w; const v = hp * Math.exp(-(j / RATE) / 0.012) * 0.018 * p; add(io + j, v * 0.7, v); }
  }

  // Sound events.
  for (const sd of sounds) {
    const g = sd.gain ?? 1, i0 = Math.floor(sd.t * RATE), r = rng(Math.floor(sd.t * 1000) + 1);
    if (sd.type === "tick") {
      const f = 1700 + r() * 1300, pan = 0.25 + r() * 0.5;
      for (let j = 0; j < 0.14 * RATE; j++) { const u = j / RATE; const v = Math.sin(TAU * f * u) * Math.exp(-u / 0.025) * 0.035 * g; add(i0 + j, v * (1 - pan) * 2, v * pan * 2); }
    } else if (sd.type === "whoosh") {
      let lp = 0;
      for (let j = 0; j < 0.9 * RATE; j++) { const u = j / 0.9 / RATE; const a = 0.02 + 0.25 * Math.sin(Math.PI * u); lp += a * ((r() * 2 - 1) - lp); const v = lp * Math.sin(Math.PI * u) * 0.09 * g; add(i0 - Math.floor(0.3 * RATE) + j, v * (1 - u * 0.6), v * (0.4 + u * 0.6)); }
    } else if (sd.type === "swell") {
      let lp = 0;
      const d = 2.6;
      for (let j = 0; j < (d + 0.8) * RATE; j++) {
        const u = j / RATE, k = Math.min(1, u / d), env = u < d ? k * k : Math.exp(-(u - d) / 0.25);
        lp += (0.01 + 0.2 * k) * ((r() * 2 - 1) - lp);
        const v = (lp * 0.08 + Math.sin(TAU * 55 * u) * 0.05) * env * g;
        add(i0 - Math.floor(d * RATE) + j, v, v);
      }
    } else if (sd.type === "chime") {
      for (const [f, a, dl] of [[880, 1, 0], [1318.5, 0.7, 0.06], [1760, 0.4, 0.12]]) {
        const s0 = i0 + Math.floor(dl * RATE);
        for (let j = 0; j < 2.2 * RATE; j++) { const u = j / RATE; const v = Math.sin(TAU * f * u) * Math.exp(-u / 0.6) * 0.03 * a * g; add(s0 + j, v * 0.8, v); }
      }
    } else if (sd.type === "approve") {
      for (const [f, dl] of [[523.25, 0], [783.99, 0.13]]) {
        const s0 = i0 + Math.floor(dl * RATE);
        for (let j = 0; j < 1.4 * RATE; j++) { const u = j / RATE; const v = (Math.sin(TAU * f * u) + 0.25 * Math.sin(TAU * 2 * f * u)) * Math.exp(-u / 0.45) * 0.05 * g; add(s0 + j, v, v * 0.85); }
      }
    } else if (sd.type === "reject") {
      for (let j = 0; j < 0.9 * RATE; j++) {
        const u = j / RATE, f = 60 + 50 * Math.exp(-u / 0.05);
        const v = (Math.sin(TAU * f * u) * 0.12 * Math.exp(-u / 0.25) + (Math.sin(TAU * 233 * u) + Math.sin(TAU * 247 * u)) * 0.02 * Math.exp(-u / 0.3)) * g;
        add(i0 + j, v, v);
      }
    }
  }
  // Soft clip, 16-bit stereo WAV.
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.tanh(L[i]) * 32000), i * 4);
    pcm.writeInt16LE(Math.round(Math.tanh(R[i]) * 32000), i * 4 + 2);
  }
  const hd = Buffer.alloc(44);
  hd.write("RIFF", 0); hd.writeUInt32LE(36 + pcm.length, 4); hd.write("WAVE", 8); hd.write("fmt ", 12);
  hd.writeUInt32LE(16, 16); hd.writeUInt16LE(1, 20); hd.writeUInt16LE(2, 22); hd.writeUInt32LE(RATE, 24);
  hd.writeUInt32LE(RATE * 4, 28); hd.writeUInt16LE(4, 32); hd.writeUInt16LE(16, 34); hd.write("data", 36); hd.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hd, pcm]);
}

export function writeScore(file, timeline, sounds) { writeFileSync(file, score(timeline, sounds)); }
