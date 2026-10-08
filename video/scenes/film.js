// The film's scenes, seventh cut, in a dark or a bright theme. Each scene is a pure function of time:
// build() makes its elements once, and update(t) sets every property from
// the scene's local time t in seconds. build.mjs drives the clock with
// film.seek(T) and takes one screenshot per frame, so frames are the same on
// every run. Narration beats come from the timeline: c.cue(i) is when cue i
// starts, c.when("words") when the caption holding those words starts.
// Scenes also register sound events (c.sfx), which build.mjs renders into
// the score with scripts/music.mjs, so picture and sound share one clock.

(() => {
  // ── helpers ─────────────────────────────────────────────────────────────
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const P = (t, a, d = 0.6) => ease(clamp((t - a) / d));
  const lerp = (a, b, k) => a + (b - a) * k;
  const SVGNS = "http://www.w3.org/2000/svg";
  const hash = (str, salt = 0) => { let x = 2166136261 ^ salt; for (const ch of String(str)) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return ((x >>> 0) % 100000) / 100000; };

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function s(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "text") el.textContent = v; else el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const quoteHtml = (x) => esc(x).replace(/`([^`]+)`/g, "<code>$1</code>");
  function fadeIn(el, k, dy = 22) { el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * dy}px)`; }
  function pop(el, k, from = 0.8) { el.style.opacity = k; el.style.transform = `scale(${lerp(from, 1, easeOut(k))})`; }
  function pos(el, x, y, w) { el.style.left = x + "px"; el.style.top = y + "px"; if (w) el.style.width = w + "px"; return el; }
  const region = (x, y, w = 1920, hh = 1080) => h("div", { class: "abs", style: { left: x + "px", top: y + "px", width: w + "px", height: hh + "px" } });
  const svgFull = (w = 1920, hh = 1080) => s("svg", { width: w, height: hh, class: "abs", style: "left:0;top:0;overflow:visible" });
  const len = (p) => p.__len ?? (p.__len = p.getTotalLength());
  function draw(p, k) { const L = len(p); p.style.strokeDasharray = L; p.style.strokeDashoffset = L * (1 - clamp(k)); }

  // The family patterns of src/models/pool.ts.
  const FAMILIES = [
    ["anthropic", /^(claude|opus|sonnet|haiku|fable)\b|anthropic/i],
    ["openai", /^(gpt|o\d|codex|chatgpt)\b|^gpt-|openai/i],
    ["zai", /^glm|zhipu|z-?ai/i],
    ["google", /^(gemini|gemma)|google/i],
    ["deepseek", /deepseek/i],
    ["xiaomi", /^mimo\b|xiaomi/i],
    ["qwen", /^qwen|qwq/i],
    ["minimax", /minimax/i],
    ["moonshot", /kimi|moonshot/i],
  ];
  const fam = (a) => { const n = a.split("/").pop(); return (FAMILIES.find(([, re]) => re.test(n) || re.test(a)) ?? ["other"])[0]; };
  const col = (f) => `var(--m-${f})`;
  // Family colours for SVG strokes: the Night theme's, or the light theme's,
  // tuned for contrast on white; init() picks one.
  const HEX_DARK = { anthropic: "#ff8a5b", openai: "#3fe0b0", zai: "#6f9bff", google: "#ff8fcf", deepseek: "#5ad1e6", xiaomi: "#ff9e40", qwen: "#b5e55c", moonshot: "#b48cff", minimax: "#ff9f7a", other: "#8f9cab" };
  const HEX_LIGHT = { anthropic: "#b4461c", openai: "#0b7a5c", zai: "#2f56c9", google: "#b0307a", deepseek: "#0f7d93", xiaomi: "#a35a00", qwen: "#4d7a12", moonshot: "#5f3fa8", minimax: "#b04a1f", other: "#4b5562" };
  let HEX = HEX_DARK;
  const FAMILY_NAME = { anthropic: "Anthropic · Claude", zai: "Zhipu · GLM", openai: "OpenAI · GPT", deepseek: "DeepSeek", google: "Google · Gemini", xiaomi: "Xiaomi · MiMo", qwen: "Alibaba · Qwen" };
  const NAMES = {
    "opus-5.5": "Opus 5.5", "sonnet-5.5": "Sonnet 5.5", "fable-5.1": "Fable 5.1", "glm-5.3": "GLM-5.3", "GLM-5.3-Flash-4_8bit": "GLM-5.3 Flash, local",
    "glm-5.3-flash": "GLM-5.3 Flash, local", "gpt-6-astra": "gpt-6-astra", "gpt-6.1-sol": "gpt-6.1-sol", "gpt-6": "gpt-6", "gpt-5.5": "gpt-5.5",
    "gemini-3.1-pro": "Gemini 3.1 Pro", "gemini-3.1-pro-preview": "Gemini 3.1 Pro preview", "deepseek-v4-pro": "DeepSeek V4 Pro",
    "xiaomi-mimo-v2.6-pro": "MiMo v2.6 Pro", "gpt-oss-120b": "GPT-OSS 120B", "qwen3.8-27b": "Qwen3.8 27B", "kimi-k2.7-code": "Kimi K2.7 Code", "DeepSeek-V4-Flash-0731-MXFP4-MLX": "DeepSeek V4 Flash, local", "qwen3-coder-next": "Qwen3 Coder Next",
  };
  const nice = (a) => NAMES[a.split("/").pop()] ?? a.split("/").pop();
  const chip = (actor, extra = "") => h("span", { class: "chip", style: { color: col(fam(actor)) } }, h("span", { class: "dot" }), nice(actor) + extra);
  const famChip = (f, label) => h("span", { class: "chip", style: { color: col(f) } }, h("span", { class: "dot" }), label);
  const utc = (iso, secs = false) => iso.slice(11, secs ? 19 : 16) + " UTC";
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const day = (iso) => `${Number(iso.slice(8, 10))} ${MONTH[Number(iso.slice(5, 7)) - 1]}`;
  const dur = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;

  // A camera over a world larger than the frame: keys [t, cx, cy, scale]
  // name the point at the frame's centre; a slow drift keeps it alive.
  function camera(world, W, H) {
    Object.assign(world.style, { position: "absolute", left: 0, top: 0, width: W + "px", height: H + "px", transformOrigin: "0 0" });
    return {
      set(t, keys, drift = 1) {
        let [, cx, cy, sc] = keys[0];
        for (let i = 1; i < keys.length; i++) {
          const [ta, xa, ya, sa] = keys[i - 1], [tb, xb, yb, sb] = keys[i];
          if (t >= ta) { const q = ease(clamp((t - ta) / Math.max(0.001, tb - ta))); cx = lerp(xa, xb, q); cy = lerp(ya, yb, q); sc = lerp(sa, sb, q); }
        }
        const dx = drift * 14 * Math.sin(t * 0.23), dy = drift * 9 * Math.sin(t * 0.19 + 1.3), S = sc * (1 + drift * 0.012 * Math.sin(t * 0.15 + 0.4));
        world.style.transform = `translate(${960 - (cx + dx) * S}px, ${540 - (cy + dy) * S}px) scale(${S})`;
        return { cx: cx + dx, cy: cy + dy, s: S };
      },
    };
  }
  // A move from one point to the next over d seconds, with a slight pull back mid-flight.
  function flight(stops, d = 1.3, dip = 0.86) {
    const keys = [[0, ...stops[0].slice(1)]];
    for (let i = 1; i < stops.length; i++) {
      const [t, x, y, sc] = stops[i], [, px, py, ps] = keys[keys.length - 1];
      keys.push([t, px, py, ps]);
      keys.push([t + d / 2, (px + x) / 2, (py + y) / 2, Math.min(ps, sc) * dip]);
      keys.push([t + d, x, y, sc]);
    }
    return keys;
  }

  // Light travelling along a path: n glowing beads.
  function beads(svg, d, color, n = 3, r = 6) {
    const p = s("path", { d, fill: "none", stroke: "none" });
    svg.append(p);
    const dots = Array.from({ length: n }, () => { const c = s("circle", { r, fill: color }); c.style.filter = `drop-shadow(0 0 7px ${color})`; svg.append(c); return c; });
    return {
      update(t, t0, period = 2.2, on = 1) {
        const L = len(p);
        dots.forEach((c, i) => {
          if (t < t0 || on <= 0) { c.style.opacity = 0; return; }
          const ph = (((t - t0) / period + i / n) % 1 + 1) % 1;
          const pt = p.getPointAtLength(L * ph);
          c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y);
          c.style.opacity = on * Math.sin(Math.PI * ph);
        });
      },
    };
  }
  // Words that arrive one after another.
  function kinetic(text, cls = "kin display", style = {}) {
    const el = h("div", { class: cls, style });
    const words = text.split(" ").map((w) => { const sp = h("span", { text: w }); el.append(sp, " "); return sp; });
    return {
      el,
      update(k) {
        words.forEach((w, i) => {
          const e = ease(clamp(k * (words.length + 2) - i));
          w.style.opacity = e; w.style.transform = `translateY(${(1 - e) * 30}px)`; w.style.filter = `blur(${(1 - e) * 6}px)`;
        });
      },
    };
  }
  const count = (el, n, k, fmt = (x) => x) => { el.textContent = fmt(Math.round(n * easeOut(clamp(k)))); };

  // A real page in a browser window, panned by keys [t, y, scale, x] in the
  // captured image's pixels (1920 wide).
  function browser(name, url, note) {
    const img = h("img", { src: `../.cache/screens/${name}.png` });
    const el = h("div", { class: "browser" },
      h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("div", { class: "url", html: url }), note ? h("div", { class: "note", text: note }) : null),
      h("div", { class: "view" }, img));
    const k = 1600 / 1920;
    return {
      el, img,
      pan(t, keys) {
        let y = keys[0][1], sc = keys[0][2] ?? 1, x = keys[0][3] ?? 0;
        for (let i = 1; i < keys.length; i++) {
          const [ta, ya, sa = 1, xa = 0] = keys[i - 1], [tb, yb, sb = 1, xb = 0] = keys[i];
          if (t >= ta) { const q = ease(clamp((t - ta) / Math.max(0.001, tb - ta))); y = lerp(ya, yb, q); sc = lerp(sa, sb, q); x = lerp(xa, xb, q); }
        }
        img.style.transform = `translate(${-x * k * sc}px, ${-y * k * sc}px) scale(${sc})`;
      },
      show(t, a, b = 1e9) {
        el.style.display = t >= a && t < b + 0.5 ? "block" : "none";
        const k2 = P(t, a, 0.7) * (1 - P(t, b, 0.5));
        el.style.opacity = k2;
        el.style.transform = `translateY(${(1 - P(t, a, 0.9)) * 60}px) scale(${lerp(0.94, 1, P(t, a, 0.9)) * (1 + 0.02 * clamp((t - a) / 12))})`;
      },
    };
  }
  // A flash of colour around an element: a ring that grows and fades.
  function pulseRing(parent, x, y, color) {
    const ring = pos(h("div", { class: "abs ring", style: { borderColor: color, boxShadow: `0 0 40px ${color}` } }), x, y);
    parent.append(ring);
    return { update(t, t0) { const k = clamp((t - t0) / 1.1); ring.style.opacity = t < t0 ? 0 : (1 - k) * 0.9; ring.style.transform = `translate(-50%,-50%) scale(${0.3 + k * 2.2})`; } };
  }

  // ── the field of light: every task of the ledger ────────────────────────
  function field(data) {
    const W = 5200, H = 2400, MAINY = 1250;
    const T0 = Date.parse(data.facts.firstTaskAt) - 3600e3, T1 = Date.parse(data.facts.cutoff);
    const X = (ms) => 220 + (ms - T0) / (T1 - T0) * 4760;
    const world = h("div", {});
    const svg = svgFull(W, H);
    world.append(svg);
    const glow = s("defs", {}, s("filter", { id: "starglow", x: "-200%", y: "-200%", width: "500%", height: "500%" }, s("feGaussianBlur", { stdDeviation: "5", result: "b" }), s("feMerge", {}, s("feMergeNode", { in: "b" }), s("feMergeNode", { in: "SourceGraphic" }))));
    svg.append(glow);
    const main = s("line", { x1: 0, y1: MAINY, x2: W, y2: MAINY, stroke: "var(--main-line)", "stroke-width": 3, opacity: 0.85 });
    svg.append(main);
    const gForks = s("g", {}), gArcs = s("g", {}), gStars = s("g", { filter: "url(#starglow)" });
    svg.append(gArcs, gForks, gStars);
    const items = data.tasks.map((tk) => {
      const created = Date.parse(tk.createdAt);
      const end = tk.mergedAt ? Date.parse(tk.mergedAt) : tk.abandonedAt ? Date.parse(tk.abandonedAt) : T1;
      const f = tk.builderFamilies[0] ?? "other";
      const xc = X(created), xe = Math.max(X(end), xc + 90), y = MAINY - 150 - hash(tk.id) * 900;
      const color = HEX[f] ?? HEX.other;
      const d = tk.mergedAt
        ? `M ${xc} ${MAINY} C ${xc} ${(MAINY + y) / 2}, ${xc + 20} ${y}, ${xc + 60} ${y} L ${xe - 60} ${y} C ${xe - 20} ${y}, ${xe} ${(MAINY + y) / 2}, ${xe} ${MAINY}`
        : `M ${xc} ${MAINY} C ${xc} ${(MAINY + y) / 2}, ${xc + 20} ${y}, ${xc + 60} ${y} L ${xe} ${y}`;
      const fork = s("path", { d, fill: "none", stroke: color, "stroke-width": tk.mergedAt ? 2.4 : 1.6, opacity: tk.mergedAt ? 0.6 : 0.3 });
      gForks.append(fork);
      const star = s("circle", { cx: xc + 60, cy: y, r: tk.mergedAt ? 7 : 5, fill: color });
      gStars.append(star);
      const arcs = tk.reviews.filter((r) => r.approve && r.cross).slice(0, 1).map((r) => {
        const xr = X(Date.parse(r.at)), yr = MAINY + (MAINY - y) * 0.55 + 40;
        const rc = HEX[r.family] ?? HEX.other;
        const a = s("path", { d: `M ${xc + 60} ${y} C ${xc + 60} ${MAINY + 80}, ${xr} ${MAINY - 80}, ${xr} ${yr}`, fill: "none", stroke: rc, "stroke-width": 1.8, opacity: 0.42 });
        const st = s("circle", { cx: xr, cy: yr, r: 4.5, fill: rc });
        gArcs.append(a); gStars.append(st);
        return { a, st, at: Date.parse(r.at) };
      });
      return { created, end, fork, star, arcs, merged: !!tk.mergedAt };
    });
    return {
      world, W, H, MAINY, T0, T1, X, items,
      // Draws the record as it stood at the instant `now`.
      at(now, dim = 1) {
        for (const it of items) {
          const k = now < it.created ? 0 : clamp((now - it.created) / Math.max(1, it.end - it.created));
          draw(it.fork, k);
          it.fork.style.opacity = now < it.created ? 0 : dim * (it.merged ? 0.6 : 0.3);
          const age = (now - it.created) / 3600e3;
          it.star.style.opacity = now < it.created ? 0 : dim * clamp(0.55 + 0.45 * Math.exp(-age / 3) + (it.merged && now >= it.end ? 0.3 : 0));
          for (const a of it.arcs) { const ka = clamp((now - a.at) / (3 * 3600e3)); draw(a.a, ka); a.a.style.opacity = now < a.at ? 0 : 0.45 * dim; a.st.style.opacity = now < a.at ? 0 : dim; }
        }
      },
    };
  }

  // ── scenes ──────────────────────────────────────────────────────────────
  // The frame, top to bottom: the chapter bar (0–72), the badge and the
  // source tag (84–120), the key words of the moment (132–244), the content
  // (262–896), and the captions below. Body text is at least 44 px; the
  // footnotes, at least 30 px.
  const SCENES = {};
  const COMPANY = { anthropic: "Anthropic", zai: "Zhipu", openai: "OpenAI", google: "Google", deepseek: "DeepSeek", qwen: "Alibaba", moonshot: "Moonshot", xiaomi: "Xiaomi", other: "other" };
  const LEDGER_SPAN = (data) => `${day(data.facts.firstTaskAt)} to ${day(data.facts.cutoff)} 2026`;
  const ASOF = (data) => `${day(data.facts.cutoff)} 2026, ${utc(data.facts.cutoff)}`;
  const TOP = 262, BODY = 44, FOOT = 30;
  const layer = () => h("div", { class: "abs", style: { inset: 0 } });

  // Slides that replace one another in place: each shows over its windows
  // [a, b) with a short cross-fade, so no frame is caught between pictures.
  function slides(list) {
    const els = [...new Set(list.map((x) => x.el))];
    return (t) => els.forEach((el) => {
      let k = 0, rise = 1;
      for (const { a, b } of list.filter((x) => x.el === el)) {
        const kk = P(t, a - 0.1, 0.4) * (1 - P(t, b - 0.3, 0.35));
        if (kk > k) { k = kk; rise = P(t, a - 0.1, 0.5); }
      }
      el.style.display = k > 0.001 ? "block" : "none";
      el.style.opacity = k;
      el.style.transform = `translateY(${(1 - rise) * 18}px)`;
    });
  }

  // The key words of the moment: each lands, word by word, as it is spoken,
  // and replaces the one before. Entries are [time, text, colour].
  function keywords(list) {
    const el = pos(h("div", { class: "abs", style: { width: "1700px", height: "120px" } }), 110, 128);
    const items = list.map(([at, text, color]) => {
      const k = kinetic(text, "kin display kw", { position: "absolute", left: 0, top: 0, fontSize: "92px", lineHeight: "1.1", color: color ?? "var(--text-bright)", whiteSpace: "nowrap" });
      el.append(k.el);
      return { at, k };
    });
    return {
      el,
      update(t) {
        items.forEach((it, i) => {
          const next = items[i + 1]?.at ?? 1e9;
          const on = t >= it.at - 0.15 && t < next - 0.05;
          it.k.el.style.display = on ? "block" : "none";
          if (on) it.k.update(clamp((t - it.at + 0.15) / 0.55));
        });
      },
    };
  }

  // A big number with one plain line of what it means.
  function bigNumber(num, label, meaning, color) {
    const n = h("div", { class: "big-num", text: "0", style: { fontSize: "300px", lineHeight: "0.9", color } });
    const el = pos(h("div", { class: "abs", style: { width: "1680px" } }, n,
      h("div", { class: "display", text: label, style: { fontSize: "60px", marginTop: "18px", color: "var(--text-bright)" } }),
      h("div", { text: meaning, style: { font: `500 ${BODY}px/1.3 var(--font-sans)`, marginTop: "18px", color: "var(--text-muted)" } })), 120, TOP + 10);
    return { el, update(t, a) { if (typeof num === "number") count(n, num, (t - a) / 0.9); else { n.textContent = num; n.style.opacity = P(t, a, 0.4); } } };
  }

  // Rows of ledger events: a time, what happened in large type, and a
  // detail or a quote as a footnote.
  function rows(list, x = 120, y = TOP, w = 1680, gap = 26) {
    const el = pos(h("div", { class: "abs", style: { width: w + "px", display: "flex", flexDirection: "column", gap: gap + "px" } }), x, y);
    const els = list.map((r) => {
      const row = h("div", { style: { display: "flex", gap: "28px", alignItems: "baseline" } },
        h("div", { class: "mono", style: { width: "200px", flex: "none", fontSize: FOOT + "px", color: "var(--text-muted)" }, html: r.time ?? "" }),
        h("div", { style: { flex: 1 } },
          h("div", { style: { font: `600 ${BODY}px/1.25 var(--font-sans)`, color: r.color ?? "var(--text-bright)" }, html: r.what }),
          r.detail ? h("div", { class: r.quote ? "quote" : "", style: { marginTop: "10px", font: `400 ${FOOT}px/1.4 ${r.mono ? "var(--font-mono)" : "var(--font-sans)"}`, color: "var(--text)", borderLeftColor: r.qcolor ?? "var(--fault)" }, html: r.detail }) : null));
      el.append(row);
      return row;
    });
    return { el, els };
  }
  const foot = (html, x, y, w = 1680, extra = {}) => pos(h("div", { class: "abs", style: { width: w + "px", font: `500 ${FOOT}px/1.4 var(--font-sans)`, color: "var(--text-muted)", ...extra }, html }), x, y);
  const card = (title, sub, x, y, w, hh) => pos(h("div", { class: "card", style: { padding: "22px 26px", width: w + "px", ...(hh ? { height: hh + "px" } : {}) } },
    h("div", { style: { font: `700 ${BODY}px/1.2 var(--font-sans)`, color: "var(--text-bright)" }, text: title }),
    sub ? h("div", { style: { font: `400 ${FOOT}px/1.4 var(--font-sans)`, color: "var(--text-muted)", marginTop: "10px" }, html: sub }) : null), x, y);
  const bigChip = (actor, extra = "") => h("span", { class: "chip big", style: { color: col(fam(actor)) } }, h("span", { class: "dot" }), nice(actor) + extra);
  const named = (actor) => `<b style="color:${col(fam(actor))}">${esc(nice(actor))}</b>`;

  // A real page cropped to one panel, in a browser frame, pushed in slowly.
  function footage(name, url, note, w, hgt, top = 250) {
    const img = h("img", { src: `../.cache/footage/${name}.png`, style: { width: w + "px", display: "block", transformOrigin: "50% 40%" } });
    const el = h("div", { class: "browser", style: { left: (1920 - w) / 2 + "px", top: top + "px", width: w + "px", height: hgt + 52 + "px" } },
      h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("div", { class: "url", html: url }), note ? h("div", { class: "note", text: note }) : null),
      h("div", { class: "view" }, img));
    return { el, push(t, a, b) { img.style.transform = `scale(${lerp(1, 1.035, clamp((t - a) / Math.max(1, b - a)))})`; } };
  }
  // A terminal: the command typed, then its output line by line.
  function terminal(title, cmd, out, x, y, w, maxLines, cols) {
    const lines = out.replace(/\s+$/, "").split("\n").slice(0, maxLines).map((l) => (l.length > cols ? l.slice(0, cols - 1) + "…" : l));
    const pre = h("pre");
    const el = pos(h("div", { class: "term", style: { width: w + "px" } }, h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("span", { text: title, style: { marginLeft: "12px" } })), pre), x, y);
    return {
      el,
      update(t, a) {
        const typed = Math.floor(clamp((t - a) / 1.0) * cmd.length);
        const shown = t < a + 1.2 ? 0 : Math.min(lines.length, Math.floor((t - a - 1.2) / 0.06) + 1);
        pre.innerHTML = `<span class="prompt">$</span> ${esc(cmd.slice(0, typed))}${typed < cmd.length ? '<span class="cursor"></span>' : ""}\n` + lines.slice(0, shown).map(esc).join("\n");
      },
    };
  }
  const dt = (iso) => `${day(iso).replace(" October", " Oct")}<br>${utc(iso, true).replace(" UTC", "")}`;
  const tm = (iso) => utc(iso, true).replace(" UTC", "");

  SCENES.cold = (c, data) => {
    const el = h("div");
    const F = field(data);
    const cam = camera(F.world, F.W, F.H);
    el.append(F.world);
    const SWEEP_A = 0.3, SWEEP_B = c.cueEnd(0);
    const play = (t) => lerp(F.T0, F.T1, ease(clamp((t - SWEEP_A) / (SWEEP_B - SWEEP_A))) * 0.35 + clamp((t - SWEEP_A) / (SWEEP_B - SWEEP_A)) * 0.65);
    let last = -1;
    const times = data.tasks.map((tk) => Date.parse(tk.createdAt)).sort((a, b) => a - b);
    for (let tt = SWEEP_A; tt <= SWEEP_B; tt += 1 / 30) {
      const now = play(tt), prev = play(tt - 1 / 30);
      const n = times.filter((x) => x > prev && x <= now).length;
      if (n && tt - last > 0.07) { c.sfx(tt, "tick", Math.min(1, 0.4 + n * 0.15)); last = tt; }
    }
    const hud = layer();
    const date = pos(h("div", { class: "abs mono", style: { fontSize: "34px", color: "var(--signal)" } }), 110, 140);
    const legend = pos(h("div", { class: "card", style: { padding: "20px 26px", width: "760px", background: "var(--veil)" } },
      h("div", { style: { font: `500 ${FOOT}px/1.4 var(--font-sans)`, color: "var(--text)" }, text: "Each line is a task, from filed to merged, coloured by the company whose model built it. A dot below the line is an approval by another company." }),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px 14px", marginTop: "16px" } }, ...["anthropic", "zai", "openai", "deepseek", "google"].map((f) => h("span", { class: "chip big", style: { color: col(f) } }, h("span", { class: "dot" }), COMPANY[f])))), 110, 200);
    const counter = pos(h("div", { class: "abs" }, h("div", { class: "big-num n", text: "0", style: { fontSize: "140px" } }), h("div", { text: "tasks, from Atelier's own ledger", style: { font: `600 ${BODY}px/1.2 var(--font-sans)`, color: "var(--text-bright)" } })), 110, 640);
    hud.append(date, legend, counter);
    // The title, the motif and the three things to remember.
    const title = pos(h("div", { class: "abs display", text: "Atelier", style: { fontSize: "180px", width: "1920px", textAlign: "center" } }), 0, 110);
    const motif = pos(h("div", { class: "abs display", text: "Git keeps the code. Atelier keeps the record.", style: { fontSize: "62px", width: "1920px", textAlign: "center", color: "var(--signal)" } }), 0, 330);
    const three = THREE.map((x, i) => pos(h("div", { class: "abs", style: { display: "flex", gap: "28px", alignItems: "baseline", width: "1500px" } }, h("span", { class: "display", text: String(i + 1), style: { fontSize: "64px", color: "var(--signal)", width: "50px" } }), h("span", { class: "display", text: x, style: { fontSize: "60px" } })), 300, 540 + i * 100));
    const head3 = pos(h("div", { class: "abs", text: "Three things to remember", style: { font: `600 ${FOOT + 4}px/1 var(--font-mono)`, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-muted)" } }), 300, 480);
    hud.append(title, motif, head3, ...three);
    el.append(hud);
    const tTitle = SWEEP_B + 0.2, tThree = c.cue(1);
    const at3 = [c.when("checks Atelier observed"), c.when("approval by another"), c.when("and a record")];
    c.sfx(tTitle, "chime", 1); at3.forEach((x) => c.sfx(x, "tick", 0.8));
    return {
      el,
      update(t) {
        const now = play(t);
        F.at(now, 1 - 0.88 * P(t, tTitle - 0.3, 1.0));
        const k = P(t, 0.8, SWEEP_B - 0.8);
        const cx = lerp(F.X(play(Math.min(t, SWEEP_B))) - 300, F.W / 2, P(t, 1.5, SWEEP_B - 1.2)), cy = lerp(F.MAINY - 420, F.MAINY - 80, k);
        const view = cam.set(t, [[0, cx, cy, lerp(1.2, 0.36, k)]], 0.5);
        date.textContent = new Date(now).toISOString().slice(0, 16).replace("T", "  ") + " UTC";
        const out = 1 - P(t, tTitle - 0.4, 0.4);
        date.style.opacity = P(t, 0.3, 0.5) * out; legend.style.opacity = P(t, 0.4, 0.5) * out;
        counter.querySelector(".n").textContent = times.filter((x) => x <= now).length;
        counter.style.opacity = P(t, 0.6, 0.6) * out;
        fadeIn(title, P(t, tTitle, 0.6)); fadeIn(motif, P(t, tTitle + 0.5, 0.6));
        head3.style.opacity = P(t, tThree - 0.2, 0.4);
        three.forEach((x, i) => fadeIn(x, P(t, at3[i] - 0.15, 0.45), 16));
        return view;
      },
      tag: (t) => t < tTitle ? `from the ledger · ${LEDGER_SPAN(data)}` : "",
    };
  };

  SCENES.why = (c, data) => {
    const el = h("div");
    const st = data.stories.t278;
    const kw = keywords([[c.cue(0), "Built by Atelier"], [c.cue(1), "What Git can't tell you"], [c.when("A commit message"), "The agent's own word", "var(--fault)"], [c.cue(2), "Observed, not claimed", "var(--observed)"], [c.when("It even copies"), "The record, in Git"]]);
    el.append(kw.el);
    const A = layer();
    A.append(pos(h("div", { class: "abs", text: "Everything here is real.", style: { font: `700 72px/1.2 var(--font-display)`, color: "var(--text-bright)" } }), 120, TOP + 40),
      pos(h("div", { class: "abs", text: `Every task, review and figure comes from Atelier's own ledger, as of ${ASOF(data)}.`, style: { font: `500 ${BODY}px/1.35 var(--font-sans)`, color: "var(--text)", width: "1600px" } }), 120, TOP + 170));
    const B = layer();
    const qs = ["Who held the work?", "Did the tests run?", "Who checked it?"].map((q, i) => { const k = kinetic(q, "kin display", { position: "absolute", left: "120px", top: `${TOP + 20 + i * 140}px`, fontSize: "96px" }); B.append(k.el); return k; });
    B.append(foot("git log: commits, and none of these answers", 126, TOP + 470, 1600, { fontSize: "36px" }));
    const C = layer();
    const msg = data.terminal.commit.split("\n").filter((l) => l.trim() && !/^commit /.test(l));
    const left = pos(h("div", { class: "card", style: { padding: "24px 28px", width: "640px", height: "600px" } },
      h("div", { text: "Its last commit, written by the agent", style: { font: `600 ${FOOT}px/1.3 var(--font-sans)`, color: "var(--fault)" } }),
      ...msg.map((l) => h("div", { text: l.trim(), style: { font: `500 36px/1.35 var(--font-mono)`, color: "var(--text-bright)", marginTop: "22px" } })),
      h("div", { class: "claims", html: "no head it was checked at<br>no test results<br>no reviewer<br>nothing verifies the author", style: { font: `500 ${FOOT}px/1.5 var(--font-sans)`, color: "var(--text-muted)", marginTop: "28px" } })), 120, TOP);
    const L = st.landing;
    const evs = [st.events.find((e) => e.kind === "item.claimed"), ...L.filter((e) => ["push.observed", "review.rejected", "review.approved", "item.merged"].includes(e.kind))];
    const word = (e) => ({ "item.claimed": `${named(e.actor)} claims t278`, "push.observed": `pushed ${e.head}, read from Artifacts, checks observed`, "review.rejected": `<b style="color:var(--fault)">rejected</b> by ${named(e.actor)}`, "review.approved": `<b style="color:var(--observed)">approved</b> by ${named(e.actor)}`, "item.merged": `<b style="color:var(--observed)">merged</b> as ${e.mergeCommit}` }[e.kind]);
    const right = pos(h("div", { class: "card", style: { padding: "24px 28px", width: "1010px", height: "600px", borderColor: "var(--observed-line)" } },
      h("div", { text: "t278 in the ledger, written by Atelier from what it observed", style: { font: `600 ${FOOT}px/1.3 var(--font-sans)`, color: "var(--observed)" } }),
      ...evs.map((e) => h("div", { class: "ev", html: `<span class="mono" style="color:var(--text-muted)">${tm(e.at)}</span>&nbsp;&nbsp;${word(e)}`, style: { font: `500 31px/1.3 var(--font-sans)`, color: "var(--text)", marginTop: "14px" } }))), 790, TOP);
    C.append(left, right);
    const D = layer();
    const term = terminal("the lead developer's checkout of atelier · read-only", "git notes --ref=atelier show 5af22431", data.terminal.noteFull, 120, TOP - 10, 1680, 11, 86);
    D.append(term.el);
    el.append(A, B, C, D);
    const tB = c.cue(1), tC = c.when("A commit message"), tD = c.when("It even copies");
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: tD }, { el: D, a: tD, b: 1e9 }]);
    c.sfx(tC - 0.3, "whoosh", 0.5); c.sfx(c.cue(2), "swell", 0.5); c.sfx(tD, "whoosh", 0.5);
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        qs.forEach((k, i) => k.update(P(t, c.when(["who held", "whether the tests", "or who checked"][i]) - 0.2, 0.8)));
        fadeIn(left, P(t, tC, 0.5));
        left.querySelector(".claims").style.opacity = P(t, tC + 1.4, 0.5);
        fadeIn(right, P(t, c.cue(2), 0.5));
        [...right.querySelectorAll(".ev")].forEach((x, i) => fadeIn(x, P(t, c.cue(2) + 0.4 + i * 0.35, 0.3), 6));
        term.update(t, tD + 0.2);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tC - 0.1 ? "" : t < tD - 0.1 ? `from the ledger: t278 · ${day(st.mergedAt)} 2026` : `real terminal output · ${day(data.facts.cutoff)} 2026`,
      crit: (t) => t >= tD - 0.1 ? "context preservation" : "",
    };
  };

  SCENES.cast = (c, data) => {
    const el = h("div");
    const f = data.facts;
    const T = [c.when("A planner agent"), c.when("Builders work"), c.when("A reviewer checks"), c.when("The lead developer")];
    const kw = keywords([[T[0], "Four roles"], [c.when("one holder at a time"), "One holder per task", "var(--signal)"], [T[2], "Another family must approve", "var(--signal)"], [c.cue(2), "Concurrency"], [c.when("The most tasks"), "15 tasks at once"]]);
    el.append(kw.el);
    const A = layer();
    const svg = svgFull(); A.append(svg);
    const builders = Object.entries(f.mergedByFinalBuilder).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const reviewers = Object.entries(f.reviewsByModel).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const line = (m, n) => h("div", { style: { marginTop: "14px" } }, h("div", { style: { font: `700 ${FOOT + 2}px/1.2 var(--font-sans)`, color: col(fam(m)) }, text: `${NAMES[m] ?? m}${n != null ? `  ${n}` : ""}` }), h("div", { style: { font: `500 ${FOOT}px/1.2 var(--font-sans)`, color: "var(--text-muted)" }, text: COMPANY[fam(m)] }));
    const X = [80, 530, 980, 1430], W = 410;
    const boxes = [
      ["Planner", "splits a goal into parts", [line(data.plan.planner.split("/").pop(), null)]],
      ["Builders", "each in its own fork; tasks merged", builders.map(([m, n]) => line(m, n))],
      ["Reviewer", "of another family; reviews", reviewers.map(([m, n]) => line(m, n))],
      ["Lead developer", "the one human; merges", []],
    ].map(([name, what, kids], i) => {
      const b = pos(h("div", { class: "card", style: { padding: "22px 24px", width: W + "px", height: "500px" } },
        h("div", { class: "display", text: name, style: { fontSize: "52px" } }),
        h("div", { text: what, style: { font: `500 ${FOOT}px/1.35 var(--font-sans)`, color: "var(--text)", marginTop: "10px", marginBottom: "8px" } }), ...kids), X[i], TOP);
      A.append(b); return b;
    });
    const arrows = [0, 1, 2].map((i) => {
      const x1 = X[i] + W, x2 = X[i + 1], y = TOP + 60;
      const p = s("path", { d: `M ${x1 + 4} ${y} L ${x2 - 6} ${y} M ${x2 - 20} ${y - 12} L ${x2 - 6} ${y} L ${x2 - 20} ${y + 12}`, stroke: "var(--signal)", "stroke-width": 4, fill: "none" });
      svg.append(p); return p;
    });
    const famDef = foot(`<b style="color:var(--signal)">Family</b>: the company that made the model. Anthropic made Opus 5.5; Google made Gemini 3.1 Pro.`, 80, TOP + 530, 1760, { color: "var(--text)", fontSize: "34px" });
    A.append(famDef);
    const B = layer();
    const scale = [["One fork per task", "its own Git repository in Artifacts", "its own fork in"], ["One Durable Object per project", "each project's ledger apart from every other", "its own Durable Object"], ["Runners, as many as are started", "each claims jobs and checks in its own clean clone", "as many runners"], ["One landing on main at a time", "a lease per project; plans meet on their own branch", "only landing on main"]];
    const scaleEls = scale.map(([a, b2], i) => card(a, b2, 120 + (i % 2) * 850, TOP + Math.floor(i / 2) * 230, 820, 200));
    B.append(...scaleEls);
    const C = layer();
    const pk = data.peak;
    const big = bigNumber(pk.held.length, `tasks held at once, ${day(pk.at)}, ${utc(pk.at)}`, "Each in its own fork. Beyond this ledger's own peak, it hasn't been measured.", "var(--signal)");
    C.append(big.el);
    el.append(A, B, C);
    const tB = c.cue(2), tC = c.when("The most tasks");
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: 1e9 }]);
    T.forEach((x) => c.sfx(x - 0.05, "chime", 0.3)); c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC, "swell", 0.6);
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        boxes.forEach((b, i) => pop(b, P(t, T[i] - 0.15, 0.5), 0.85));
        arrows.forEach((a, i) => { a.style.opacity = P(t, T[i + 1] - 0.2, 0.5); });
        fadeIn(famDef, P(t, c.when("a family being") - 0.2, 0.5));
        scaleEls.forEach((x, i) => fadeIn(x, P(t, c.when(scale[i][2]) - 0.2, 0.45), 10));
        big.update(t, tC);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: () => `from the ledger · ${LEDGER_SPAN(data)}`,
      crit: (t) => t >= tB - 0.1 ? "concurrency" : "coordination",
    };
  };

  SCENES.gate = (c, data) => {
    const st = data.stories.t278;
    const el = h("div");
    const tB = c.cue(1), tC = c.cue(2), tD = c.cue(2) + 2.8;
    const tRej = c.when("Gemini rejected it twice"), tDrop = c.when("then one bad log"), tFixed = c.when("All four findings"), tThird = c.when("the third head");
    const kw = keywords([[0, "Proof first"], [c.when("Atelier records"), "Observed, not claimed", "var(--observed)"], [tB, "Another family must approve", "var(--signal)"], [tRej, "Rejected twice", "var(--fault)"], [tFixed, "All four real, all fixed", "var(--observed)"], [tThird, "Merged 11 s after approval", "var(--observed)"], [tC, "The live page"]]);
    el.append(kw.el);
    // A: the gate.
    const A = layer();
    const sA = svgFull(); A.append(sA);
    const nodes = [["Pushed head", "the latest commit, read from Artifacts"], ["Clean clone", "of that head, on the lead developer's machine"], ["Checks", "recorded as Atelier saw them"], ["Review", "by another family"], ["Lead developer", "merges"]].map(([a, b], i) => {
      const n = pos(h("div", { class: "card", style: { padding: "20px 22px", width: "326px", height: "250px" } }, h("div", { style: { font: `700 ${BODY}px/1.15 var(--font-sans)`, color: "var(--text-bright)" }, text: a }), h("div", { text: b, style: { font: `500 ${FOOT}px/1.35 var(--font-sans)`, marginTop: "12px", color: "var(--text-muted)" } })), 70 + i * 360, TOP);
      A.append(n); return n;
    });
    const edges = [0, 1, 2, 3].map((i) => beads(sA, `M ${70 + i * 360 + 326} ${TOP + 125} L ${70 + (i + 1) * 360} ${TOP + 125}`, "#ffd166", 1, 7));
    const obs = pos(h("div", { class: "abs stamp", text: "Observed", style: { color: "var(--observed)", fontSize: "44px" } }), 790, TOP + 290);
    const rep = foot("An agent's own word is shown as <b>Reported</b>, and never counted. Checks inside a Cloudflare Container: built, not yet proven.", 70, TOP + 420, 1760, { color: "var(--text)", fontSize: "34px" });
    A.append(obs, rep);
    // B: t278's three rounds.
    const B = layer();
    const L = st.landing;
    const rounds = L.filter((e) => e.kind === "push.observed").map((p) => ({ head: p.head, at: p.at, review: st.reviews.find((r) => r.head === p.head) }));
    B.append(pos(h("div", { class: "abs", html: `Task t278 · built by ${named(st.builders[0])} · reviewed by ${named(rounds[0].review.by)}`, style: { font: `600 36px/1.2 var(--font-sans)`, color: "var(--text)" } }), 120, TOP));
    const rowEls = rounds.map((r, i) => {
      const y = TOP + 70 + i * 92;
      const row = pos(h("div", { class: "abs", style: { display: "flex", gap: "40px", alignItems: "center" } },
        h("span", { class: "mono", text: r.head, style: { fontSize: "40px", color: "var(--text-bright)", width: "240px" } }),
        h("span", { class: "mono", text: tm(r.at), style: { fontSize: FOOT + "px", color: "var(--text-muted)", width: "170px" } }),
        h("span", { text: "✓ checks observed", style: { font: `500 36px/1 var(--font-sans)`, color: "var(--observed)", width: "330px" } }),
        h("span", { class: "stamp", text: r.review.approve ? "approved" : "rejected", style: { color: r.review.approve ? "var(--observed)" : "var(--fault)", fontSize: "38px" } }),
        h("span", { class: "mono", text: tm(r.review.at), style: { fontSize: FOOT + "px", color: "var(--text-muted)" } })), 120, y);
      B.append(row); return row;
    });
    const quote = (f, verdict) => h("div", { class: "quote", style: { font: `400 34px/1.4 var(--font-sans)`, width: "1660px" }, html: `“${quoteHtml(f.text.split(/(?<=[.;])\s(?=[A-Z`])/)[0])}”<span class="src" style="font-size:${FOOT}px">${esc(f.file)}:${f.line} · blocking${verdict ? ` · <b style="color:var(--observed)">${esc(verdict)}</b>` : ""}</span>` });
    const b1 = rounds[0].review.findings.find((f) => f.severity === "blocking"), b2 = rounds[1].review.findings.find((f) => f.severity === "blocking");
    const q1 = pos(h("div", { class: "abs" }, quote(b1, "")), 120, TOP + 370);
    const q2 = pos(h("div", { class: "abs" }, quote(b2, "")), 120, TOP + 370);
    const mer = L.find((e) => e.kind === "item.merged");
    const qm = pos(h("div", { class: "abs", html: `<span class="stamp" style="color:var(--observed);font-size:40px">merged as ${mer.mergeCommit}</span>&nbsp;&nbsp;<span style="font:600 ${BODY}px var(--font-sans);color:var(--signal)">${Math.round((Date.parse(mer.at) - Date.parse(rounds[2].review.at)) / 1000)} s after the approval</span>` }), 120, TOP + 400);
    const verdictNote = foot("the lead developer's verdict on all four findings: <b style='color:var(--observed)'>fixed</b>", 120, TOP + 560, 1680, { color: "var(--text)" });
    B.append(q1, q2, qm, verdictNote);
    const rings = rounds.map((r, i) => pulseRing(B, 120 + 240 + 40 + 170 + 40 + 330 + 40 + 100, TOP + 70 + i * 92 + 26, r.review.approve ? "var(--observed)" : "var(--fault)"));
    // C, D: the live page.
    const C = layer(), D = layer();
    const url = "atelier.zone<b>/p/atelier/t278</b>";
    const fThread = footage("t278-thread", url, "the live page · captured 8 October 2026", 1760, Math.round(1760 * 380 / 1740), TOP);
    const fRev = footage("t278-reviews", url, "the live page · captured 8 October 2026", 1300, Math.round(1300 * 720 / 1740), TOP - 10);
    C.append(fThread.el, foot("Its thread: <b style='color:var(--fault)'>two send-backs</b> (red rings), then the merge into main. Times in New York time, UTC−4.", 80, TOP + 470, 1760, { color: "var(--text)", fontSize: "36px" }));
    D.append(fRev.el, foot("“Agent's machine”: the runner on the lead developer's Mac, which ran each check in a clean clone.", 310, TOP + 596, 1300, { color: "var(--text)" }));
    el.append(A, B, C, D);
    const tint = h("div", { class: "abs tint", style: { inset: 0, pointerEvents: "none" } });
    el.append(tint);
    const R = [tRej + 0.5, tDrop + 0.5, tThird + 0.3];
    R.forEach((x, i) => c.sfx(x, i < 2 ? "reject" : "approve", 1)); c.sfx(tB - 0.3, "whoosh", 0.6); c.sfx(tC - 0.2, "whoosh", 0.5);
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: tD }, { el: D, a: tD, b: 1e9 }]);
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        nodes.forEach((n, i) => pop(n, P(t, 0.2 + i * 0.25, 0.4), 0.85));
        edges.forEach((e, i) => e.update(t, 0.5 + i * 0.25, 0.9, 1));
        pop(obs, P(t, c.when("Atelier records") - 0.1, 0.4), 1.4);
        fadeIn(rep, P(t, c.when("never the agent") - 0.1, 0.5));
        const appear = [tB + 0.6, tDrop - 0.5, tFixed + 0.3];
        rowEls.forEach((r, i) => { fadeIn(r, P(t, appear[i], 0.45), 10); const st2 = r.querySelector(".stamp"); const k = P(t, R[i], 0.35); st2.style.opacity = k; st2.style.transform = `scale(${lerp(1.6, 1, k)})`; rings[i].update(t, R[i]); });
        const win = (p, a, b) => { p.style.display = t >= a && t < b + 0.4 ? "block" : "none"; p.style.opacity = P(t, a, 0.4) * (1 - P(t, b, 0.35)); };
        win(q1, R[0] + 0.3, tDrop - 0.1); win(q2, R[1] + 0.3, tThird); win(qm, tThird + 0.2, 1e9);
        verdictNote.style.opacity = P(t, tFixed, 0.4);
        const wash = (a) => Math.max(0, 1 - Math.abs(t - a - 0.25) / 0.7) * (t > a ? 1 : 0);
        const red = Math.max(wash(R[0]), wash(R[1])), green = wash(R[2]);
        tint.style.boxShadow = red > 0 ? `inset 0 0 ${240 * red}px rgba(255,77,116,${0.5 * red})` : green > 0 ? `inset 0 0 ${240 * green}px rgba(95,224,143,${0.45 * green})` : "none";
        fThread.push(t, tC, tD); fRev.push(t, tD, c.dur);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tB - 0.1 ? "" : t < tC - 0.1 ? `from the ledger: t278 · ${day(st.mergedAt)} 2026` : "the live page of t278 · 8 October 2026",
      crit: () => "review",
    };
  };

  SCENES.stories = (c, data) => {
    const el = h("div");
    const s283 = data.stories.t283, s296 = data.stories.t296, s219 = data.stories.t219, f = data.facts;
    const tX = c.cue(1), tRj = c.cue(2), tB = c.cue(3), tC = c.cue(4), tJ = c.when("has judged 52");
    const kw = keywords([[0, "524 lines, wiped"], [c.when("a saved patch"), "Rescued", "var(--observed)"], [tX, "Nothing is lost", "var(--signal)"], [tRj, "A way out of the sandbox", "var(--fault)"], [c.when("Once that was fixed"), "Fixed, then approved", "var(--observed)"], [tB, "A leak, caught", "var(--fault)"], [tC, "Sent back"], [tJ, "Judged against the code"]]);
    el.append(kw.el);
    const ev = (st, kind, pred = () => true) => st.events.find((e) => e.kind === kind && pred(e));
    const rel = ev(s283, "item.released", (e) => /timed out/.test(e.note ?? ""));
    const rej = s283.reviews.find((r) => !r.approve), app = s283.reviews.find((r) => r.approve), mer = ev(s283, "item.merged");
    const f283 = rej.findings.find((x) => x.severity === "blocking");
    const t296c = data.selfTasks.t296, m296 = ev(s296, "item.merged");
    // A: the wipe and the rescue.
    const A = layer();
    const rA = rows([
      { time: dt(rel.at), what: `${named("opencode/glm-5.3")}'s run ends: “${esc(rel.note)}”; the runner claims the task back and resets the workspace` },
      { time: dt(t296c.createdAt), what: "t296 filed", detail: `“…was deleted when home:mbp-2 reclaimed the task, and was recovered only from a patch the orchestrator had saved.”`, quote: true, qcolor: "var(--signal)" },
      { time: dt(m296.at), what: "t296 merged: a runner now saves uncommitted work before it resets", color: "var(--observed)" },
    ]);
    A.append(rA.el);
    const tA = [0.6, c.when("a saved patch"), c.when("fixed that night")];
    // X: context preservation.
    const X = layer();
    const ctx = [["The ledger", `${f.claims} claims, ${f.handoffs} handoffs, ${f.observedChecks.toLocaleString("en-GB")} observed checks, ${f.modelReviews} reviews`, "every claim"], ["Briefs", "a rework brief carries the findings to fix", "a rework brief"], ["Rescued work", "saved under refs/atelier/rescue/ before a reset", "the findings to fix"], ["Provenance in Git", "a note on each merge holds the task's record", "each merge carries"]];
    const ctxEls = ctx.map(([a, b2], i) => card(a, b2, 120 + (i % 2) * 850, TOP + Math.floor(i / 2) * 230, 820, 200));
    X.append(...ctxEls);
    // A2: the rejection.
    const A2 = layer();
    A2.append(pos(h("div", { class: "abs", html: `${dt(rej.at).replace("<br>", " · ")} · rejected by ${named(rej.by)} at ${rej.head}`, style: { font: `600 ${BODY}px/1.2 var(--font-sans)`, color: "var(--fault)" } }), 120, TOP),
      pos(h("div", { class: "abs quote", style: { font: `400 36px/1.4 var(--font-sans)`, width: "1660px" }, html: `“${quoteHtml(f283.text.split(/(?<=\.)\s/)[0])}”<span class="src" style="font-size:${FOOT}px">${esc(f283.file)}:${f283.line} · blocking</span>` }), 120, TOP + 90));
    const appRow = pos(h("div", { class: "abs", html: `${dt(app.at).replace("<br>", " · ")} · approved by ${named(app.by)} · merged as ${mer.mergeCommit}`, style: { font: `600 ${BODY}px/1.2 var(--font-sans)`, color: "var(--observed)" } }), 120, TOP + 470);
    A2.append(appRow);
    // B: t219.
    const B = layer();
    const r219 = s219.reviews.find((r) => !r.approve), a219 = s219.reviews.find((r) => r.approve), m219 = ev(s219, "item.merged");
    const f219 = r219.findings.find((x) => x.severity === "blocking");
    B.append(pos(h("div", { class: "abs", html: `t219 · ${day(r219.at)} · rejected by ${named(r219.by)} at ${r219.head}`, style: { font: `600 ${BODY}px/1.2 var(--font-sans)`, color: "var(--text-bright)" } }), 120, TOP),
      pos(h("div", { class: "abs quote", style: { font: `400 40px/1.4 var(--font-sans)`, width: "1660px" }, html: `“${quoteHtml(f219.text.split(/(?<=;)\s/)[0])}”<span class="src" style="font-size:${FOOT}px">${esc(f219.file)}:${f219.line} · blocking</span>` }), 120, TOP + 90),
      pos(h("div", { class: "abs", html: `Fixed: every signed-out /p/ path now answers alike. Approved by ${named(a219.by)}, merged as ${m219.mergeCommit}.`, style: { font: `600 ${BODY - 4}px/1.3 var(--font-sans)`, color: "var(--observed)", width: "1660px" } }), 120, TOP + 400));
    // C1, C2: the numbers.
    const C1 = layer(), C2 = layer();
    const fv = f.findingVerdicts, real = (fv.confirmed ?? 0) + (fv.fixed ?? 0), wrong = fv.refuted ?? 0;
    const big1 = bigNumber(f.modelRejections, `send-backs, in ${f.modelReviews} reviews by agents`, "Each sent work back to be fixed before it could merge.", "var(--fault)");
    C1.append(big1.el);
    const big2 = bigNumber(`${real} of ${real + wrong}`, "of Gemini's findings held up, judged against the code", `${wrong} did not, so every reviewer's precision is tracked.`, "var(--observed)");
    C2.append(big2.el);
    const ov = data.overrides, lw = f.lastMergeWithoutCrossApproval;
    const since = data.tasks.filter((t) => t.state === "merged" && t.kind !== "plan" && t.mergedAt > lw.at);
    const waiver = foot(`On ${day(ov[0].at)} the lead developer waived the family rule ${ov.length} times, each recorded as an override. Since ${lw.id} that evening, all ${since.length} merged tasks had another family's approval.`, 120, TOP + 520, 1680, { color: "var(--text)" });
    C2.append(waiver);
    el.append(A, X, A2, B, C1, C2);
    const show = slides([{ el: A, a: 0, b: tX }, { el: X, a: tX, b: tRj }, { el: A2, a: tRj, b: tB }, { el: B, a: tB, b: tC }, { el: C1, a: tC, b: tJ }, { el: C2, a: tJ, b: 1e9 }]);
    c.sfx(tX - 0.2, "whoosh", 0.5); c.sfx(tRj + 0.2, "reject", 0.9); c.sfx(c.when("Once that was fixed"), "approve", 0.8); c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC, "swell", 0.6); c.sfx(tJ, "swell", 0.6);
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        rA.els.forEach((r, i) => fadeIn(r, P(t, tA[i] - 0.15, 0.5), 10));
        ctxEls.forEach((x, i) => fadeIn(x, P(t, (i === 0 ? tX + 0.3 : c.when(ctx[i][2])) - 0.2, 0.5), 10));
        fadeIn(appRow, P(t, c.when("Once that was fixed") - 0.1, 0.5));
        big1.update(t, tC); big2.update(t, tJ);
        fadeIn(waiver, P(t, c.when("which is why") - 0.2, 0.5));
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tX - 0.1 || (t >= tRj - 0.1 && t < tB - 0.1) ? `from the ledger: t283, t296 · ${day(rel.at)} 2026` : t < tRj - 0.1 ? `from the ledger · ${LEDGER_SPAN(data)}` : t < tC - 0.1 ? `from the ledger: t219 · ${day(r219.at)} 2026` : `from the ledger · ${LEDGER_SPAN(data)}`,
      crit: (t) => t < tRj - 0.1 ? "context preservation" : "review",
    };
  };

  SCENES.plan = (c, data) => {
    const pl = data.plan;
    const el = h("div");
    const tC = c.cue(1), tD = c.cue(2);
    const tProp = c.when("Opus 5.5 split"), tAppr = c.when("approved once"), tWho = c.when("Each part got");
    const kw = keywords([[0, "Big goals become plans"], [tAppr, "Approved once, by hash", "var(--signal)"], [tWho, "Five agents, one plan"], [tC, "Coordination"], [c.when("it moved the part"), "Moved, on its own", "var(--signal)"], [tD, "Conflict handling"], [c.when("gave it to GLM"), "Handed to an agent", "var(--signal)"], [c.when("On a single task"), "Back to its builder"]]);
    el.append(kw.el);
    // B: plan t197.
    const B = layer();
    const tCreated = data.tasks.find((t) => t.id === "t197").createdAt;
    B.append(pos(h("div", { class: "abs", html: `Plan t197 · ${day(tCreated)} · planner ${named(pl.planner)} · ${pl.proposed.length} parts proposed ${utc(pl.proposedAt)}`, style: { font: `600 36px/1.2 var(--font-sans)`, color: "var(--text)" } }), 120, TOP));
    const approve = pos(h("div", { class: "abs", html: `<span class="stamp" style="color:var(--signal);font-size:40px">approved ${utc(pl.approvedAt)}</span>` }), 120, TOP + 70);
    const parts = pl.proposed.map((p) => pl.parts.find((q) => q.key === p.key));
    const partEls = parts.map((part, i) => pos(h("div", { class: "card", style: { padding: "12px 20px", width: "830px", height: "96px", borderWidth: "3px", borderColor: col(fam(part.approvedBy[0] ?? "")) , boxShadow: `inset 8px 0 0 ${HEX[fam(part.builders[0])]}` } },
      h("div", { style: { font: `600 ${FOOT}px/1.2 var(--font-mono)`, color: "var(--text-bright)" }, text: part.id }),
      h("div", { style: { font: `500 ${FOOT - 2}px/1.3 var(--font-sans)`, marginTop: "6px" }, html: `${part.builders.map(named).join(" + ")} <span style="color:var(--text-muted)">→ review</span> ${part.approvedBy.map(named).join(", ")}` })), 120 + (i % 2) * 850, TOP + 150 + Math.floor(i / 2) * 112));
    B.append(approve, ...partEls);
    const ints = pl.parts.filter((p) => p.integratedAt);
    const merged = pos(h("div", { class: "abs", html: `<span class="stamp" style="color:var(--observed);font-size:40px">merged ${utc(pl.mergedAt)}, ${day(pl.mergedAt)}</span>` }), 780, TOP + 70);
    const mergedNote = foot(`${ints.length} parts integrated on the plan's branch: ${pl.proposed.length} proposed, ${ints.filter((p) => p.added).length} added to merge main in as it moved.`, 120, TOP + 604, 1680);
    B.append(merged, mergedNote);
    // C: t209.
    const C = layer();
    const s209 = data.stories.t209, evs = s209.events;
    const rels = evs.filter((e) => e.kind === "item.released");
    const toFable = evs.find((e) => e.kind === "item.dispatched" && e.actor === "atelier/orchestrator" && e.model === "fable-5.1");
    const wd = evs.find((e) => e.kind === "review.withdrawn");
    const appr = s209.reviews.find((r) => r.approve);
    const rC = rows([
      { time: dt(rels[0].at), what: `two runs by ${named("opencode/glm-5.3")} on part t209 end without a commit` },
      { time: dt(toFable.at), what: `the orchestrator moves the part to ${named("claude-code/fable-5.1")}`, detail: `“${esc(toFable.note)}”`, quote: true, qcolor: "var(--signal)" },
      { time: dt(wd.at), what: `it moves the review from ${named("opencode/glm-5.3")} to ${named("antigravity/gemini-3.1-pro")}`, detail: `“${esc(wd.note)}”`, quote: true, qcolor: "var(--signal)" },
    ]);
    C.append(rC.el, foot("The orchestrator is Atelier's own code, with no model. opencode is the tool GLM-5.3 runs in.", 120, TOP + 570, 1680));
    // D: t255.
    const D = layer();
    const s255 = data.stories.t255, e255 = s255.events;
    const rf = data.stories.t197.events.find((e) => e.kind === "plan.refresh_failed" && e.at === e255[0].at);
    const files = [...(rf?.note ?? "").matchAll(/Merge conflict in (\S+)/g)].map((m) => m[1]);
    const rej255 = s255.reviews.find((r) => !r.approve), app255 = s255.reviews.find((r) => r.approve), integ = e255.find((e) => e.kind === "part.integrated");
    const rD = rows([
      { time: dt(e255[0].at), what: `main conflicts with the plan's branch in ${files.length} files: merge job t255 goes to ${named("opencode/glm-5.3")}`, detail: files.join(" · "), mono: true },
      { time: dt(rej255.at), what: `${named(rej255.by)} sends the resolution back once: a stale sentence in docs/demo.md` },
      { time: dt(app255.at), what: `approved; integrated on the plan's branch at ${tm(integ.at)}`, color: "var(--observed)" },
    ]);
    const single = foot("On a single task, a landing that conflicts stops and names the files; <b style='color:var(--signal)'>atelier dispatch ID --job merge-main</b> sends it back to the builder. One landing lease per project: two landings never race main.", 120, TOP + 500, 1680, { color: "var(--text)" });
    D.append(rD.el, single);
    el.append(B, C, D);
    const show = slides([{ el: B, a: 0, b: tC }, { el: C, a: tC, b: tD }, { el: D, a: tD, b: 1e9 }]);
    c.sfx(tAppr + 0.3, "chime", 0.6); c.sfx(tC - 0.2, "whoosh", 0.5); c.sfx(tD - 0.2, "whoosh", 0.5);
    const tRC = [c.when("when two attempts"), c.when("it moved the part"), c.when("and moved its review")];
    const tRD = [tD + 0.3, c.when("sent the resolution back"), c.when("then approved it")];
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        const ka = P(t, tAppr, 0.35); approve.style.opacity = ka; approve.style.transform = `scale(${lerp(1.4, 1, ka)})`; approve.style.transformOrigin = "0 0";
        partEls.forEach((p, i) => pop(p, P(t, tProp + 0.4 + i * 0.12, 0.4), 0.85));
        fadeIn(merged, P(t, tWho + 0.4, 0.5)); fadeIn(mergedNote, P(t, tWho + 0.8, 0.5));
        rC.els.forEach((r, i) => fadeIn(r, P(t, tRC[i] - 0.15, 0.5), 10));
        rD.els.forEach((r, i) => fadeIn(r, P(t, tRD[i] - 0.15, 0.5), 10));
        fadeIn(single, P(t, c.when("On a single task") - 0.2, 0.5));
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tC - 0.1 ? `from the ledger: t197 · ${day(pl.proposedAt)} and ${day(pl.mergedAt)} 2026` : t < tD - 0.1 ? `from the ledger: t209 · ${day(rels[0].at)} and ${day(appr.at)} 2026` : `from the ledger: t255 · ${day(e255[0].at)} 2026`,
      crit: (t) => t < tD - 0.1 ? "coordination" : "conflict handling",
    };
  };

  SCENES.metrics = (c, data) => {
    const el = h("div");
    const f = data.facts, gw = data.api.gateway;
    const tB = c.cue(1), tC = c.cue(2);
    const kw = keywords([[0, "One window: 1 to 8 October"], [c.when("Of 239 merged"), "Who built what merged"], [tB, "What it cost"], [tC, "A failure, traced"], [c.when("the run report"), "Our configuration", "var(--signal)"], [c.when("The fix is"), "Filed, and fixed", "var(--observed)"]]);
    el.append(kw.el);
    const A = layer();
    const byCo = {};
    for (const [m, n] of Object.entries(f.mergedByFinalBuilder)) { const list = (byCo[fam(m)] ??= []), name = NAMES[m] ?? m, had = list.find((x) => x[0] === name); if (had) had[1] += n; else list.push([name, n]); }
    const cos = Object.entries(byCo).map(([co, ms]) => [co, ms.reduce((s2, [, n]) => s2 + n, 0), ms.sort((a, b) => b[1] - a[1])]).sort((a, b) => b[1] - a[1]);
    const total = cos.reduce((s2, x) => s2 + x[1], 0), maxN = cos[0][1];
    const coRows = cos.map(([co, n, ms]) => h("div", { style: { display: "flex", alignItems: "center", gap: "20px", height: "78px" } },
      h("div", { class: "display", text: COMPANY[co], style: { width: "260px", fontSize: BODY + "px", color: col(co), textAlign: "right" } }),
      h("div", { class: "bar", style: { height: "44px", width: `${Math.max(6, n / maxN * 640)}px`, background: col(co), borderRadius: "6px" } }),
      h("div", { class: "display", text: String(n), style: { fontSize: BODY + 4 + "px", width: "90px" } }),
      h("div", { text: ms.slice(0, 3).map(([m, k]) => `${m} ${k}`).join(", "), style: { font: `500 ${FOOT}px/1.2 var(--font-sans)`, color: "var(--text-muted)" } })));
    A.append(pos(h("div", { class: "abs" }, ...coRows), 80, TOP - 6),
      foot(`${total} merged tasks, each counted once, for the model whose head merged; with plan t197, ${total + f.mergedPlans}. Reviews: Gemini 3.1 Pro did ${f.reviewsByModel["gemini-3.1-pro"]} of ${f.modelReviews}. The ledger's first task is of ${day(f.firstTaskAt)}.`, 120, TOP + 490, 1680, { color: "var(--text)" }));
    const B = layer();
    const gm = gw.models.filter((m) => m.calls >= 10).sort((a, b) => /deepseek/.test(a.model) ? -1 : /deepseek/.test(b.model) ? 1 : 0);
    const gName = (m) => ({ "moonshotai/kimi-k2.7-code": ["Kimi K2.7 Code", "Moonshot", "moonshot"], "deepseek-v4-pro": ["DeepSeek V4 Pro", "DeepSeek", "deepseek"] }[m] ?? [m, "", "other"]);
    const gRows = gm.map((m) => { const [n, co, fm] = gName(m.model); return h("div", { class: "grow", style: { display: "flex", gap: "40px", alignItems: "baseline", height: "120px" } },
      h("div", { style: { width: "560px" } }, h("div", { class: "display", text: n, style: { fontSize: "52px", color: col(fm) } }), h("div", { text: co, style: { font: `500 ${FOOT}px var(--font-sans)`, color: "var(--text-muted)" } })),
      h("div", { class: "display", html: `${m.calls} <span style="font-size:${FOOT}px;color:var(--text-muted)">calls</span>`, style: { fontSize: "60px", width: "320px" } }),
      h("div", { class: "display", html: `${m.failures} <span style="font-size:${FOOT}px;color:var(--text-muted)">failed</span>`, style: { fontSize: "60px", width: "280px", color: m.failures ? "var(--fault)" : "var(--text-bright)" } }),
      h("div", { class: "display", text: `$${m.cost.toFixed(2)}`, style: { fontSize: "60px" } })); });
    B.append(pos(h("div", { class: "abs" }, ...gRows), 120, TOP + 10),
      foot(`AI Gateway, the last ${gw.days} days: ${day(gw.since)} ${utc(gw.since)} to ${day(gw.readAt)} ${utc(gw.readAt)}. Two more models made four calls between them. Only pay-per-use calls pass through the gateway; subscription and local agents are counted from the ledger alone.`, 120, TOP + 330, 1680, { color: "var(--text)" }));
    const C = layer();
    const s275 = data.stories.t275;
    const kimiRuns = data.runs.filter((r) => r.item === "t275" && /kimi/.test(r.actor)).sort((a, b) => a.at < b.at ? -1 : 1);
    const cause = kimiRuns.find((r) => /Our configuration/.test(r.detail));
    const app = s275.reviews.find((r) => r.approve), mer = s275.events.find((e) => e.kind === "item.merged");
    const rC = rows([
      { time: dt(kimiRuns[0].at), what: `${named("opencode/kimi-k2.7-code")}'s runs on t275 end; the gateway's logs show 12 HTTP 400s: context overflow`, detail: "230,145 input tokens + 32,000 output > 262,144 (from t313's title)", mono: true },
      { time: dt(cause.at), what: "the run report", detail: `“…${esc(cause.detail.slice(cause.detail.indexOf("because ") + 8))}”`, quote: true, qcolor: "var(--signal)" },
      { time: dt(app.at), what: `t313 filed; t275 finished by ${named("claude-code/opus-5.5")}, approved by ${named(app.by)}, merged as ${mer.mergeCommit}`, color: "var(--observed)" },
    ]);
    C.append(rC.el);
    el.append(A, B, C);
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: 1e9 }]);
    const tRC = [tC + 0.2, c.when("the run report"), c.when("The fix is")];
    c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC - 0.2, "whoosh", 0.5); c.sfx(tRC[2], "approve", 0.7);
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        coRows.forEach((r, i) => { fadeIn(r, P(t, 0.4 + i * 0.15, 0.4), 8); const b = r.querySelector(".bar"); b.style.transformOrigin = "0 50%"; b.style.transform = `scaleX(${P(t, 0.6 + i * 0.15, 0.7)})`; });
        gRows.forEach((r, i) => fadeIn(r, P(t, (/deepseek/.test(gm[i].model) ? c.when("DeepSeek V4 Pro") : c.when("98 calls")) - 0.3, 0.45), 8));
        rC.els.forEach((r, i) => fadeIn(r, P(t, tRC[i] - 0.15, 0.5), 10));
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tC - 0.1 ? `1 to ${day(f.cutoff)} 2026 · as of ${utc(f.cutoff)}` : `from the ledger: t275, t313 · ${day(s275.mergedAt)} 2026`,
      crit: (t) => t < tC - 0.1 ? "" : "context preservation",
    };
  };

  SCENES.who = (c, data) => {
    const el = h("div");
    const tB = c.cue(1), tC = c.cue(2);
    const kw = keywords([[0, "Who is it for?"], [c.when("new project"), "A new project"], [c.when("under a minute"), "Merged in under a minute", "var(--observed)"], [tB, "What a team gets"], [tC, "Open to anyone"]]);
    el.append(kw.el);
    const A = layer();
    const log = data.terminal.freshLog.trim().split("\n").map((l) => l.split(" "));
    const first = log.at(-1), mergeL = log[0];
    const steps = [[first[1], "a pager, and a test it fails", "", "new project"], ["15:27:26", "atelier init", "registers the project", "init"], ["15:27:34", "atelier new", "files task t1", "new start"], ["15:27:35", "atelier start", "Opus 5.5 claims it, in its own fork", "start done"], ["15:27:45", "atelier done", "pushed; npm test observed passing", "done and land"], ["15:28:06", "atelier land", `merged as ${mergeL[0]}, the record attached`, "land merged"]];
    const stepEls = steps.map(([t0, cmd, what], i) => pos(h("div", { class: "abs", style: { display: "flex", gap: "30px", alignItems: "baseline", width: "1700px" } },
      h("span", { class: "mono", text: t0, style: { fontSize: FOOT + "px", color: "var(--text-muted)", width: "160px" } }),
      h("span", { text: cmd, style: { font: `600 ${BODY}px/1.2 ${i ? "var(--font-mono)" : "var(--font-sans)"}`, color: i === 5 ? "var(--observed)" : i ? "var(--signal)" : "var(--text-bright)", width: i ? "420px" : "auto" } }),
      h("span", { text: what, style: { font: `500 36px/1.2 var(--font-sans)`, color: "var(--text)" } })), 120, TOP + i * 92));
    const secs = Math.round((Date.parse("2026-10-08T15:28:06.110Z") - Date.parse(`2026-10-08T${first[1]}Z`)) / 1000);
    A.append(...stepEls);
    const B = layer();
    const cards = [["One holder per task", "hands change only by a recorded handoff"], ["Checks it can trust", "observed in a clean clone, never taken from the agent"], ["Another company's review", "and a record of which reviewers are right"], ["A ledger of who did what", "kept by the server, and noted in Git on each merge"]].map(([a, b2], i) => card(a, b2, 120 + (i % 2) * 850, TOP + Math.floor(i / 2) * 230, 820, 200));
    B.append(...cards);
    const C = layer();
    const shot = browser("front", "<b>atelier.zone</b>", "public, no sign-in · captured 8 October 2026");
    shot.el.style.top = (TOP - 20) + "px"; shot.el.style.height = "660px";
    C.append(shot.el);
    el.append(A, B, C);
    const moves = (data.screens.front.marks["Latest moves across projects"]?.y ?? 2000) - 24;
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: 1e9 }]);
    c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC - 0.2, "whoosh", 0.5);
    return {
      el,
      update(t) {
        show(t); kw.update(t);
        stepEls.forEach((r, i) => fadeIn(r, P(t, c.when(steps[i][3]) - 0.2, 0.4), 8));
        cards.forEach((x, i) => pop(x, P(t, tB + 0.2 + i * 0.5, 0.5), 0.9));
        shot.el.style.display = "block"; shot.el.style.opacity = 1; shot.el.style.transform = "none";
        // The top of the front page, its headline only (its counts use another window), then its latest moves.
        shot.pan(t, [[tC, 0, 2.0, 100], [tC + 2.4, 0, 2.0, 100], [tC + 3.4, moves, 1.3, 120], [c.dur, moves + 10, 1.3, 120]]);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tB - 0.1 ? `from the ledger: fresh-demo t1 · ${day(data.facts.cutoff)} 2026 · ${secs} s` : t < tC - 0.1 ? "" : "the public front page · 8 October 2026",
      crit: () => "ease of use",
    };
  };

  SCENES.cloud = (c, data) => {
    const el = h("div");
    const kw = keywords([[0, "It runs on Cloudflare"], [c.cue(1), "Live, and built"]]);
    el.append(kw.el);
    const group = (title, items, x, y, w, color, dashed) => pos(h("div", { class: "abs", style: { width: w + "px" } },
      h("div", { text: title, style: { font: `600 ${FOOT}px/1 var(--font-mono)`, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-muted)" } }),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "16px", marginTop: "18px" } }, ...items.map(([n, at]) => h("span", { class: "chip huge", "data-at": at, style: { color, borderStyle: dashed ? "dashed" : "solid" } }, h("span", { class: "dot" }), n)))), x, y);
    const live = group("Cloudflare · live", [["Worker", "a Worker"], ["Durable Objects", "a Durable Object"], ["Artifacts", "and Artifacts"], ["Workers Logs", "Workers Logs"], ["AI Gateway", "AI Gateway"], ["Access", "Access"], ["R2", "R2"], ["Workflows", "Workflows are"]], 120, TOP, 1680, "var(--observed)", false);
    const built = group("Built, not yet in daily use", [["Browser Rendering", "Browser Rendering"], ["Containers", "Containers are"]], 120, TOP + 330, 1680, "var(--text)", true);
    const home = group("The lead developer's machines", [["atelier CLI", "0.4"], ["Runners", "0.7"]], 120, TOP + 500, 1680, "var(--signal)", false);
    el.append(live, built, home);
    const chips = [...el.querySelectorAll(".chip")].map((x) => ({ x, at: /^[\d.]+$/.test(x.dataset.at) ? Number(x.dataset.at) : c.when(x.dataset.at) }));
    [c.cue(1), c.when("Browser Rendering")].forEach((x) => c.sfx(x, "chime", 0.3));
    return {
      el,
      update(t) {
        kw.update(t);
        [live, built, home].forEach((g, i) => { g.firstChild.style.opacity = P(t, i === 1 ? c.when("Browser Rendering") - 0.3 : 0.2, 0.4); });
        chips.forEach(({ x, at }) => pop(x, P(t, at - 0.2, 0.4), 0.7));
        return { cx: 960, cy: 540, s: 1 };
      },
    };
  };

  SCENES.close = (c, data) => {
    const el = h("div");
    const F = field(data);
    const cam = camera(F.world, F.W, F.H);
    el.append(F.world);
    const hud = layer();
    el.append(hud);
    const f = data.facts;
    const at3 = [c.when("Checks Atelier observed"), c.when("Approval by another"), c.when("A record of every")];
    const three = THREE.map((x, i) => pos(h("div", { class: "abs", style: { display: "flex", gap: "28px", alignItems: "baseline", width: "1600px" } }, h("span", { class: "display", text: "✓", style: { fontSize: "64px", color: "var(--observed)", width: "60px" } }), h("span", { class: "display", text: x, style: { fontSize: "66px" } })), 260, 300 + i * 120));
    hud.append(...three);
    const motif = pos(h("div", { class: "abs display", text: "Git keeps the code. Atelier keeps the record.", style: { fontSize: "84px", width: "1920px", textAlign: "center" } }), 0, 200);
    hud.append(motif);
    const big = bigNumber(f.states.merged, `merged, of ${f.tasks} tasks`, "Atelier built itself this way.", "var(--observed)");
    big.el.style.left = "120px"; big.el.style.top = "330px";
    hud.append(big.el);
    const end = layer();
    end.append(pos(h("div", { class: "abs display", text: "atelier.zone", style: { fontSize: "150px", width: "1920px", textAlign: "center" } }), 0, 300),
      pos(h("div", { class: "abs mono", text: "github.com/pavithran/atelier · MIT licence", style: { fontSize: "44px", width: "1920px", textAlign: "center", color: "var(--signal)" } }), 0, 500),
      pos(h("div", { class: "abs", text: `This film is task t320 in the same ledger · figures as of ${ASOF(data)}`, style: { font: `500 ${FOOT}px var(--font-sans)`, width: "1920px", textAlign: "center", color: "var(--text-muted)" } }), 0, 600));
    el.append(end);
    at3.forEach((k) => c.sfx(k, "tick", 0.7));
    c.sfx(c.cue(1), "swell", 0.7); c.sfx(c.cue(2), "chime", 0.9);
    const tBig = c.when("It built itself"), tEnd = c.cue(2) - 0.2;
    return {
      el,
      update(t) {
        F.at(F.T1, 0.16 + 0.05 * Math.sin(t * 0.8));
        const view = cam.set(t, [[0, F.W / 2, F.MAINY - 80, 0.42], [c.dur, F.W / 2, F.MAINY - 60, 0.46]], 0.5);
        const out = 1 - P(t, c.cue(1) - 0.4, 0.5);
        three.forEach((l, i) => fadeIn(l, P(t, at3[i] - 0.15, 0.4) * out, 14));
        const out2 = 1 - P(t, tEnd - 0.3, 0.4);
        fadeIn(motif, P(t, c.cue(1), 0.6) * out2);
        big.el.style.opacity = P(t, tBig - 0.2, 0.5) * out2; big.update(t, tBig);
        end.style.opacity = P(t, tEnd, 0.6);
        return view;
      },
      tag: () => "",
    };
  };

  const THREE = ["Checks Atelier observed itself", "Approval by another model family", "A record of every agent, kept on Cloudflare"];
  const CHAPTERS = ["Why Git alone isn't enough", "Who does the work", "Nothing merges without proof", "Big goals become plans", "It measures, and it learns", "Who it is for", "It runs on Cloudflare"];
  const SHORT = ["Git alone", "The agents", "Proof", "Plans", "Learning", "Who for", "Cloudflare"];
  // What each chapter's card recalls of the one before it.
  const SO_FAR = [
    "Many agents, one repository: what can you trust?",
    "Git keeps commits; Atelier keeps the record of what it observed.",
    "Four roles, one holder per task, many tasks at once.",
    "Proof first, review by another family, and nothing lost.",
    "Plans, coordination and conflicts, handled by agents.",
    "Every agent measured; a failure traced to its cause.",
    "A new project merged in under a minute; a team gets the same.",
  ];


  // ── the player ──────────────────────────────────────────────────────────
  let built = [], captions = [], sounds = [], chapters = [];
  const capEl = () => document.querySelector("#caption span");
  // Scenes on the light ground in the dark version; the bright version puts
  // every scene on it.
  const LIGHT = new Set(["why", "metrics"]);
  const CHAPTER_OF = { why: 1, cast: 2, gate: 3, stories: 3, plan: 4, metrics: 5, who: 6, cloud: 7 };
  const CARD = { why: 1.7, cast: 1.7, gate: 1.7, plan: 3.0, metrics: 1.7, who: 1.7, cloud: 1.7 };
  let BRIGHT = false;

  async function init(tl, data, theme = "dark") {
    BRIGHT = theme === "bright";
    HEX = BRIGHT ? HEX_LIGHT : HEX_DARK;
    document.body.classList.toggle("bright", BRIGHT);
    for (const spec of ['800 60px "Bricolage Grotesque"', '700 60px "Bricolage Grotesque"', '400 20px "IBM Plex Sans"', '500 20px "IBM Plex Sans"', '600 20px "IBM Plex Sans"', '700 20px "IBM Plex Sans"', '400 20px "IBM Plex Mono"', '500 20px "IBM Plex Mono"', '600 20px "IBM Plex Mono"']) await document.fonts.load(spec);
    await document.fonts.ready;
    const root = document.getElementById("scenes");
    tl.scenes.forEach((sc, i) => {
      const make = SCENES[sc.id];
      if (!make) throw new Error("no scene " + sc.id);
      const caps = sc.cues.flatMap((cue) => cue.captions);
      const ctx = {
        cues: sc.cues,
        cue: (k) => sc.cues[Math.min(k, sc.cues.length - 1)].start,
        cueEnd: (k) => sc.cues[Math.min(k, sc.cues.length - 1)].end,
        when: (phrase) => {
          const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
          const want = norm(phrase);
          for (const cue of sc.cues) {
            let joined = "", at = [];
            (cue.words ?? []).forEach((w, i) => { const n = norm(w.w); for (let j = 0; j < n.length; j++) at.push(i); joined += n; });
            const idx = joined.indexOf(want);
            if (idx >= 0) return cue.start + cue.words[at[idx]].s;
          }
          const k = caps.find((x) => x.text.includes(phrase));
          if (!k) throw new Error(`no words "${phrase}" in ${sc.id}`);
          return k.start;
        },
        dur: sc.dur,
        sfx: (t, type, gain = 1) => sounds.push({ t: sc.start + t, type, gain, scene: sc.id }),
      };
      const wrap = h("div", { class: "scene" + (BRIGHT || LIGHT.has(sc.id) ? " light" : "") });
      root.append(wrap);
      wrap.classList.add("on");
      const scene = make(ctx, data);
      wrap.append(scene.el);
      wrap.classList.remove("on");
      built.push({ sc, wrap, scene, n: i + 1, next: tl.scenes[i + 1]?.id, prev: tl.scenes[i - 1]?.id });
      for (const cue of sc.cues) for (const k of cue.captions) captions.push({ start: sc.start + k.start, end: sc.start + k.end, text: k.text });
    });
    // Each chapter's span on the film's clock, for the bar's progress.
    chapters = CHAPTERS.map((name, i) => {
      const scs = tl.scenes.filter((x) => CHAPTER_OF[x.id] === i + 1);
      return { name, short: SHORT[i], start: scs[0].start, end: scs.at(-1).start + scs.at(-1).dur };
    });
    const bar = document.getElementById("bar");
    bar.innerHTML = chapters.map((ch, i) => `<div class="seg"><div class="lab"><b>${i + 1}</b> ${esc(ch.short)}</div><div class="track"><div class="fill"></div></div></div>`).join("");
    await Promise.all([...document.images].map((im) => im.decode().catch(() => { throw new Error("image failed: " + im.src); })));
  }

  function seek(T) {
    const cur = built.find((b) => T >= b.sc.start && T < b.sc.start + b.sc.dur) ?? built[built.length - 1];
    for (const b of built) b.wrap.classList.toggle("on", b === cur);
    const t = T - cur.sc.start;
    const view = cur.scene.update(t) ?? { cx: 960, cy: 540, s: 1 };
    const D = 0.5;
    const kOut = clamp(1 - (cur.sc.dur - t) / D), kIn = clamp(1 - t / D);
    cur.wrap.style.transform = `scale(${(1 + 0.05 * ease(kOut)) * (1 - 0.04 * ease(kIn))})`;
    cur.wrap.style.filter = kOut + kIn > 0 ? `blur(${3 * (kOut + kIn)}px)` : "";
    const fade = document.getElementById("fade");
    fade.style.background = BRIGHT ? "#f6f4ee" : "#000";
    fade.style.opacity = clamp(Math.max(kOut, kIn) * 0.9 + (T < 0.4 ? 1 - T / 0.4 : 0));
    const light = cur.wrap.classList.contains("light");
    document.getElementById("stage").classList.toggle("on-light", light);
    document.getElementById("bg").style.backgroundPosition = `${(-view.cx * 0.12 * view.s).toFixed(1)}px ${(-view.cy * 0.12 * view.s).toFixed(1)}px`;
    document.getElementById("vignette").style.opacity = light ? 0.25 : 1;
    document.getElementById("grain").querySelector("feTurbulence").setAttribute("seed", String(Math.floor(T * 15) % 97 + 1));
    // The chapter bar: every chapter, the current one lit, with its progress.
    const chN = CHAPTER_OF[cur.sc.id] ?? (cur.sc.id === "close" ? 8 : 0);
    const bar = document.getElementById("bar");
    bar.style.opacity = cur.sc.id === "cold" ? P(t, cur.sc.dur - 1.5, 0.6) : 1;
    [...bar.children].forEach((seg, i) => {
      const ch = chapters[i];
      seg.classList.toggle("now", i + 1 === chN);
      seg.classList.toggle("done", i + 1 < chN);
      seg.querySelector(".fill").style.width = `${100 * clamp((T - ch.start) / (ch.end - ch.start))}%`;
    });
    // The badge of the judged quality, and the source tag.
    const crit = cur.scene.crit ? cur.scene.crit(t) : "";
    const critEl = document.getElementById("crit");
    critEl.textContent = crit;
    critEl.style.opacity = crit ? P(t, 0.3, 0.5) : 0;
    const src = document.getElementById("source");
    const tag = cur.scene.tag ? cur.scene.tag(t) : "";
    src.textContent = tag;
    src.style.opacity = tag ? P(t, 0.3, 0.6) : 0;
    // The chapter card, at each chapter's start: its number and name, and a
    // line of what came before; at the midpoint, the three things again.
    const cardEl = document.getElementById("card");
    const cd = CARD[cur.sc.id];
    if (cd && t < cd + 0.4) {
      const i = chN - 1;
      cardEl.innerHTML = `<div class="num">Chapter ${chN} of 7</div><div class="name">${esc(CHAPTERS[i])}</div><div class="sofar"><b>So far:</b> ${esc(SO_FAR[i])}</div>` +
        (cur.sc.id === "plan" ? `<div class="three">${THREE.map((x) => `<div><span>✓</span>${esc(x)}</div>`).join("")}</div><div class="motif">Git keeps the code. Atelier keeps the record.</div>` : "");
      cardEl.style.display = "flex";
      cardEl.style.opacity = (1 - P(t, cd - 0.15, 0.4));
    } else cardEl.style.display = "none";
    const cap = captions.find((k) => T >= k.start && T < k.end + 0.25);
    capEl().textContent = cap ? cap.text : "";
  }

  window.film = { init, seek, sounds: () => sounds.sort((a, b) => a.t - b.t) };
})();
