// The film's scenes, sixth cut. Each scene is a pure function of time:
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
  const HEX = { anthropic: "#ff8a5b", openai: "#3fe0b0", zai: "#6f9bff", google: "#ff8fcf", deepseek: "#5ad1e6", xiaomi: "#ff9e40", qwen: "#b5e55c", moonshot: "#b48cff", minimax: "#ff9f7a", other: "#8f9cab" };
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
    const main = s("line", { x1: 0, y1: MAINY, x2: W, y2: MAINY, stroke: "#f4f1e8", "stroke-width": 3, opacity: 0.85 });
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
  const SCENES = {};
  const COMPANY = { anthropic: "Anthropic", zai: "Zhipu", openai: "OpenAI", google: "Google", deepseek: "DeepSeek", qwen: "Alibaba", moonshot: "Moonshot", xiaomi: "Xiaomi", other: "other" };
  const LEDGER_SPAN = (data) => `${day(data.facts.firstTaskAt)} to ${day(data.facts.cutoff)} 2026`;
  const ASOF = (data) => `${day(data.facts.cutoff)} 2026, ${utc(data.facts.cutoff)}`;

  // Slides that replace one another in place: each shows over [a, b) with a
  // short cross-fade, so no frame is caught between two pictures.
  function slides(list) {
    const els = [...new Set(list.map((x) => x.el))];
    return (t) => els.forEach((el) => {
      let k = 0, rise = 1;
      for (const { a, b } of list.filter((x) => x.el === el)) {
        const kk = P(t, a - 0.1, 0.45) * (1 - P(t, b - 0.35, 0.4));
        if (kk > k) { k = kk; rise = P(t, a - 0.1, 0.5); }
      }
      el.style.display = k > 0.001 ? "block" : "none";
      el.style.opacity = k;
      el.style.transform = `translateY(${(1 - rise) * 18}px)`;
    });
  }
  const pick = (t, list) => { let v = list[0][1]; for (const [a, x] of list) if (t >= a) v = x; return v; };

  // A real page, cropped to one panel (pre-cut by build into .cache/footage),
  // in a browser frame, with a slow push-in.
  function footage(name, url, note, w, hgt) {
    const img = h("img", { src: `../.cache/footage/${name}.png`, style: { width: w + "px", display: "block", transformOrigin: "50% 40%" } });
    const el = h("div", { class: "browser", style: { left: (1920 - w) / 2 + "px", top: "70px", width: w + "px", height: hgt + 46 + "px" } },
      h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("div", { class: "url", html: url }), note ? h("div", { class: "note", text: note }) : null),
      h("div", { class: "view" }, img));
    return { el, push(t, a, b) { img.style.transform = `scale(${lerp(1, 1.035, clamp((t - a) / Math.max(1, b - a)))})`; } };
  }

  // A terminal: the command typed, then its output line by line.
  function terminal(title, cmd, out, x, y, w, maxLines = 18, cols = 96) {
    const lines = out.replace(/\s+$/, "").split("\n").slice(0, maxLines).map((l) => (l.length > cols ? l.slice(0, cols - 1) + "…" : l));
    const pre = h("pre");
    const el = pos(h("div", { class: "term", style: { width: w + "px" } }, h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("span", { text: title, style: { marginLeft: "12px" } })), pre), x, y);
    return {
      el,
      update(t, a) {
        const typed = Math.floor(clamp((t - a) / 1.2) * cmd.length);
        const shown = t < a + 1.4 ? 0 : Math.min(lines.length, Math.floor((t - a - 1.4) / 0.07) + 1);
        pre.innerHTML = `<span class="prompt">$</span> ${esc(cmd.slice(0, typed))}${typed < cmd.length ? '<span class="cursor"></span>' : ""}\n` + lines.slice(0, shown).map(esc).join("\n");
      },
    };
  }
  // A list of ledger events, one row each: time, what, and a detail.
  function eventRows(rows, x, y, w, rowGap = 14) {
    const el = pos(h("div", { class: "abs", style: { width: w + "px", display: "flex", flexDirection: "column", gap: rowGap + "px" } }), x, y);
    const els = rows.map((r) => {
      const row = h("div", { style: { display: "flex", gap: "26px", alignItems: "flex-start" } },
        h("div", { class: "mono", style: { width: "210px", flex: "none", fontSize: "21px", color: "var(--text-muted)", paddingTop: "3px" }, html: r.time }),
        h("div", { style: { flex: 1 } },
          h("div", { style: { font: "500 26px/1.3 var(--font-sans)", color: r.color ?? "var(--text-bright)" }, html: r.what }),
          r.detail ? h("div", { class: r.quote ? "quote" : "mono", style: r.quote ? { marginTop: "8px", borderLeftColor: r.color ?? "var(--fault)", fontSize: "21px" } : { marginTop: "6px", fontSize: "19px", color: "var(--text-muted)", lineHeight: "1.4" }, html: r.detail }) : null));
      el.append(row);
      return row;
    });
    return { el, els };
  }

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
    c.sfx(SWEEP_B + 0.2, "swell", 1);
    const hud = h("div", { class: "abs", style: { inset: 0 } });
    const date = pos(h("div", { class: "abs mono", style: { fontSize: "24px", color: "var(--signal)", letterSpacing: ".06em" } }), 80, 96);
    const fams = ["anthropic", "zai", "openai", "deepseek", "google"];
    const legend = pos(h("div", { class: "card", style: { padding: "16px 22px", width: "560px", background: "rgba(7,9,12,.82)" } },
      h("div", { class: "mono", style: { fontSize: "20px", color: "var(--text)", lineHeight: "1.45" }, text: "Each line is a task: it rises from main when filed and returns when merged, coloured by the company whose model built it." }),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px 14px", marginTop: "12px" } }, ...fams.map((f) => famChip(f, COMPANY[f]))),
      h("div", { class: "mono", style: { fontSize: "19px", color: "var(--text-muted)", marginTop: "12px" }, html: "<span style='display:inline-block;width:10px;height:10px;border-radius:50%;background:#ff8fcf;margin-right:8px'></span>below main: an approval by another company" })), 80, 150);
    const counter = pos(h("div", { class: "abs" }, h("div", { class: "big-num n", text: "0", style: { fontSize: "88px" } }), h("div", { class: "label", text: "tasks, from Atelier's own ledger" })), 80, 700);
    hud.append(date, legend, counter);
    const title = h("div", { class: "abs display", text: "Atelier", style: { fontSize: "200px", left: "0px", width: "1920px", textAlign: "center", top: "300px", letterSpacing: "-.04em" } });
    const sub = h("div", { class: "abs", text: "A Git platform for many coding agents", style: { left: "0px", width: "1920px", textAlign: "center", top: "560px", font: "500 40px/1.2 var(--font-sans)", color: "var(--signal)" } });
    hud.append(title, sub);
    const head = pos(h("div", { class: "abs label", text: "In this video", style: { fontSize: "22px", color: "var(--signal)" } }), 820, 196);
    hud.append(head);
    const rows = CHAPTERS.map((tx, i) => {
      const r = pos(h("div", { class: "abs", style: { display: "flex", alignItems: "baseline", gap: "24px" } }, h("span", { class: "mono", text: String(i + 1), style: { fontSize: "30px", color: "var(--signal)", width: "26px" } }), h("span", { class: "display", text: tx, style: { fontSize: "50px" } })), 820, 240 + i * 82);
      hud.append(r); return r;
    });
    el.append(hud);
    const tTitle = SWEEP_B + 0.2, tUp = tTitle + 0.9;
    c.sfx(tTitle, "chime", 1);
    rows.forEach((_, i) => c.sfx(tUp + 0.3 + i * 0.22, "tick", 0.6));
    return {
      el,
      update(t) {
        const now = play(t);
        F.at(now, 1 - 0.7 * P(t, tTitle - 0.3, 1.0));
        const k = P(t, 0.8, SWEEP_B - 0.8);
        const cx = lerp(F.X(play(Math.min(t, SWEEP_B))) - 300, F.W / 2, P(t, 1.5, SWEEP_B - 1.2)), cy = lerp(F.MAINY - 420, F.MAINY - 80, k);
        const view = cam.set(t, [[0, cx, cy, lerp(1.2, 0.36, k)]], 0.5);
        date.textContent = new Date(now).toISOString().slice(0, 16).replace("T", "  ") + " UTC";
        date.style.opacity = P(t, 0.3, 0.5) * (1 - P(t, tTitle - 0.4, 0.4));
        legend.style.opacity = P(t, 0.4, 0.5) * (1 - P(t, tTitle - 0.4, 0.4));
        counter.querySelector(".n").textContent = times.filter((x) => x <= now).length;
        counter.style.opacity = P(t, 0.6, 0.6) * (1 - P(t, tTitle - 0.4, 0.4));
        const up = P(t, tUp, 0.9);
        title.style.opacity = P(t, tTitle, 0.6);
        title.style.transform = `translate(${-up * 600}px, ${-up * 110}px) scale(${lerp(1, 0.5, up)})`;
        sub.style.opacity = P(t, tTitle + 0.3, 0.6) * (1 - up);
        head.style.opacity = P(t, tUp + 0.2, 0.4);
        rows.forEach((r, i) => fadeIn(r, P(t, tUp + 0.3 + i * 0.22, 0.4), 14));
        return view;
      },
      tag: (t) => t < tTitle ? `from the ledger · ${LEDGER_SPAN(data)}` : "",
    };
  };

  SCENES.why = (c, data) => {
    const el = h("div");
    const st = data.stories.t278;
    // A: the claim of the whole film.
    const A = h("div", { class: "abs", style: { inset: 0 } });
    A.append(pos(h("div", { class: "abs display", text: "Built by Atelier", style: { fontSize: "120px", width: "1920px", textAlign: "center" } }), 0, 320),
      pos(h("div", { class: "abs mono", text: `every task, review and figure from its own ledger · as of ${ASOF(data)}`, style: { fontSize: "30px", width: "1920px", textAlign: "center", color: "var(--text)" } }), 0, 500));
    // B: what Git can't answer.
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const qs = ["Who held the work?", "Did the tests run?", "Who checked it?"].map((q, i) => { const k = kinetic(q, "kin display", { position: "absolute", left: "160px", top: `${200 + i * 150}px`, fontSize: "92px" }); B.append(k.el); return k; });
    const gitLine = pos(h("div", { class: "abs mono", style: { fontSize: "30px", color: "var(--text-muted)" }, html: "git log: <span style='color:var(--text)'>commits</span>, and none of these answers" }), 166, 690);
    const gitHead = pos(h("div", { class: "abs label", text: "What Git can't tell you", style: { fontSize: "24px" } }), 166, 130);
    B.append(gitLine, gitHead);
    // C: the agent's message beside the ledger's record.
    const C = h("div", { class: "abs", style: { inset: 0 } });
    const ttl = h("div", { class: "abs display", text: "A commit message, and a record", style: { left: "120px", top: "90px", fontSize: "64px" } });
    const left = pos(h("div", { class: "card", style: { padding: "20px 24px", width: "700px", height: "660px" } },
      h("div", { class: "label", text: "git log -1 de67194 · written by the agent", style: { color: "var(--fault)" } }),
      h("pre", { class: "mono", style: { fontSize: "22px", lineHeight: "1.55", whiteSpace: "pre-wrap", margin: "16px 0 0", color: "var(--text)" }, text: data.terminal.commit.replace(/^commit (\w{12})\w+/, "commit $1…") }),
      h("div", { class: "mono claims", style: { fontSize: "21px", marginTop: "24px", lineHeight: "1.75", color: "var(--text-muted)" }, html: "no head it was checked at<br>no test results<br>no reviewer, no rejections<br>nothing verifies the author line" })), 120, 200);
    const L = st.landing;
    const evLine = (e) => {
      const who = e.actor === "pavi" ? "the lead developer" : nice(e.actor);
      const what = { "push.observed": `pushed head ${e.head}, read from Artifacts`, "evidence.observed": `checks observed passing at ${e.head}`, "review.rejected": "rejected, with blocking findings", "review.approved": "approved", "item.merged": `merged as ${e.mergeCommit}` }[e.kind];
      return what ? `<span class="dim">${utc(e.at, true).replace(" UTC", "")}</span>  <span style="color:${e.kind === "review.rejected" ? "var(--fault)" : e.kind === "review.approved" || e.kind === "item.merged" ? "var(--observed)" : "var(--text)"}">${esc(who)}</span> ${esc(what)}` : null;
    };
    const claimed = st.events.find((e) => e.kind === "item.claimed");
    const seen = new Set();
    const lines = [`<span class="dim">${utc(claimed.at, true).replace(" UTC", "")}</span>  <span style="color:var(--text)">${esc(nice(claimed.actor))}</span> claimed the task`,
      ...L.filter((e) => { if (e.kind === "evidence.observed") { if (seen.has(e.head)) return false; seen.add(e.head); } return true; }).map(evLine).filter(Boolean)];
    const right = pos(h("div", { class: "card", style: { padding: "20px 24px", width: "940px", height: "660px", borderColor: "var(--observed-line)" } },
      h("div", { class: "label", text: "t278 in the ledger · written by the server, from what it observed", style: { color: "var(--observed)" } }),
      h("div", { class: "mono", style: { fontSize: "20px", lineHeight: "1.72", marginTop: "14px" } }, ...lines.map((x) => h("div", { class: "ev", html: x })))), 860, 200);
    C.append(ttl, left, right);
    // D: the note on the merge, read with git.
    const D = h("div", { class: "abs", style: { inset: 0, background: "rgba(7,9,12,.0)" } });
    const term = terminal("the lead developer's checkout of atelier · read-only", "git notes --ref=atelier show 5af22431", data.terminal.noteFull, 160, 90, 1600, 22, 118);
    D.append(term.el);
    el.append(A, B, C, D);
    const tB = c.cue(1), tC = c.when("A commit message"), tD = c.when("It even copies");
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: tD }, { el: D, a: tD, b: 1e9 }]);
    c.sfx(tC - 0.3, "whoosh", 0.5); c.sfx(c.cue(2), "swell", 0.5); c.sfx(tD, "whoosh", 0.5);
    return {
      el,
      update(t) {
        show(t);
        qs.forEach((k, i) => k.update(P(t, c.when(["who held", "whether the tests", "or who checked"][i]) - 0.2, 0.8)));
        gitLine.style.opacity = P(t, c.when("or who checked") + 1.0, 0.5);
        fadeIn(left, P(t, tC, 0.5));
        left.querySelector(".claims").style.opacity = P(t, tC + 1.6, 0.5);
        fadeIn(right, P(t, c.cue(2), 0.5));
        [...right.querySelectorAll(".ev")].forEach((x, i) => fadeIn(x, P(t, c.cue(2) + 0.3 + i * 0.25, 0.3), 6));
        term.update(t, tD + 0.2);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tC - 0.1 ? "" : t < tD - 0.1 ? `from the ledger: t278 · ${day(st.mergedAt)} 2026` : `real terminal output · ${day(data.facts.cutoff)} 2026`,
      crit: (t) => t >= tD - 0.1 ? "context preservation" : "",
    };
  };

  SCENES.cast = (c, data) => {
    const el = h("div");
    const svg = svgFull(); el.append(svg);
    const f = data.facts;
    const named = (m, n, unit) => h("span", { class: "chip", style: { color: col(fam(m)), fontSize: "19px" } }, h("span", { class: "dot" }), `${NAMES[m] ?? m} · ${COMPANY[fam(m)]}${n != null ? ` · ${n}` : ""}`);
    const builders = Object.entries(f.mergedByFinalBuilder).sort((a, b) => b[1] - a[1]);
    const topB = builders.slice(0, 6), restB = builders.slice(6);
    const reviewers = Object.entries(f.reviewsByModel).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const X = [60, 525, 990, 1455], W = 405, TOP = 110;
    const box = (i, name, what, kids, hh) => {
      const b = pos(h("div", { class: "card", style: { padding: "18px 20px", width: W + "px", height: hh + "px" } },
        h("div", { class: "display", text: name, style: { fontSize: "40px" } }),
        h("div", { class: "mono", html: what, style: { fontSize: "19px", color: "var(--text-muted)", marginTop: "8px", lineHeight: "1.4" } }),
        h("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px", marginTop: "14px" } }, ...kids)), X[i], TOP);
      el.append(b); return b;
    };
    const planner = box(0, "Planner", "an agent; splits a goal into parts", [named(data.plan.planner.split("/").pop(), null), h("span", { class: "mono", text: "planned t197", style: { fontSize: "18px", color: "var(--text-muted)" } })], 515);
    const handNote = h("span", { class: "mono", text: `hands change only by a recorded handoff: ${f.handoffs} so far`, style: { fontSize: "17px", color: "var(--signal)", lineHeight: "1.35", marginTop: "2px" } });
    const builderBox = box(1, "Builders", "agents at work at once, each in its own fork · merged tasks built", [...topB.map(([m, n]) => named(m, n)), h("span", { class: "mono", text: `and ${restB.length} more`, style: { fontSize: "18px", color: "var(--text-muted)" } }), handNote], 515);
    const reviewerBox = box(2, "Reviewer", "an agent of another family than every builder · reviews done", reviewers.map(([m, n]) => named(m, n)), 515);
    const lead = box(3, "Lead developer", "the one human", [h("span", { class: "mono", html: "approves plans<br>merges", style: { fontSize: "24px", color: "var(--signal)", lineHeight: "1.5" } })], 515);
    const boxes = [planner, builderBox, reviewerBox, lead];
    const arrows = [0, 1, 2].map((i) => {
      const x1 = X[i] + W, x2 = X[i + 1], y = TOP + 70;
      const p = s("path", { d: `M ${x1 + 4} ${y} L ${x2 - 6} ${y}`, stroke: "var(--signal)", "stroke-width": 3, fill: "none" });
      const head = s("path", { d: `M ${x2 - 16} ${y - 9} L ${x2 - 4} ${y} L ${x2 - 16} ${y + 9}`, stroke: "var(--signal)", "stroke-width": 3, fill: "none" });
      svg.append(p, head);
      return { p, head, b: beads(svg, `M ${x1} ${y} L ${x2} ${y}`, "#ffd166", 1, 5) };
    });
    const ledger = pos(h("div", { class: "card", style: { padding: "14px 24px", width: "1800px", borderColor: "var(--wire)", display: "flex", alignItems: "baseline", gap: "24px" } },
      h("span", { style: { font: "700 30px/1.2 var(--font-display)" }, text: "the ledger" }), h("span", { class: "mono", text: "records every step, written by Atelier from what it observed", style: { fontSize: "21px", color: "var(--text-muted)" } })), 60, 655);
    const famDef = pos(h("div", { class: "abs mono", html: "<span style='color:var(--signal)'>family</span>: the company that made the model, as Anthropic made Opus 5.5 and Google made Gemini 3.1 Pro", style: { fontSize: "23px", color: "var(--text)" } }), 60, 765);
    el.append(ledger, famDef);
    const T = [c.when("A planner agent"), c.when("Builders work"), c.when("A reviewer checks"), c.when("The lead developer")];
    T.forEach((x) => c.sfx(x - 0.05, "chime", 0.3));
    // B: concurrency, and how far it goes.
    const A = h("div", { class: "abs", style: { inset: 0 } });
    A.append(...el.childNodes);
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const pk = data.peak;
    B.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: `the most tasks held at once in this ledger · ${day(pk.at)} 2026, ${utc(pk.at, true)}` }), h("div", { class: "display", text: `${pk.held.length} tasks held at once`, style: { fontSize: "58px", marginTop: "8px" } })), 120, 90));
    const peakChips = pos(h("div", { class: "abs", style: { display: "grid", gridTemplateColumns: "repeat(3, 250px)", gap: "12px 14px", width: "800px" } },
      ...pk.held.map((x) => h("span", { class: "chip", style: { color: col(fam(x.actor)), fontSize: "19px", justifyContent: "flex-start" } }, h("span", { class: "dot" }), `${x.id} · ${nice(x.actor)}`))), 120, 250);
    const scale = [["One fork per task", "each task is its own Git repository in Artifacts, written only with that workspace's token"], ["One Durable Object per project", "each project's ledger takes its own requests, apart from every other project's"], ["Runners, as many as are started", "each runner claims jobs from the queue and runs checks in its own clean clone"], ["One landing on main at a time", "a lease per project; a plan's parts meet first on the plan's own branch"]];
    const scaleEls = scale.map(([a, b2], i) => pos(h("div", { class: "card", style: { padding: "14px 20px", width: "860px" } }, h("div", { style: { font: "600 26px/1.25 var(--font-sans)", color: "var(--text-bright)" }, text: a }), h("div", { class: "mono", text: b2, style: { fontSize: "19px", color: "var(--text-muted)", marginTop: "6px" } })), 960, 230 + i * 126));
    B.append(peakChips, ...scaleEls, pos(h("div", { class: "abs mono", text: "Not measured beyond this ledger's own peak.", style: { fontSize: "21px", color: "var(--signal)" } }), 960, 742));
    el.append(A, B);
    const tConc = c.cue(2);
    const showAB = slides([{ el: A, a: 0, b: tConc }, { el: B, a: tConc, b: 1e9 }]);
    c.sfx(tConc - 0.2, "whoosh", 0.5);
    return {
      el,
      crit: (t) => t >= tConc - 0.1 ? "concurrency" : "",
      update(t) {
        showAB(t);
        [...peakChips.children].forEach((x, i) => pop(x, P(t, c.when("its own fork in") - 0.3 + i * 0.06, 0.35), 0.8));
        scaleEls.forEach((x, i) => fadeIn(x, P(t, [c.when("its own fork in"), c.when("its own Durable Object"), c.when("as many runners"), c.when("only landing on main")][i] - 0.2, 0.45), 10));
        boxes.forEach((b, i) => pop(b, P(t, T[i] - 0.15, 0.5), 0.85));
        arrows.forEach((a, i) => { const k = P(t, T[i + 1] - 0.2, 0.5); a.p.style.opacity = k; a.head.style.opacity = k; a.b.update(t, T[i + 1] + 0.3, 1.6, k); });
        handNote.style.opacity = P(t, c.when("recorded handoff") - 0.2, 0.4);
        fadeIn(ledger, P(t, 0.3, 0.6));
        fadeIn(famDef, P(t, c.when("a family being") - 0.2, 0.5));
        ledger.style.boxShadow = `0 0 ${24 + 14 * Math.sin(t * 2.2)}px rgba(255,209,102,.25), 0 20px 60px rgba(0,0,0,.45)`;
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: () => `from the ledger · ${LEDGER_SPAN(data)}`,
    };
  };

  SCENES.gate = (c, data) => {
    const st = data.stories.t278;
    const el = h("div");
    // A: the gate.
    const A = h("div", { class: "abs", style: { inset: 0 } });
    const sA = svgFull(); A.append(sA);
    const q0 = kinetic("The gate", "kin display", { position: "absolute", left: "150px", top: "170px", fontSize: "110px" });
    A.append(q0.el);
    const nodes = [["pushed head", "the latest commit, read from Artifacts", 120], ["clean clone", "of exactly that head, on the lead developer's machine", 480], ["required checks", "recorded by Atelier as it saw them", 840], ["review", "by another family", 1200], ["lead developer", "merges", 1560]].map(([a, b, x]) => {
      const n = pos(h("div", { class: "card", style: { padding: "16px 20px", width: "320px", height: "150px" } }, h("div", { style: { font: "600 27px/1.2 var(--font-sans)" }, text: a }), h("div", { class: "mono", text: b, style: { fontSize: "19px", marginTop: "8px", color: "var(--text-muted)", lineHeight: "1.35" } })), x, 420);
      A.append(n); return n;
    });
    const edges = [0, 1, 2, 3].map((i) => beads(sA, `M ${[440, 800, 1160, 1520][i]} 485 L ${[480, 840, 1200, 1560][i]} 485`, "#ffd166", 1, 6));
    const obsTag = pos(h("div", { class: "abs stamp", text: "Observed", style: { color: "var(--observed)", fontSize: "24px" } }), 860, 590);
    const repTag = pos(h("div", { class: "abs mono", html: "an agent's own word → <b style='color:var(--text-muted)'>Reported</b>: shown, never counted", style: { fontSize: "23px", color: "var(--text-muted)" } }), 120, 700);
    const contTag = pos(h("div", { class: "abs mono", html: "checks inside a Cloudflare Container: built, not yet proven", style: { fontSize: "21px", color: "var(--text-dim)" } }), 120, 760);
    A.append(obsTag, repTag, contTag);
    // B: t278, from the ledger.
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const L = st.landing;
    const header = pos(h("div", { class: "abs" },
      h("div", { class: "label", text: `Task t278 · ${day(st.mergedAt)} 2026 · built by` }),
      h("div", { style: { display: "flex", alignItems: "center", gap: "22px", marginTop: "10px" } },
        h("div", { class: "display", text: "Pull AI Gateway's logs", style: { fontSize: "54px" } }), chip(st.builders[0]))), 120, 92);
    B.append(header);
    const pushes = L.filter((e) => e.kind === "push.observed");
    const rounds = pushes.map((p) => ({ head: p.head, pushedAt: p.at, checks: L.filter((e) => e.kind === "evidence.observed" && e.head === p.head), review: st.reviews.find((r) => r.head === p.head) }));
    const COLS = [120, 470, 940, 1340];
    const colHead = ["Head pushed", "Required checks, clean clone", "Review, another family", "Verdict"].map((x, i) => pos(h("div", { class: "abs label", text: x }), COLS[i], 236));
    B.append(...colHead);
    const rows = rounds.map((r, i) => {
      const y = 280 + i * 104;
      const head = pos(h("div", { class: "abs mono", style: { fontSize: "22px" }, html: `<span style="color:var(--text-bright)">${r.head}</span><br><span style="color:var(--text-muted)">${utc(r.pushedAt, true)}</span>` }), COLS[0], y);
      const checks = pos(h("div", { class: "abs mono", style: { fontSize: "20px", lineHeight: "1.5" } }, ...r.checks.map((ck) => h("div", { html: `<span style="color:var(--observed)">✓ observed</span> <span style="color:var(--text-muted)">${esc(ck.claim.split("&&").pop().trim())}</span>` }))), COLS[1], y);
      const rev = pos(h("div", { class: "abs" }, chip(r.review.by)), COLS[2], y + 6);
      const verdict = pos(h("div", { class: "abs" }, h("span", { class: "stamp", text: r.review.approve ? "approved" : "rejected", style: { color: r.review.approve ? "var(--observed)" : "var(--fault)" } }), h("span", { class: "mono", text: "  " + utc(r.review.at, true), style: { fontSize: "19px", color: "var(--text-muted)" } })), COLS[3], y + 2);
      B.append(head, checks, rev, verdict);
      const ring = pulseRing(B, COLS[3] + 90, y + 24, r.review.approve ? "var(--observed)" : "var(--fault)");
      return { head, checks, rev, verdict, ring };
    });
    const panel = (...kids) => { const p = pos(h("div", { class: "abs" }, ...kids), 120, 610, 1680); B.append(p); return p; };
    const findingsPanel = (r, title, verdicts) => panel(
      h("div", { class: "label", text: title }),
      h("div", { style: { display: "grid", gridTemplateColumns: `repeat(${r.review.findings.filter((f) => f.severity === "blocking").length}, 1fr)`, gap: "40px", marginTop: "14px" } },
        ...r.review.findings.filter((f) => f.severity === "blocking").map((f, i) => h("div", { class: "quote", style: { fontSize: "21px" }, html: `“${quoteHtml(f.text)}”<span class="src">${esc(f.file)}:${f.line} · blocking<span class="vd" style="color:var(--observed)">${verdicts[i] ? " · the lead developer's verdict: " + esc(verdicts[i].verdict) : ""}</span></span>` }))));
    const vAt = (head, idx) => st.verdicts.filter((v) => v.head === head).sort((a, b) => a.index - b.index);
    const pF1 = findingsPanel(rounds[0], `Gemini 3.1 Pro's blocking findings at ${rounds[0].head}, quoted`, vAt(rounds[0].head));
    const pF2 = findingsPanel(rounds[1], `Its finding at ${rounds[1].head}, quoted`, vAt(rounds[1].head));
    const acc = L.find((e) => e.kind === "item.accepted"), mer = L.find((e) => e.kind === "item.merged");
    const last = rounds.at(-1);
    const ttApproved = (Date.parse(mer.at) - Date.parse(last.review.at)) / 1000;
    const pMerge = panel(h("div", { class: "label", text: "The end of the landing, from the ledger" }),
      h("div", { class: "mono", style: { fontSize: "25px", marginTop: "16px", lineHeight: "1.65" }, html:
        `<span style="color:var(--observed)">review.approved</span>&nbsp;&nbsp;${esc(nice(last.review.by))}&nbsp;&nbsp;<span style="color:var(--text-muted)">${utc(last.review.at, true)}</span><br>` +
        `<span style="color:var(--signal)">item.accepted</span>&nbsp;&nbsp;&nbsp;&nbsp;head ${last.head}&nbsp;&nbsp;<span style="color:var(--text-muted)">${utc(acc.at, true)}</span><br>` +
        `<span style="color:var(--main-line)">item.merged</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;as ${mer.mergeCommit}&nbsp;&nbsp;<span style="color:var(--text-muted)">${utc(mer.at, true)}</span><br>` +
        `<span style="color:var(--signal)">${Math.round(ttApproved)} s from approval to merge</span>` }));
    // C, D: the live page.
    const C = h("div", { class: "abs", style: { inset: 0 } }), D = h("div", { class: "abs", style: { inset: 0 } });
    const url = "atelier.zone<b>/p/atelier/t278</b>";
    const fThread = footage("t278-thread", url, "the live page · captured 8 October 2026", 1600, Math.round(1600 * 380 / 1740));
    const fRev = footage("t278-reviews", url, "the live page · captured 8 October 2026", 1600, Math.round(1600 * 720 / 1740));
    C.append(fThread.el, pos(h("div", { class: "abs mono", style: { fontSize: "22px", color: "var(--text)", width: "1600px", lineHeight: "1.5" }, html: "Its Thread: <span style='color:var(--fault)'>the two send-backs</span> (red rings) on t278's line, then the merge into main as 5af2243. Times in New York time (UTC−4)." }), 160, 560));
    D.append(fRev.el, pos(h("div", { class: "abs mono", style: { fontSize: "20px", color: "var(--text-muted)", width: "1600px" }, text: "“Agent's machine”: the runner on the lead developer's Mac, which ran each check in a clean clone of the head." }), 160, 840));
    el.append(A, B, C, D);
    const tint = h("div", { class: "abs tint", style: { inset: 0, pointerEvents: "none" } });
    el.append(tint);
    const tB = c.cue(1), tC = c.cue(2), tD = c.cue(2) + 3.0;
    const tRej = c.when("Gemini rejected it twice"), tDrop = c.when("then one bad log"), tFixed = c.when("All four findings"), tThird = c.when("the third head");
    const R = [
      { head: tB + 0.6, checks: tB + 1.0, rev: tRej - 0.2, verdict: tRej + 0.6 },
      { head: tDrop - 0.6, checks: tDrop - 0.3, rev: tDrop - 0.1, verdict: tDrop + 0.5 },
      { head: tFixed + 0.2, checks: tFixed + 0.6, rev: tFixed + 1.0, verdict: tThird + 0.3 },
    ];
    R.forEach((r, i) => c.sfx(r.verdict, i < 2 ? "reject" : "approve", 1));
    c.sfx(tB - 0.3, "whoosh", 0.6); c.sfx(tC - 0.2, "whoosh", 0.5);
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: tD }, { el: D, a: tD, b: 1e9 }]);
    return {
      el,
      update(t) {
        show(t);
        q0.update(P(t, 0.1, 0.9));
        nodes.forEach((n, i) => pop(n, P(t, 0.3 + i * 0.25, 0.4), 0.85));
        edges.forEach((e, i) => e.update(t, 0.6 + i * 0.25, 0.9, 1));
        pop(obsTag, P(t, c.when("Atelier records") - 0.1, 0.4), 1.4);
        fadeIn(repTag, P(t, c.when("never the agent") - 0.1, 0.5));
        fadeIn(contTag, P(t, c.when("never the agent") + 0.6, 0.5));
        fadeIn(header, P(t, tB, 0.6));
        colHead.forEach((x, i) => fadeIn(x, P(t, tB + 0.2 + i * 0.1, 0.4), 8));
        rows.forEach((r, i) => {
          fadeIn(r.head, P(t, R[i].head, 0.5), 10);
          [...r.checks.children].forEach((x, j) => fadeIn(x, P(t, R[i].checks + j * 0.4, 0.4), 6));
          fadeIn(r.rev, P(t, R[i].rev, 0.5), 10);
          const k = P(t, R[i].verdict, 0.35);
          r.verdict.style.opacity = k; r.verdict.style.transform = `scale(${lerp(1.6, 1, k)})`; r.verdict.style.transformOrigin = "0 50%";
          r.ring.update(t, R[i].verdict);
        });
        const wash = (a) => Math.max(0, 1 - Math.abs(t - a - 0.25) / 0.7) * (t > a ? 1 : 0);
        const red = Math.max(wash(R[0].verdict), wash(R[1].verdict)), green = wash(R[2].verdict);
        tint.style.boxShadow = red > 0 ? `inset 0 0 ${240 * red}px rgba(255,77,116,${0.55 * red})` : green > 0 ? `inset 0 0 ${240 * green}px rgba(95,224,143,${0.5 * green})` : "none";
        const win = (p, a, b) => { p.style.display = t >= a && t < b + 0.4 ? "block" : "none"; p.style.opacity = P(t, a, 0.5) * (1 - P(t, b, 0.4)); };
        win(pF1, R[0].verdict + 0.4, tDrop - 0.1);
        [...pF1.querySelectorAll(".vd")].forEach((x) => { x.style.opacity = P(t, tFixed, 0.4); });
        win(pF2, tDrop + 0.6, tThird);
        [...pF2.querySelectorAll(".vd")].forEach((x) => { x.style.opacity = P(t, tFixed, 0.4); });
        win(pMerge, tThird + 0.2, 1e9);
        fThread.push(t, tC, tD); fRev.push(t, tD, c.dur);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tB - 0.1 ? "" : t < tC - 0.1 ? `from the ledger: t278 · ${day(st.mergedAt)} 2026` : "the live page of t278 · 8 October 2026",
      crit: () => "review",
    };
  };

  SCENES.stories = (c, data) => {
    const el = h("div");
    const s283 = data.stories.t283, s296 = data.stories.t296, s219 = data.stories.t219;
    const ev = (st, kind, pred = () => true) => st.events.find((e) => e.kind === kind && pred(e));
    const dt = (iso) => `${day(iso).replace(" October", " Oct")} · ${utc(iso, true).replace(" UTC", "")}`;
    // A: t283 and t296.
    const A = h("div", { class: "abs", style: { inset: 0 } });
    A.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: "t283 and t296 · times in UTC" }), h("div", { style: { display: "flex", gap: "20px", alignItems: "center", marginTop: "8px" } }, h("div", { class: "display", text: "A 524-line Browser Rendering check, by", style: { fontSize: "50px" } }), chip("opencode/glm-5.3"))), 120, 80));
    const rel = ev(s283, "item.released", (e) => /timed out/.test(e.note ?? ""));
    const rej = s283.reviews.find((r) => !r.approve), app = s283.reviews.find((r) => r.approve), mer = ev(s283, "item.merged");
    const f283 = rej.findings.find((f) => f.severity === "blocking");
    const t296c = data.selfTasks.t296, m296 = ev(s296, "item.merged");
    const recovered = t296c.title.match(/was recovered only from a patch the orchestrator had saved/)[0];
    const rowsA = eventRows([
      { time: dt(rel.at), what: `the run ends: <span style="color:var(--fault)">“${esc(rel.note)}”</span>; the runner claims it back and resets the workspace` },
      { time: dt(t296c.createdAt), what: "t296 filed", detail: `“…GLM's t283 (524 lines, its tests passing) was deleted when home:mbp-2 reclaimed the task, and ${esc(recovered)}.”` },
      { time: dt(rej.at), what: `rejected by <span style="color:${col("anthropic")}">Opus 5.5</span> at ${rej.head}`, detail: `“${quoteHtml(f283.text)}”<span class="src">${esc(f283.file)}:${f283.line} · blocking</span>`, quote: true, color: "var(--fault)" },
      { time: dt(m296.at), what: "t296 merged: the runner keeps uncommitted work before it resets", color: "var(--observed)" },
      { time: dt(app.at), what: `approved by <span style="color:${col("google")}">Gemini 3.1 Pro</span> at ${app.head}; merged ${utc(mer.at, true)} as ${mer.mergeCommit}`, color: "var(--observed)" },
    ], 120, 210, 1680, 18);
    A.append(rowsA.el);
    const tA = [c.when("A runner's time limit"), c.when("a saved patch"), c.cue(2), c.when("fixed that night"), c.when("Gemini approved")];
    // CTX: context preservation.
    const X = h("div", { class: "abs", style: { inset: 0 } });
    const fct = data.facts;
    X.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: `the ledger, ${LEDGER_SPAN(data)} · as of ${utc(fct.cutoff)}` }), h("div", { class: "display", text: "Nothing lives only in an agent's session", style: { fontSize: "56px", marginTop: "8px" } })), 120, 80));
    const ctx = [
      ["The ledger", `every claim, handoff, check and review, written by Atelier: ${fct.claims} claims, ${fct.handoffs} handoffs, ${fct.observedChecks.toLocaleString("en-GB")} observed checks, ${fct.modelReviews} reviews`, "every claim"],
      ["Briefs", "a rework brief carries the review's findings, or the failing check's output, to the next run", "a rework brief"],
      ["Rescued work", "before a runner resets a workspace, it saves uncommitted work under refs/atelier/rescue/ (t296)", "the findings to fix"],
      ["Provenance in Git", "a note on each merge holds the task's record: git notes --ref=atelier show", "each merge carries"],
    ];
    const ctxEls = ctx.map(([a, b2], i) => pos(h("div", { class: "card", style: { padding: "16px 22px", width: "1680px" } }, h("div", { style: { font: "600 28px/1.25 var(--font-sans)", color: "var(--text-bright)" }, text: a }), h("div", { class: "mono", text: b2, style: { fontSize: "21px", color: "var(--text-muted)", marginTop: "6px" } })), 120, 220 + i * 140));
    X.append(...ctxEls);
    el.append(X);
    // B: t219.
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const r219 = s219.reviews.find((r) => !r.approve), a219 = s219.reviews.find((r) => r.approve), m219 = ev(s219, "item.merged");
    const f219 = r219.findings.find((x) => x.severity === "blocking");
    B.append(pos(h("div", { class: "abs" },
      h("div", { class: "label", text: `t219 · ${day(r219.at)} 2026 · times in UTC` }),
      h("div", { class: "display", text: "A leak, caught in review", style: { fontSize: "60px", marginTop: "10px" } }),
      h("div", { class: "mono", style: { fontSize: "22px", color: "var(--text-muted)", marginTop: "18px", lineHeight: "1.5" }, html: `built by <span style="color:${col("google")}">Gemini 3.1 Pro</span>; seven tests failed at its first head, with main merged in, so <span style="color:${col("zai")}">GLM-5.3</span> reworked it · rejected by <span style="color:${col("anthropic")}">Opus 5.5</span> at ${r219.head}, ${utc(r219.at)}` }),
      h("div", { class: "quote", style: { marginTop: "26px", width: "1640px", fontSize: "25px" }, html: `“${quoteHtml(f219.text.split(/(?<=;)\s/)[0])}”<span class="src">${esc(f219.file)}:${f219.line} · blocking</span>` }),
      h("div", { class: "mono", style: { fontSize: "23px", marginTop: "28px", color: "var(--observed)", width: "1640px", lineHeight: "1.5" }, text: `fixed by GLM-5.3: every signed-out /p/ path now redirects alike · approved by Opus 5.5 at ${a219.head}, ${utc(a219.at)} · merged as ${m219.mergeCommit}` })), 120, 120));
    // C: the numbers.
    const C = h("div", { class: "abs", style: { inset: 0 } });
    const f = data.facts, fv = f.findingVerdicts, real = (fv.confirmed ?? 0) + (fv.fixed ?? 0), wrong = fv.refuted ?? 0, judged = real + wrong;
    const bar = (parts) => h("div", { style: { display: "flex", width: "1680px", height: "40px", borderRadius: "8px", overflow: "hidden", marginTop: "14px", background: "var(--inset)" } }, ...parts.map(([w, color]) => h("div", { class: "bar", style: { width: `${w * 100}%`, background: color } })));
    const sends = h("div", {},
      h("div", { style: { display: "flex", alignItems: "baseline", gap: "24px" } }, h("span", { class: "big-num", text: String(f.modelRejections), style: { fontSize: "96px", color: "var(--fault)" } }), h("span", { class: "display", text: `send-backs in ${f.modelReviews} reviews by agents`, style: { fontSize: "40px" } }), h("span", { class: "mono", text: `${Math.round(100 * f.modelRejections / f.modelReviews)} %`, style: { fontSize: "28px", color: "var(--text-muted)" } })),
      bar([[f.modelRejections / f.modelReviews, "var(--fault)"]]));
    const judgedEl = h("div", { style: { marginTop: "40px" } },
      h("div", { style: { display: "flex", alignItems: "baseline", gap: "24px" } }, h("span", { class: "big-num", text: String(real), style: { fontSize: "96px", color: "var(--observed)" } }), h("span", { class: "display", text: `real defects, of ${judged} Gemini findings judged`, style: { fontSize: "40px" } }), h("span", { class: "mono", text: `${wrong} did not hold up`, style: { fontSize: "28px", color: "var(--fault)" } })),
      bar([[real / judged, "var(--observed)"], [wrong / judged, "var(--fault)"]]),
      h("div", { class: "mono", style: { fontSize: "20px", color: "var(--text-muted)", marginTop: "10px", width: "1680px", lineHeight: "1.45" }, text: `the lead developer's verdicts, against the code: ${fv.confirmed} confirmed, ${fv.fixed} fixed, ${wrong} refuted · every judged finding so far is Gemini 3.1 Pro's, the reviewer of most changes` }));
    const ov = data.overrides, lw = f.lastMergeWithoutCrossApproval;
    const since = data.tasks.filter((t) => t.state === "merged" && t.kind !== "plan" && t.mergedAt > lw.at);
    const waiver = h("div", { class: "card", style: { position: "relative", marginTop: "40px", padding: "16px 22px", width: "1680px" } },
      h("div", { class: "mono", style: { fontSize: "21px", lineHeight: "1.55", color: "var(--text)" }, html: `On ${day(ov[0].at)} the lead developer waived the family rule ${ov.length} times (${ov.map((o) => o.id).sort((a, b) => a.slice(1) - b.slice(1)).join(", ")}), each recorded as <span style="color:var(--signal)">review.overridden</span>.<br>The last merge without another family's approval was ${lw.id}, ${utc(lw.at)} on ${day(lw.at)}; all ${since.length} tasks merged since had one.` }));
    C.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: `the ledger, ${LEDGER_SPAN(data)} · as of ${utc(f.cutoff)}` }), h("div", { style: { marginTop: "22px" } }, sends, judgedEl, waiver)), 120, 110));
    el.append(A, B, C);
    const tX = c.cue(1), tB = c.cue(3), tC = c.cue(4);
    const show = slides([{ el: A, a: 0, b: tX }, { el: X, a: tX, b: c.cue(2) }, { el: A, a: c.cue(2), b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: 1e9 }]);
    c.sfx(c.cue(2) + 0.2, "reject", 0.9); c.sfx(tX - 0.2, "whoosh", 0.5); c.sfx(tA[4] + 0.2, "approve", 0.8); c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC - 0.2, "whoosh", 0.5);
    return {
      el,
      update(t) {
        show(t);
        rowsA.els.forEach((r, i) => fadeIn(r, P(t, tA[i] - 0.15, 0.5), 10));
        ctxEls.forEach((x, i) => fadeIn(x, P(t, (i === 0 ? tX + 0.3 : c.when(ctx[i][2])) - 0.2, 0.5), 10));
        [...sends.querySelectorAll(".bar")].forEach((x) => { x.style.transformOrigin = "0 50%"; x.style.transform = `scaleX(${P(t, tC + 0.4, 0.9)})`; });
        [...judgedEl.querySelectorAll(".bar")].forEach((x, i) => { x.style.transformOrigin = "0 50%"; x.style.transform = `scaleX(${P(t, c.when("30 were real") + i * 0.6, 0.8)})`; });
        fadeIn(judgedEl, P(t, c.when("has judged 52") - 0.2, 0.5));
        fadeIn(waiver, P(t, c.when("which is why") - 0.2, 0.5));
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t >= tX - 0.1 && t < c.cue(2) - 0.1 ? `from the ledger · ${LEDGER_SPAN(data)}` : t < tB - 0.1 ? `from the ledger: t283, t296 · ${day(rel.at)} 2026` : t < tC - 0.1 ? `from the ledger: t219 · ${day(r219.at)} 2026` : `from the ledger · ${LEDGER_SPAN(data)}`,
      crit: (t) => t < tX - 0.1 ? "context preservation" : t < c.cue(2) - 0.1 ? "context preservation" : "review",
    };
  };

  SCENES.plan = (c, data) => {
    const pl = data.plan;
    const el = h("div");
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const tCreated = data.tasks.find((t) => t.id === "t197").createdAt;
    const goal = pos(h("div", { class: "card", style: { padding: "18px 24px" } },
      h("div", { class: "label", text: `Plan t197 · the lead developer's goal · ${day(tCreated)} 2026, ${utc(tCreated)}` }),
      h("div", { style: { font: "500 26px/1.4 var(--font-sans)", marginTop: "8px", color: "var(--text-bright)" }, text: pl.goal.slice(0, 160).replace(/\s+\S*$/, "") + " …" })), 120, 80, 1680);
    const planner = pos(h("div", { class: "abs", style: { display: "flex", gap: "12px", alignItems: "center" } }, h("span", { class: "label", text: "planner" }), chip(pl.planner), h("span", { class: "mono", text: `proposed ${pl.proposed.length} parts · ${utc(pl.proposedAt)}`, style: { fontSize: "20px", color: "var(--text-muted)" } })), 120, 236);
    const approve = pos(h("div", { class: "abs", style: { textAlign: "right" } }, h("span", { class: "stamp", text: `approved ${utc(pl.approvedAt)}`, style: { color: "var(--signal)", fontSize: "22px" } }), h("div", { class: "mono", text: `once, by the hash of that proposal: ${pl.hash.slice(0, 12)}…`, style: { fontSize: "19px", marginTop: "8px", color: "var(--text-muted)" } })), 1200, 220, 600);
    B.append(goal, planner, approve);
    const depth = {};
    const byKey = Object.fromEntries(pl.proposed.map((p) => [p.key, p]));
    const dOf = (k) => depth[k] ?? (depth[k] = byKey[k].dependsOn.length ? 1 + Math.max(...byKey[k].dependsOn.map(dOf)) : 0);
    pl.proposed.forEach((p) => dOf(p.key));
    const perCol = {};
    const svg = svgFull(); B.append(svg);
    const nodes = {};
    const NW = 380, NH = 96;
    for (const p of pl.proposed) {
      const d = depth[p.key], i = (perCol[d] = (perCol[d] ?? -1) + 1);
      const x = 120 + d * 440, y = 300 + i * 106;
      const part = pl.parts.find((q) => q.key === p.key);
      const n = pos(h("div", { class: "card", style: { padding: "10px 16px", height: NH + "px", borderWidth: "2px" } },
        h("div", { class: "mono", style: { fontSize: "18px", color: "var(--text-bright)", whiteSpace: "nowrap", overflow: "hidden" }, text: `${part.id}  ${p.key}` }),
        h("div", { class: "who mono", style: { fontSize: "17px", marginTop: "6px", lineHeight: "1.35" }, html:
          `<span style="color:var(--text-muted)">built</span> ${part.builders.map((b) => `<span style="color:${col(fam(b))}">${esc(nice(b))}</span>`).join(" + ")}<br><span style="color:var(--text-muted)">review</span> ${part.approvedBy.map((b) => `<span style="color:${col(fam(b))}">${esc(nice(b))}</span>`).join(", ")}` })), x, y, NW);
      B.append(n);
      nodes[p.key] = { el: n, x, y, part, d };
    }
    const edgesP = [];
    for (const p of pl.proposed) for (const dep of p.dependsOn) {
      const a = nodes[dep], b = nodes[p.key];
      const e = s("path", { d: `M ${a.x + NW} ${a.y + NH / 2} C ${a.x + NW + 40} ${a.y + NH / 2}, ${b.x - 40} ${b.y + NH / 2}, ${b.x} ${b.y + NH / 2}`, fill: "none", stroke: "var(--line-bright)", "stroke-width": 3 });
      svg.append(e); edgesP.push({ e, d: b.d });
    }
    const ints = pl.parts.filter((p) => p.integratedAt).sort((a, b) => (a.integratedAt < b.integratedAt ? -1 : 1));
    const mergedStamp = pos(h("div", { class: "abs" }, h("span", { class: "stamp", text: `merged ${utc(pl.mergedAt)}, ${day(pl.mergedAt)}`, style: { color: "var(--observed)", fontSize: "22px" } }),
      h("div", { class: "mono", text: `${ints.length} parts integrated: ${pl.proposed.length} proposed, ${ints.filter((p) => p.added).length} added to merge main in as it moved`, style: { fontSize: "20px", marginTop: "10px", color: "var(--text-muted)" } })), 120, 660);
    B.append(mergedStamp);
    // t209: the orchestrator's own moves.
    const C = h("div", { class: "abs", style: { inset: 0 } });
    const s209 = data.stories.t209;
    const evs = s209.events;
    const rels = evs.filter((e) => e.kind === "item.released");
    const toFable = evs.find((e) => e.kind === "item.dispatched" && e.actor === "atelier/orchestrator" && e.model === "fable-5.1");
    const reqGlm = evs.find((e) => e.kind === "review.requested" && e.actor === "atelier/orchestrator");
    const wd = evs.find((e) => e.kind === "review.withdrawn");
    const appr = s209.reviews.find((r) => r.approve);
    const dt = (iso) => `${day(iso).replace(" October", " Oct")} · ${utc(iso, true).replace(" UTC", "")}`;
    const orch = "<span style='color:var(--signal)'>atelier/orchestrator</span>";
    C.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: "part t209 of plan t197 · times in UTC" }), h("div", { class: "display", text: "The orchestrator acts on its own", style: { fontSize: "58px", marginTop: "8px" } })), 120, 70));
    const rowsC = eventRows([
      { time: dt(rels[0].at), what: `two runs by <span style="color:${col("zai")}">GLM-5.3</span> end: “${esc(rels[0].note)}”`, detail: `the second at ${utc(rels[1].at, true)}` },
      { time: dt(toFable.at), what: `${orch} dispatched it to <span style="color:${col("anthropic")}">Fable 5.1</span>`, detail: `“${esc(toFable.note)}”`, quote: true, color: "var(--signal)" },
      { time: dt(reqGlm.at), what: `${orch} asked <span style="color:${col("zai")}">GLM-5.3</span> for the review` },
      { time: dt(wd.at), what: `${orch} withdrew it, and asked <span style="color:${col("google")}">Gemini 3.1 Pro</span>`, detail: `“${esc(wd.note)}”`, quote: true, color: "var(--signal)" },
      { time: dt(appr.at), what: `<span style="color:${col("google")}">Gemini 3.1 Pro</span> approved`, color: "var(--observed)" },
    ], 120, 220, 1680, 16);
    C.append(rowsC.el, pos(h("div", { class: "abs mono", style: { fontSize: "19px", color: "var(--text-muted)" }, text: "atelier/orchestrator is Atelier's own code, with no model; opencode is the tool GLM-5.3 runs in." }), 120, 860));
    // D: conflict handling, t255.
    const D = h("div", { class: "abs", style: { inset: 0 } });
    const s255 = data.stories.t255, e255 = s255.events;
    const rf = data.stories.t197.events.find((e) => e.kind === "plan.refresh_failed" && e.at === e255[0].at);
    const files = [...(rf?.note ?? "").matchAll(/Merge conflict in (\S+)/g)].map((m) => m[1]);
    const rej255 = s255.reviews.find((r) => !r.approve), app255 = s255.reviews.find((r) => r.approve);
    const subs = e255.filter((e) => e.kind === "item.submitted"), integ = e255.find((e) => e.kind === "part.integrated");
    D.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: "plan t197's branch · 7 October 2026 · times in UTC" }), h("div", { class: "display", text: "A conflict, handed to an agent", style: { fontSize: "58px", marginTop: "8px" } })), 120, 70));
    const rowsD = eventRows([
      { time: utc(e255[0].at, true).replace(" UTC", ""), what: `merging main into the plan's branch conflicted in ${files.length} files; ${orch} filed merge job t255 and gave it to <span style="color:${col("zai")}">GLM-5.3</span>`, detail: files.join(" · ") },
      { time: utc(subs[0].at, true).replace(" UTC", ""), what: `<span style="color:${col("zai")}">GLM-5.3</span> submitted the resolution, checks observed passing` },
      { time: utc(rej255.at, true).replace(" UTC", ""), what: `sent back by <span style="color:${col("anthropic")}">Opus 5.5</span>`, detail: `“${esc(rej255.note.split(/(?<=\.)\s/)[0])}”`, quote: true, color: "var(--fault)" },
      { time: utc(app255.at, true).replace(" UTC", ""), what: `approved by <span style="color:${col("anthropic")}">Opus 5.5</span>; integrated on the plan's branch at ${utc(integ.at, true).replace(" UTC", "")}`, color: "var(--observed)" },
    ], 120, 220, 1680, 18);
    D.append(rowsD.el, pos(h("div", { class: "card", style: { padding: "14px 22px", width: "1680px" } }, h("div", { class: "mono", style: { fontSize: "21px", lineHeight: "1.55", color: "var(--text)" }, html: "On a single task: a landing whose merge of main conflicts stops, naming the files, and <span style='color:var(--signal)'>atelier dispatch ID --job merge-main</span> sends it back to the task's builder.<br>One landing lease per project: two landings never race main." })), 120, 700));
    el.append(B, C, D);
    const tC = c.cue(1), tD = c.cue(2);
    const tProp = c.when("Opus 5.5 split"), tAppr = c.when("approved once"), tWho = c.when("five agents built");
    const tR = [c.when("when two attempts"), c.when("moved the part"), c.when("and moved its review") - 0.4, c.when("and moved its review") + 0.4, c.when("to Gemini")];
    const show = slides([{ el: B, a: 0, b: tC }, { el: C, a: tC, b: tD }, { el: D, a: tD, b: 1e9 }]);
    c.sfx(tAppr + 0.3, "chime", 0.6); c.sfx(tC - 0.2, "whoosh", 0.5); c.sfx(tD - 0.2, "whoosh", 0.5);
    const tRD = [tD + 0.3, c.when("gave it to GLM") + 0.3, c.when("sent the resolution back"), c.when("then approved it")];
    return {
      el,
      update(t) {
        show(t);
        fadeIn(goal, P(t, 0.2, 0.6));
        fadeIn(planner, P(t, tProp, 0.6));
        Object.values(nodes).forEach((n, i) => {
          const k = P(t, tProp + 0.5 + n.d * 0.3 + i * 0.08, 0.5);
          n.el.style.opacity = k; n.el.style.transform = `scale(${lerp(0.85, 1, k)})`;
          const k2 = P(t, tAppr + 1.2 + i * 0.3, 0.5);
          n.el.style.borderColor = k2 > 0.5 ? HEX[fam(n.part.approvedBy[0] ?? "")] : "var(--line-bright)";
          n.el.style.boxShadow = k2 > 0.5 ? `inset 6px 0 0 ${HEX[fam(n.part.builders[0])]}, 0 20px 60px rgba(0,0,0,.45)` : "";
          n.el.querySelector(".who").style.opacity = k2;
        });
        edgesP.forEach(({ e, d }) => { e.style.opacity = P(t, tProp + 0.5 + d * 0.3, 0.5); });
        const ka = P(t, tAppr, 0.35);
        approve.style.opacity = ka; approve.style.transform = `scale(${lerp(1.4, 1, ka)})`; approve.style.transformOrigin = "100% 0";
        fadeIn(mergedStamp, P(t, tAppr + 3.6, 0.6), 10);
        rowsC.els.forEach((r, i) => fadeIn(r, P(t, tR[i] - 0.1, 0.5), 10));
        rowsD.els.forEach((r, i) => fadeIn(r, P(t, tRD[i] - 0.1, 0.5), 10));
        fadeIn(D.lastChild, P(t, c.when("On a single task") - 0.2, 0.5));
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tC - 0.1 ? `from the ledger: t197 · ${day(pl.proposedAt)} and ${day(pl.mergedAt)} 2026` : t < tD - 0.1 ? `from the ledger: t209 · ${day(rels[0].at)} and ${day(appr.at)} 2026` : `from the ledger: t255 · ${day(e255[0].at)} 2026`,
      crit: (t) => t < tD - 0.1 ? "coordination" : "conflict handling",
    };
  };

  SCENES.metrics = (c, data) => {
    const el = h("div");
    const f = data.facts, gw = data.api.gateway;
    const windowLine = `window: 1 to ${day(f.cutoff)} 2026, as of ${utc(f.cutoff)} · the ledger's first task is of ${day(f.firstTaskAt)}`;
    // A: who built what merged, and who reviewed.
    const A = h("div", { class: "abs", style: { inset: 0 } });
    const byCo = {};
    for (const [m, n] of Object.entries(f.mergedByFinalBuilder)) {
      const list = (byCo[fam(m)] ??= []), name = NAMES[m] ?? m, had = list.find((x) => x[0] === name);
      if (had) had[1] += n; else list.push([name, n]);
    }
    const cos = Object.entries(byCo).map(([co, ms]) => [co, ms.reduce((s2, [, n]) => s2 + n, 0), ms.sort((a, b) => b[1] - a[1])]).sort((a, b) => b[1] - a[1]);
    const total = cos.reduce((s2, x) => s2 + x[1], 0);
    const maxN = cos[0][1];
    const coRows = cos.map(([co, n, ms]) => h("div", { style: { display: "flex", alignItems: "center", gap: "16px", height: "62px" } },
      h("div", { class: "display", text: COMPANY[co], style: { width: "190px", fontSize: "30px", color: col(co), textAlign: "right" } }),
      h("div", { class: "bar", style: { height: "30px", width: `${Math.max(4, n / maxN * 380)}px`, background: col(co), borderRadius: "4px" } }),
      h("div", { class: "mono", style: { fontSize: "21px" }, html: `<b>${n}</b> <span style="color:var(--text-muted)">${ms.map(([m, k]) => `${esc(m)} ${k}`).join(", ")}</span>` })));
    const revs = Object.entries(f.reviewsByModel).sort((a, b) => b[1] - a[1]);
    const maxR = revs[0][1];
    const revRows = revs.map(([m, n]) => h("div", { style: { display: "flex", alignItems: "center", gap: "12px", height: "34px" } },
      h("div", { class: "mono", text: NAMES[m] ?? m, style: { width: "270px", fontSize: "19px", textAlign: "right", color: col(fam(m)), fontWeight: 600 } }),
      h("div", { class: "bar", style: { height: "16px", width: `${Math.max(3, n / maxR * 200)}px`, border: `2px solid ${col(fam(m))}`, borderRadius: "3px" } }),
      h("div", { class: "mono", text: String(n), style: { fontSize: "19px" } })));
    A.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: windowLine }), h("div", { class: "display", text: "Who built what merged", style: { fontSize: "60px", marginTop: "10px" } })), 120, 70),
      pos(h("div", { class: "abs" }, ...coRows, h("div", { class: "mono", style: { fontSize: "20px", color: "var(--text-muted)", marginTop: "16px", width: "1060px", lineHeight: "1.5" }, text: `${total} merged tasks, each counted once, for the model whose head merged; ${f.mergedWithSeveralBuilders} had more than one builder along the way. With plan t197, ${total + f.mergedPlans} merged.` })), 120, 230),
      pos(h("div", { class: "abs" }, h("div", { class: "label", text: `reviews by agents: ${f.modelReviews}` }), h("div", { style: { marginTop: "12px" } }, ...revRows)), 1310, 230));
    // B: AI Gateway.
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const gm = [...gw.models].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    const gName = (m) => ({ "moonshotai/kimi-k2.7-code": "Kimi K2.7 Code · Moonshot", "deepseek-v4-pro": "DeepSeek V4 Pro · DeepSeek", "deepseek-flash": "DeepSeek Flash · DeepSeek", "cohere/north-mini-code:free": "North Mini Code · Cohere, free" }[m] ?? m);
    const gCol = (m) => /kimi/.test(m) ? col("moonshot") : /deepseek/.test(m) ? col("deepseek") : "var(--text)";
    const cell = (x, w, opts = {}) => h("div", { class: "mono", style: { width: w + "px", fontSize: opts.size ?? "24px", textAlign: opts.left ? "left" : "right", color: opts.color ?? "var(--text)", fontWeight: opts.bold ? 600 : 400 } }, x);
    const money = (x) => x == null ? "free" : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(x < 0.01 ? 3 : 2)}`;
    const table = h("div", {},
      h("div", { style: { display: "flex", gap: "24px", paddingBottom: "10px", borderBottom: "2px solid var(--line-bright)" } }, cell("agent · company", 560, { left: true, color: "var(--text-muted)", size: "20px" }), cell("calls", 160, { color: "var(--text-muted)", size: "20px" }), cell("failed", 160, { color: "var(--text-muted)", size: "20px" }), cell("cost", 200, { color: "var(--text-muted)", size: "20px" }), cell("median latency", 260, { color: "var(--text-muted)", size: "20px" })),
      ...gm.map((m) => h("div", { class: "grow", style: { display: "flex", gap: "24px", height: "64px", alignItems: "center", borderBottom: "1px solid var(--line)" } },
        cell(gName(m.model), 560, { left: true, color: gCol(m.model), bold: true }), cell(String(m.calls), 160), cell(String(m.failures), 160, { color: m.failures ? "var(--fault)" : "var(--text)", bold: !!m.failures }), cell(money(m.cost), 200), cell(`${(m.medianMs / 1000).toFixed(1)} s`, 260))));
    B.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: `AI Gateway · the last ${gw.days} days, ${day(gw.since)} ${utc(gw.since)} to ${day(gw.readAt)} ${utc(gw.readAt)} · GET /api/usage` }), h("div", { class: "display", text: "What the pay-per-use agents cost", style: { fontSize: "60px", marginTop: "10px" } })), 120, 70),
      pos(h("div", { class: "abs" }, table, h("div", { class: "mono", style: { fontSize: "20px", color: "var(--text-muted)", marginTop: "22px", width: "1500px", lineHeight: "1.5" }, text: "Only pay-per-use calls pass through AI Gateway; subscription and local agents make no metered calls, so their work is counted from the ledger alone." })), 120, 250));
    // C: t275 to t313.
    const C = h("div", { class: "abs", style: { inset: 0 } });
    const s275 = data.stories.t275;
    const kimiRuns = data.runs.filter((r) => r.item === "t275" && /kimi/.test(r.actor)).sort((a, b) => a.at < b.at ? -1 : 1);
    const exits = kimiRuns.filter((r) => /exited 1/.test(r.detail));
    const cause = kimiRuns.find((r) => /Our configuration/.test(r.detail));
    const opusClaim = s275.events.find((e) => e.kind === "item.claimed" && /opus/.test(e.actor));
    const app = s275.reviews.find((r) => r.approve), mer = s275.events.find((e) => e.kind === "item.merged");
    const t313 = data.selfTasks.t313;
    const overflow = t313.title.match(/12 HTTP 400s, each 'maximum context length is 262144 tokens\.\.\. 230145 input tokens' plus 32000 output/)[0];
    const dt = (iso) => utc(iso, true).replace(" UTC", "");
    C.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: `t275 and t313 · ${day(s275.mergedAt)} 2026 · times in UTC` }), h("div", { class: "display", text: "A failure, traced to its cause", style: { fontSize: "58px", marginTop: "8px" } })), 120, 70));
    const rowsC = eventRows([
      { time: `${dt(exits[0].at)}, ${dt(exits[1].at)}`, what: `<span style="color:${col("moonshot")}">Kimi K2.7 Code</span>'s runs on t275 end: “${esc(exits[0].detail)}”` },
      { time: "gateway logs", what: "the failed calls, as t313 records them", detail: `“…${esc(overflow)}”`, quote: true, color: "var(--fault)" },
      { time: dt(cause.at), what: "the run report", detail: `“${esc(cause.detail.replace(/^Cause found 2026-10-08: /, ""))}”`, quote: true, color: "var(--signal)" },
      { time: dt(t313.createdAt), what: "t313 filed: the runner warns of a missing context limit, and records why a provider call failed", detail: `state: ${t313.state}` },
      { time: dt(app.at), what: `t275, finished by <span style="color:${col("anthropic")}">Opus 5.5</span> (claimed ${dt(opusClaim.at)}), approved by <span style="color:${col("google")}">Gemini 3.1 Pro</span>; merged ${dt(mer.at)} as ${mer.mergeCommit}`, color: "var(--observed)" },
    ], 120, 210, 1680, 16);
    C.append(rowsC.el);
    el.append(A, B, C);
    const tB = c.cue(1), tC = c.cue(2);
    const tR = [tC + 0.2, c.when("Each one overflowed"), c.when("the run report"), c.when("The fix is"), c.when("Kimi's task")];
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: 1e9 }]);
    c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC - 0.2, "whoosh", 0.5); c.sfx(tR[4], "approve", 0.7);
    return {
      el,
      update(t) {
        show(t);
        coRows.forEach((r, i) => { fadeIn(r, P(t, 0.3 + i * 0.15, 0.4), 8); const b = r.querySelector(".bar"); b.style.transformOrigin = "0 50%"; b.style.transform = `scaleX(${P(t, 0.5 + i * 0.15, 0.7)})`; });
        revRows.forEach((r, i) => fadeIn(r, P(t, 1.2 + i * 0.1, 0.4), 6));
        [...table.querySelectorAll(".grow")].forEach((r, i) => fadeIn(r, P(t, tB + 0.3 + i * 0.2, 0.4), 8));
        rowsC.els.forEach((r, i) => fadeIn(r, P(t, tR[i] - 0.15, 0.5), 10));
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tC - 0.1 ? `1 to ${day(f.cutoff)} 2026 · as of ${utc(f.cutoff)}` : `from the ledger: t275, t313 · ${day(s275.mergedAt)} 2026`,
    };
  };

  SCENES.who = (c, data) => {
    const el = h("div");
    const A = h("div", { class: "abs", style: { inset: 0 } });
    const log = data.terminal.freshLog.trim().split("\n").map((l) => l.split(" "));
    const first = log.at(-1), mergeL = log[0];
    const steps = [
      [first[1], "the first commit: a list pager, and a test it fails", "expected [1, 2], got [3, 4]"],
      ["15:27:26", "atelier init", "the project registered, with its required check: npm test"],
      ["15:27:34", "atelier new", "task t1: “Fix the off-by-one in pagination”"],
      ["15:27:35", "atelier start", "claimed by Opus 5.5, its own fork made"],
      ["15:27:45", "atelier done", "pushed; npm test observed passing at 15:27:48"],
      ["15:28:06", "atelier land", `merged as ${mergeL[0]}, the record attached as a note`],
    ];
    A.append(pos(h("div", { class: "abs" }, h("div", { class: "label", text: `a new project, fresh-demo · ${day(data.facts.cutoff)} 2026 · times in UTC` }), h("div", { class: "display", text: "The README's quickstart, run", style: { fontSize: "56px", marginTop: "8px" } })), 120, 70));
    const stepEls = steps.map(([tm, what, detail], i) => {
      const r = pos(h("div", { class: "abs", style: { display: "flex", gap: "20px", width: "820px" } },
        h("div", { class: "mono", text: tm, style: { width: "120px", fontSize: "21px", color: "var(--text-muted)", paddingTop: "3px", flex: "none" } }),
        h("div", {}, h("div", { class: i ? "mono" : "", text: what, style: { font: i ? "600 25px/1.3 var(--font-mono)" : "500 25px/1.3 var(--font-sans)", color: i === 5 ? "var(--observed)" : i ? "var(--signal)" : "var(--text-bright)" } }), h("div", { class: "mono", text: detail, style: { fontSize: "19px", color: "var(--text-muted)", marginTop: "4px" } }))), 120, 220 + i * 92);
      A.append(r); return r;
    });
    const secs = Math.round((Date.parse("2026-10-08T15:28:06.110Z") - Date.parse(`2026-10-08T${first[1]}Z`)) / 1000);
    const total = pos(h("div", { class: "abs mono", text: `${secs} seconds from the first commit to the merge`, style: { fontSize: "25px", color: "var(--observed)", fontWeight: 600 } }), 260, 780);
    const term = terminal("fresh-demo · read-only", "git log --oneline -3 && git notes --ref=atelier show HEAD", data.terminal.freshLog.trim().split("\n").map((l) => l.replace(/^(\w+) \S+ /, "$1 ")).join("\n") + "\n" + data.terminal.freshNote, 990, 220, 830, 12, 62);
    A.append(...[total], term.el);
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const cards = [["One holder per task", "no two agents editing the same work; hands change only by a recorded handoff"], ["Checks it can trust", "observed in a clean clone of the pushed head, never taken from the agent"], ["Another company's review", "and a tracked record of which reviewers are right"], ["A ledger of who did what", "kept by the server, and copied into Git as a note on each merge"]].map(([a, b2], i) =>
      pos(h("div", { class: "card", style: { padding: "22px 26px", width: "820px", height: "230px" } }, h("div", { class: "display", text: a, style: { fontSize: "40px" } }), h("div", { class: "mono", text: b2, style: { fontSize: "22px", color: "var(--text-muted)", marginTop: "14px", lineHeight: "1.5" } })), 120 + (i % 2) * 860, 230 + Math.floor(i / 2) * 270));
    B.append(pos(h("div", { class: "abs display", text: "What a team running several agents gets", style: { fontSize: "56px" } }), 120, 100), ...cards);
    const C = h("div", { class: "abs", style: { inset: 0 } });
    const shot = browser("showcase", "atelier.zone<b>/showcase</b>", "public, no sign-in · captured 8 October 2026");
    C.append(shot.el);
    el.append(A, B, C);
    const tB = c.cue(1), tC = c.cue(2);
    const moves = (data.screens.showcase.marks["Latest moves across projects"]?.y ?? 2000) - 6;
    const tS = [c.when("new project"), c.when("init"), c.when("new start"), c.when("start done"), c.when("done and land"), c.when("land merged")];
    const show = slides([{ el: A, a: 0, b: tB }, { el: B, a: tB, b: tC }, { el: C, a: tC, b: 1e9 }]);
    c.sfx(tB - 0.2, "whoosh", 0.5); c.sfx(tC - 0.2, "whoosh", 0.5);
    return {
      el,
      update(t) {
        show(t);
        stepEls.forEach((r, i) => fadeIn(r, P(t, tS[i] - 0.2, 0.4), 8));
        fadeIn(total, P(t, c.when("under a minute") - 0.2, 0.5));
        term.update(t, c.when("init") + 0.4);
        cards.forEach((x, i) => pop(x, P(t, tB + 0.2 + i * 0.5, 0.5), 0.9));
        shot.el.style.display = "block"; shot.el.style.opacity = 1; shot.el.style.transform = "none";
        shot.pan(t, [[tC, moves - 24, 1.25, 120], [c.dur, moves, 1.25, 120]]);
        return { cx: 960, cy: 540, s: 1 };
      },
      tag: (t) => t < tB - 0.1 ? `from the ledger: fresh-demo t1 · ${day(data.facts.cutoff)} 2026` : t < tC - 0.1 ? "" : "the public showcase · 8 October 2026",
      crit: () => "ease of use",
    };
  };

  SCENES.cloud = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 1920, 1080);
    const svg = svgFull(); world.append(svg);
    const band = (y, hgt, label, color) => {
      const g = s("g", {});
      g.append(s("rect", { x: 100, y, width: 1720, height: hgt, rx: 18, fill: color, stroke: "var(--line)", "stroke-width": 1.5 }));
      g.append(s("text", { x: 126, y: y + 32, fill: "var(--text-muted)", "font-size": 18, "letter-spacing": 2, text: label.toUpperCase() }));
      svg.append(g); return g;
    };
    const bMac = band(40, 160, "The lead developer's machines", "rgba(255,255,255,.015)");
    const bCf = band(216, 448, "Cloudflare · live", "rgba(95,224,143,.035)");
    const bNext = band(682, 112, "Built, not yet in daily use", "rgba(255,255,255,.01)");
    bNext.querySelector("rect").setAttribute("stroke-dasharray", "8 8");
    const box = (x, y, w, hh, title, sub, opts = {}) => {
      const b = pos(h("div", { class: "card", style: { padding: "12px 18px", height: hh + "px", borderColor: opts.color ?? "var(--observed-line)", borderStyle: opts.dashed ? "dashed" : "solid", background: opts.dashed ? "transparent" : "var(--surface-raised)" } },
        h("div", { style: { font: "600 23px/1.2 var(--font-sans)", color: "var(--text-bright)" } }, opts.live ? h("span", { style: { display: "inline-block", width: "11px", height: "11px", borderRadius: "50%", background: "var(--observed)", marginRight: "10px", boxShadow: "0 0 10px var(--observed)", verticalAlign: "2px" } }) : null, title),
        h("div", { class: "mono", style: { fontSize: "17px", color: "var(--text-muted)", marginTop: "6px", lineHeight: "1.35" }, html: sub })), x, y, w);
      world.append(b); return { el: b, x, y, w, h: hh };
    };
    const cli = box(150, 80, 420, 104, "atelier CLI", "the lead developer's one command;<br>checks in a clean clone", { color: "var(--line-bright)" });
    const runner = box(620, 80, 420, 104, "Home runners", "build, plan and review jobs;<br>each agent's own tool", { color: "var(--line-bright)" });
    const access = box(150, 258, 440, 104, "Access", "the Worker checks each Access token<br>and the lead developer's email", { live: true });
    const worker = box(640, 258, 480, 104, "Worker · atelier.zone", "the API, the pages<br>and the gate", { live: true });
    const wf = box(1170, 258, 600, 104, "Workflows", "atelier land --workflow: a landing as<br>durable steps", { live: true });
    const ledger = box(150, 396, 440, 100, "Durable Objects: Ledger", "one per project, SQLite storage;<br>one request at a time", { live: true });
    const index = box(640, 396, 480, 100, "Durable Object: index", "what spans projects: tokens,<br>model pool, runner offers", { live: true });
    const art = box(1170, 396, 600, 100, "Artifacts", "Git repositories: a baseline per project,<br>a fork for every task and plan", { live: true });
    const logs = box(150, 530, 440, 100, "Workers Logs", "the Worker's logs, kept", { live: true });
    const aig = box(640, 530, 480, 100, "AI Gateway", "pay-per-use agents' calls: tokens,<br>cost and latency per agent", { live: true });
    const r2 = box(1170, 530, 600, 100, "R2 · atelier-large", "whole check logs and review diffs", { live: true });
    const next = [["Browser Rendering", "render checks of /how and the showcase"], ["Containers", "checks in a container; a full suite not yet proven"], ["Analytics Engine", "bound; nothing writes to it yet"]].map(([n, sub], i) => box(150 + i * 545, 718, 520, 66, n, sub, { dashed: true, color: "var(--line-bright)" }));
    const centre = (b, side) => side === "top" ? [b.x + b.w / 2, b.y] : [b.x + b.w / 2, b.y + b.h];
    const edge = (a, b, color = "#ffd166") => {
      const [x1, y1] = centre(a, "bottom"), [x2, y2] = centre(b, "top");
      const d = `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
      const p = s("path", { d, fill: "none", stroke: "var(--line-bright)", "stroke-width": 2.5 });
      svg.append(p);
      return { p, b: beads(svg, d, color, 2, 6) };
    };
    const E = { cli: edge(cli, worker), runner: edge(runner, worker), ledger: edge(worker, ledger), index: edge(worker, index), art: edge(worker, art, "#5fe08f") };
    const tW = c.when("a Worker"), tL = c.when("a Durable Object"), tA = c.when("and Artifacts");
    const tLogs = c.when("Workers Logs"), tAig = c.when("AI Gateway"), tAcc = c.when("Access"), tR2 = c.when("R2"), tWf = c.when("Workflows are"), tBuilt = c.when("Browser Rendering");
    const vis = { cli: 0.8, runner: 1.1, ledger: tL + 0.4, index: tL + 1.2, art: tA + 0.5 };
    [tL, tA, c.cue(1), tBuilt].forEach((x) => c.sfx(x, "chime", 0.3));
    return {
      el,
      update(t) {
        const view = cam.set(t, [[0, 960, 500, 1.0]], 0.2);
        const show = (b, a) => pop(b.el ?? b, P(t, a, 0.5), 0.85);
        bMac.style.opacity = P(t, 0.2, 0.5); show(cli, 0.4); show(runner, 0.7);
        bCf.style.opacity = P(t, tW - 0.2, 0.5);
        show(worker, tW);
        show(ledger, tL); show(index, tL + 0.8);
        show(art, tA); show(logs, tLogs); show(aig, tAig);
        show(access, tAcc); show(r2, tR2); show(wf, tWf - 0.2);
        bNext.style.opacity = P(t, tBuilt - 0.2, 0.5);
        next.forEach((b, i) => show(b, tBuilt + i * 0.5));
        worker.el.style.boxShadow = `0 0 ${24 + 16 * Math.sin(t * 2.4)}px rgba(95,224,143,.3), 0 20px 60px rgba(0,0,0,.45)`;
        for (const [k, { p, b }] of Object.entries(E)) { const k0 = P(t, vis[k], 0.5); p.style.opacity = k0; b.update(t, vis[k] + 0.4, 1.8, k0); }
        return view;
      },
    };
  };

  const CHAPTERS = ["Why Git alone isn't enough", "Who does the work", "Nothing merges without proof", "Big goals become plans", "It measures, and it learns", "Who it is for", "It runs on Cloudflare"];

  SCENES.close = (c, data) => {
    const el = h("div");
    const F = field(data);
    const cam = camera(F.world, F.W, F.H);
    el.append(F.world);
    const hud = h("div", { class: "abs", style: { inset: 0 } });
    el.append(hud);
    const f = data.facts;
    const key = ["One holder per task", "Checks observed", "Another family's", "A record of every"];
    const lines = ["One holder per task.", "Checks observed, not claimed.", "Another family's approval.", "A record of every agent."].map((tx, i) => {
      const l = pos(h("div", { class: "abs display", text: tx, style: { fontSize: "56px", width: "1920px", textAlign: "center", left: 0 } }), 0, 220 + i * 84);
      hud.append(l); return l;
    });
    const line = kinetic("Git keeps the code. Atelier keeps the record.", "kin display", { position: "absolute", left: 0, right: 0, top: "230px", textAlign: "center", fontSize: "84px" });
    hud.append(line.el);
    const nums = pos(h("div", { class: "abs", style: { display: "flex", gap: "120px", justifyContent: "center", width: "1920px", left: 0 } },
      ...[[f.tasks, "tasks"], [f.states.merged, "merged"]].map(([n, l]) => h("div", { style: { textAlign: "center" } }, h("div", { class: "big-num", "data-n": n, text: "0" }), h("div", { class: "label", text: l, style: { marginTop: "8px" } })))), 0, 380);
    const rest = f.tasks - f.states.merged, inFlight = rest - (f.states.abandoned ?? 0);
    const restLine = pos(h("div", { class: "abs mono", text: `the other ${rest}: ${f.states.abandoned} abandoned along the way, ${inFlight} open, blocked or in flight`, style: { fontSize: "25px", width: "1920px", textAlign: "center", color: "var(--text-muted)" } }), 0, 556);
    hud.append(nums, restLine);
    const end = h("div", { class: "abs", style: { inset: 0 } });
    end.append(pos(h("div", { class: "abs display", text: "atelier.zone", style: { fontSize: "130px", width: "1920px", textAlign: "center", left: 0 } }), 0, 300),
      pos(h("div", { class: "abs mono", text: "github.com/pavithran/atelier · MIT licence", style: { fontSize: "36px", width: "1920px", textAlign: "center", color: "var(--signal)" } }), 0, 480),
      pos(h("div", { class: "abs mono", text: `This film is task t320 in the same ledger · figures as of ${ASOF(data)}`, style: { fontSize: "22px", width: "1920px", textAlign: "center", color: "var(--text-muted)" } }), 0, 560));
    el.append(end);
    key.forEach((k) => c.sfx(c.when(k), "tick", 0.7));
    c.sfx(c.cue(1), "swell", 0.7); c.sfx(c.cue(2), "chime", 0.9);
    const tShot = c.cue(2) - 0.2, tEnd = c.cue(2) - 0.2;
    return {
      el,
      update(t) {
        F.at(F.T1, 0.2 + 0.06 * Math.sin(t * 0.8));
        const view = cam.set(t, [[0, F.W / 2, F.MAINY - 80, 0.42], [c.dur, F.W / 2, F.MAINY - 60, 0.46]], 0.5);
        const out = 1 - P(t, c.cue(1) - 0.4, 0.5);
        lines.forEach((l, i) => fadeIn(l, P(t, c.when(key[i]) - 0.15, 0.4) * out, 14));
        const out2 = 1 - P(t, tShot - 0.3, 0.4);
        line.update(P(t, c.cue(1), 1.2) * out2);
        nums.style.opacity = P(t, c.when("It built itself") - 0.2, 0.6) * out2;
        [...nums.querySelectorAll(".big-num")].forEach((x, i) => count(x, Number(x.dataset.n), (t - c.when("It built itself") + 0.2 - i * 0.5) / 1.1));
        restLine.style.opacity = P(t, c.when("It built itself") + 1.2, 0.6) * out2;
        end.style.opacity = P(t, tEnd, 0.6);
        return view;
      },
      tag: () => "",
    };
  };

  // ── the player ──────────────────────────────────────────────────────────
  let built = [], captions = [], sounds = [];
  const capEl = () => document.querySelector("#caption span");
  // Scenes that hand over without a dip to black, because the next one
  // continues the picture.
  const MATCH = new Set([]);
  const LIGHT = new Set(["why", "metrics"]);
  const CHAPTER_OF = { why: 1, cast: 2, gate: 3, stories: 3, plan: 4, metrics: 5, who: 6, cloud: 7 };

  async function init(tl, data) {
    for (const spec of ['800 60px "Bricolage Grotesque"', '700 60px "Bricolage Grotesque"', '400 20px "IBM Plex Sans"', '500 20px "IBM Plex Sans"', '600 20px "IBM Plex Sans"', '400 20px "IBM Plex Mono"', '500 20px "IBM Plex Mono"']) await document.fonts.load(spec);
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
      const wrap = h("div", { class: "scene" + (LIGHT.has(sc.id) ? " light" : "") });
      root.append(wrap);
      wrap.classList.add("on");
      const scene = make(ctx, data);
      wrap.append(scene.el);
      wrap.classList.remove("on");
      built.push({ sc, wrap, scene, n: i + 1, next: tl.scenes[i + 1]?.id, prev: tl.scenes[i - 1]?.id });
      for (const cue of sc.cues) for (const k of cue.captions) captions.push({ start: sc.start + k.start, end: sc.start + k.end, text: k.text });
    });
    await Promise.all([...document.images].map((im) => im.decode().catch(() => { throw new Error("image failed: " + im.src); })));
  }

  function seek(T) {
    const cur = built.find((b) => T >= b.sc.start && T < b.sc.start + b.sc.dur) ?? built[built.length - 1];
    for (const b of built) b.wrap.classList.toggle("on", b === cur);
    const t = T - cur.sc.start;
    const view = cur.scene.update(t) ?? { cx: 960, cy: 540, s: 1 };
    // Transitions: a push in and a dip at the cut, unless the scenes match.
    const D = 0.55;
    const outMatch = MATCH.has(`${cur.sc.id}>${cur.next}`), inMatch = MATCH.has(`${cur.prev}>${cur.sc.id}`);
    const kOut = outMatch ? 0 : clamp(1 - (cur.sc.dur - t) / D), kIn = inMatch ? 0 : clamp(1 - t / D);
    cur.wrap.style.transform = `scale(${(1 + 0.07 * ease(kOut)) * (1 - 0.05 * ease(kIn))})`;
    cur.wrap.style.filter = kOut + kIn > 0 ? `blur(${4 * (kOut + kIn)}px)` : "";
    document.getElementById("fade").style.opacity = clamp(Math.max(kOut, kIn) * 0.95 + (T < 0.4 ? 1 - T / 0.4 : 0));
    // Parallax: the grid behind moves a little with the camera.
    document.getElementById("bg").style.backgroundPosition = `${(-view.cx * 0.12 * view.s).toFixed(1)}px ${(-view.cy * 0.12 * view.s).toFixed(1)}px`;
    document.getElementById("vignette").style.opacity = cur.wrap.classList.contains("light") ? 0.35 : 1;
    document.getElementById("grain").querySelector("feTurbulence").setAttribute("seed", String(Math.floor(T * 15) % 97 + 1));
    const ch = document.getElementById("chapter");
    const crit = cur.scene.crit ? cur.scene.crit(t) : "";
    ch.innerHTML = CHAPTER_OF[cur.sc.id] ? `<b>${CHAPTER_OF[cur.sc.id]}</b>${esc(CHAPTERS[CHAPTER_OF[cur.sc.id] - 1])}${crit ? `<span class="crit">${esc(crit)}</span>` : ""}` : "";
    ch.classList.toggle("on-light", cur.wrap.classList.contains("light"));
    ch.style.opacity = P(t, 0.3, 0.6);
    // The scene's source tag: "from the ledger", the task and the date.
    const src = document.getElementById("source");
    const tag = cur.scene.tag ? cur.scene.tag(t) : "";
    src.textContent = tag;
    src.classList.toggle("on-light", cur.wrap.classList.contains("light"));
    src.style.opacity = tag ? P(t, 0.3, 0.6) : 0;

    const cap = captions.find((k) => T >= k.start && T < k.end + 0.25);
    capEl().textContent = cap ? cap.text : "";
  }

  window.film = { init, seek, sounds: () => sounds.sort((a, b) => a.t - b.t) };
})();
