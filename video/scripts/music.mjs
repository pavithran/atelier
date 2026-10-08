// The film's score: a piano trio in the manner of Thelonious Monk,
// synthesised here sample by sample. The piano is additive: slightly
// inharmonic partials that decay at their own rates, two detuned strings
// per note, a felt-hammer thump at the attack and a damper that stops the
// note when the key lifts. It plays angular phrases with minor seconds and
// clusters, accents displaced off the beat, whole-tone runs, stride bars,
// and rests between phrases. An upright bass walks quarter notes; brushes
// sweep the snare under a light ride. Medium swing (the off-beat at 0.64
// of a beat), humanised timing and velocity, a small room reverb. The
// arrangement follows the timeline's scenes, thins out around the reveals
// and resolves at the close. The scenes' sound events are played by the
// same piano, in key. Nothing is downloaded.
import { writeFileSync } from "node:fs";

const RATE = 48000;
const TAU = Math.PI * 2;
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const BPM = 132, BEAT = 60 / BPM, BAR = BEAT * 4, SWING = 0.64;

// A blues-flavoured cycle in B flat. Each chord: root (bass), a Monk-style
// voicing with a minor second rubbed into it, and the notes the tune uses.
const PROG = [
  { root: 34, voice: [56, 57, 62], tune: [70, 73, 74, 77, 80, 82] },   // Bb7 (Ab–A rub)
  { root: 39, voice: [55, 56, 61], tune: [70, 73, 75, 77, 79, 82] },   // Eb7 (G–Ab, Db)
  { root: 34, voice: [56, 62, 63], tune: [70, 72, 74, 77, 80] },       // Bb7 (D–Eb)
  { root: 41, voice: [57, 63, 64], tune: [69, 72, 75, 77, 81] },       // F7 (Eb–E)
  { root: 36, voice: [58, 63, 64], tune: [70, 72, 75, 76, 79] },       // C7 (Bb, Eb–E)
  { root: 41, voice: [57, 63, 64], tune: [69, 72, 75, 77, 80] },       // F7
  { root: 34, voice: [56, 57, 62], tune: [70, 73, 74, 77, 82] },       // Bb7
  { root: 41, voice: [55, 57, 63], tune: [69, 72, 75, 77, 79] },       // F7 turnaround
];
const TONIC = { root: 34, voice: [50, 56, 57, 62, 67], tune: [70, 74, 77, 82] };

// How much of each instrument a scene carries: piano, bass, drums, tune.
const MIX = {
  cold: [0.8, 0.0, 0.0, 0.6], contents: [1, 1, 0.8, 1], why: [1, 1, 0.8, 0.5], cast: [1, 1, 0.9, 0.7],
  gate: [0.9, 1, 0.7, 0.3], plan: [1, 1, 0.9, 0.8], metrics: [1, 1, 0.8, 0.5], cloud: [1, 1, 0.8, 0.6], close: [1, 1, 0.8, 1],
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
  // A piano note: partials n·f·sqrt(1+B·n²), each decaying faster the
  // higher it is, two strings a few cents apart, a hammer thump, a damper.
  function piano(t0, m, vel, dur, pan = 0.5) {
    const f0 = hz(m), i0 = Math.floor(t0 * RATE);
    const B = 0.00012 * Math.pow(1.04, m - 40);
    const dec = 3.2 * Math.pow(0.965, m - 48) * (0.8 + 0.4 * vel);
    const len = Math.floor((Math.min(dur, dec * 2.2) + 0.25) * RATE);
    const parts = [];
    const bright = 0.35 + 0.65 * vel;
    for (let k = 1; k <= 10; k++) {
      const fk = f0 * k * Math.sqrt(1 + B * k * k);
      if (fk > 9000) break;
      const amp = Math.pow(k, -1.15) * (k === 1 ? 1 : bright) * (k % 7 === 0 ? 0.3 : 1);
      for (const det of [-0.0011, 0.0011]) {
        const w = TAU * fk * (1 + det) / RATE;
        parts.push({ c: Math.cos(w), s: Math.sin(w), re: Math.sin(k + det * 900), im: Math.cos(k + det * 900), a: amp * 0.5, d: Math.exp(-1 / (RATE * dec / Math.pow(k, 0.55))), e: 1 });
      }
    }
    const g = 0.055 * Math.pow(vel, 1.4) * Math.pow(0.985, m - 60);
    let lp = 0;
    for (let j = 0; j < len; j++) {
      const u = j / RATE;
      let x = 0;
      for (const p of parts) {
        const re = p.re * p.c - p.im * p.s; p.im = p.re * p.s + p.im * p.c; p.re = re;
        p.e *= p.d; x += p.re * p.a * p.e;
      }
      const att = Math.min(1, u / 0.0025);
      const damper = u > dur ? Math.exp(-(u - dur) / 0.07) : 1;
      lp += 0.3 * ((rnd() * 2 - 1) - lp);
      const thump = u < 0.02 ? lp * 0.5 * vel * (1 - u / 0.02) : 0;
      const v = (x * att + thump) * g * damper;
      put(i0 + j, v * (1 - pan) * 1.6, v * pan * 1.6, 0.3);
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
      const v = ((lp + thump) - hpx) * env * 0.085 * vel;
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
  // ── the band ─────────────────────────────────────────────────────────────
  const bars = Math.ceil(tEnd / BAR);
  // Comping figures, as [beat, velocity]: displaced, with the accent off the beat.
  const COMP = [[[0.5, 0.9], [2.5, 1.0]], [[1.5, 1.0]], [[0, 0.7], [1.5, 1.0], [3.5, 0.8]], [[2.5, 1.0], [3, 0.6]], [[0.5, 1.0], [3.5, 0.9]]];
  const WHOLE = [0, 2, 4, 6, 8, 10, 12, 14];
  for (let b = 0; b < bars; b++) {
    const t0 = b * BAR;
    const ch = chordAt(t0), next = chordAt(t0 + BAR);
    const lv = (t) => [0, 1, 2, 3].map((k) => level(t, k));
    const [pl] = lv(t0);
    const sc0 = sceneAt(t0);
    if (pl > 0.02) {
      const stride = sc0.id !== "cold" && b % 8 === 6;
      if (stride) {
        // Stride: a low note on one and three, the voicing on two and four.
        for (let k = 0; k < 4; k++) {
          const at = t0 + k * BEAT + (rnd() - 0.5) * 0.012;
          if (k % 2 === 0) { piano(at, ch.root + 12, 0.8 * pl, BEAT * 0.8, 0.35); piano(at, ch.root + 24, 0.6 * pl, BEAT * 0.8, 0.35); }
          else ch.voice.forEach((m, i) => piano(at + i * 0.004, m, 0.7 * pl * thin(at), BEAT * 0.6, 0.45 + i * 0.05));
        }
      } else {
        const pattern = sc0.id === "cold" ? [[0, 0.6]] : COMP[Math.floor(rnd() * COMP.length)];
        for (const [beat, v0] of pattern) {
          const at = t0 + swung(beat) * BEAT + (rnd() - 0.5) * 0.02;
          const vel = v0 * (0.75 + rnd() * 0.3) * pl * thin(at);
          const dur = sc0.id === "cold" ? BAR * 0.9 : BEAT * (beat % 1 ? 0.45 : 0.9);
          ch.voice.forEach((m, k) => piano(at + k * 0.005, m, vel, dur, 0.4 + k * 0.06));
        }
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
    // The tune, Monk's way: a short angular phrase every other two bars,
    // leaps and minor-second grace notes, an accent pushed off the beat,
    // sometimes a whole-tone run down, and rests between phrases.
    const [, , , tl] = lv(t0);
    if (tl > 0.02 && b % 4 === 0) {
      const sc = sceneAt(t0);
      const kind = rnd();
      if (kind < 0.25) {
        // A whole-tone run down from the top of the chord.
        const top = ch.tune[ch.tune.length - 1] + 2;
        for (let k = 0; k < 7; k++) {
          const at = t0 + BEAT * 1.5 + k * BEAT / 3 + (rnd() - 0.5) * 0.008;
          piano(at, top - WHOLE[k], (0.55 + 0.25 * (k === 0)) * tl * thin(at), BEAT * 0.3, 0.6);
        }
        const land = t0 + BEAT * 4.5;
        piano(land, ch.tune[0], 0.85 * tl * thin(land), BEAT * 1.4, 0.6);
      } else {
        const steps = [[0.5, 0], [1.5, 3], [2, 2], [3.5, 5], [5, 1], [5.5, 4]].filter(() => rnd() < 0.8);
        for (const [beat, step] of steps) {
          const at = t0 + swung(beat) * BEAT + (rnd() - 0.5) * 0.015;
          const c2 = chordAt(at);
          const m = c2.tune[Math.min(c2.tune.length - 1, step)];
          const vel = (0.65 + rnd() * 0.3) * tl * thin(at) * (beat % 1 ? 1.1 : 0.85);
          if (rnd() < 0.35) piano(at - 0.045, m - 1, vel * 0.6, 0.05, 0.62);   // a crushed minor second
          piano(at, m, vel, BEAT * (beat % 1 ? 0.5 : 0.9), 0.62);
          if (rnd() < 0.2) piano(at, m - 1, vel * 0.7, BEAT * 0.5, 0.6);        // a cluster
        }
      }
    }
  }
  // The close resolves: the tonic voicing, held, a last high cluster, and a cymbal swell into it.
  if (close) {
    const tz = close.start + close.dur - 6;
    TONIC.voice.forEach((m, k) => piano(tz + k * 0.03, m, 0.8, 5, 0.35 + k * 0.08));
    bass(tz, 34, 1, 3.5);
    piano(tz + 0.6, 82, 0.6, 3, 0.65); piano(tz + 0.6, 81, 0.45, 3, 0.65);
    for (let k = 0; k < 24; k++) ride(tz - 1.2 + k * 0.05, 0.12 + k * 0.03);
  }

  // ── the scenes' sound events, played in key ───────────────────────────────
  for (const sd of sounds) {
    const g = sd.gain ?? 1, ch = chordAt(sd.t);
    if (sd.type === "tick") piano(sd.t, ch.tune[Math.floor(rnd() * ch.tune.length)] + 12, 0.25 * g, 0.12, 0.3 + rnd() * 0.4);
    else if (sd.type === "whoosh") swish(sd.t - 0.35, 0.7, 2.2 * g);
    else if (sd.type === "swell") for (let k = 0; k < 30; k++) ride(sd.t - 1.5 + k * 0.05, (0.05 + k * 0.025) * g);
    else if (sd.type === "chime") ch.tune.slice(0, 3).forEach((m, k) => piano(sd.t + k * 0.08, m + 12, 0.45 * g, 0.4, 0.4 + k * 0.1));
    else if (sd.type === "approve") { piano(sd.t, ch.tune[2] + 12, 0.6 * g, 0.4); piano(sd.t + 0.12, ch.tune[0] + 24, 0.6 * g, 0.8); }
    else if (sd.type === "reject") { bass(sd.t, 35, 0.9 * g, 0.5); piano(sd.t, 47, 0.7 * g, 0.4, 0.4); piano(sd.t, 48, 0.7 * g, 0.4, 0.45); }
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
