// The film's scenes, second cut. Each scene is a pure function of time:
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
  ];
  const fam = (a) => { const n = a.split("/").pop(); return (FAMILIES.find(([, re]) => re.test(n) || re.test(a)) ?? ["other"])[0]; };
  const col = (f) => `var(--m-${f})`;
  const HEX = { anthropic: "#ff8a5b", openai: "#3fe0b0", zai: "#6f9bff", google: "#ff8fcf", deepseek: "#5ad1e6", xiaomi: "#ff9e40", other: "#8f9cab" };
  const FAMILY_NAME = { anthropic: "Anthropic · Claude", zai: "Zhipu · GLM", openai: "OpenAI · GPT", deepseek: "DeepSeek", google: "Google · Gemini", xiaomi: "Xiaomi · MiMo" };
  const NAMES = {
    "opus-5.5": "Opus 5.5", "sonnet-5.5": "Sonnet 5.5", "fable-5.1": "Fable 5.1", "glm-5.3": "GLM-5.3", "GLM-5.3-Flash-4_8bit": "GLM-5.3 Flash",
    "glm-5.3-flash": "GLM-5.3 Flash", "gpt-6-astra": "gpt-6-astra", "gpt-6.1-sol": "gpt-6.1-sol", "gpt-6": "gpt-6", "gpt-5.5": "gpt-5.5",
    "gemini-3.1-pro": "Gemini 3.1 Pro", "gemini-3.1-pro-preview": "Gemini 3.1 Pro preview", "deepseek-v4-pro": "DeepSeek V4 Pro",
    "xiaomi-mimo-v2.6-pro": "MiMo v2.6 Pro", "gpt-oss-120b": "GPT-OSS 120B",
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

  SCENES.cold = (c, data) => {
    const el = h("div");
    const F = field(data);
    const cam = camera(F.world, F.W, F.H);
    el.append(F.world);
    const SWEEP_A = 0.4, SWEEP_B = 11.6;
    const play = (t) => lerp(F.T0, F.T1, ease(clamp((t - SWEEP_A) / (SWEEP_B - SWEEP_A))) * 0.35 + clamp((t - SWEEP_A) / (SWEEP_B - SWEEP_A)) * 0.65);
    // Ticks as tasks appear, at most one each 70 ms.
    let last = -1;
    const times = data.tasks.map((tk) => Date.parse(tk.createdAt)).sort((a, b) => a - b);
    for (let tt = SWEEP_A; tt <= SWEEP_B; tt += 1 / 30) {
      const now = play(tt), prev = play(tt - 1 / 30);
      const n = times.filter((x) => x > prev && x <= now).length;
      if (n && tt - last > 0.07) { c.sfx(tt, "tick", Math.min(1, 0.4 + n * 0.15)); last = tt; }
    }
    c.sfx(SWEEP_B + 0.2, "swell", 1);
    const hud = h("div", { class: "abs", style: { inset: 0 } });
    const date = pos(h("div", { class: "abs mono", style: { fontSize: "22px", color: "var(--signal)", letterSpacing: ".06em" } }), 80, 70);
    const counter = pos(h("div", { class: "abs" }, h("div", { class: "big-num n", text: "0", style: { fontSize: "88px" } }), h("div", { class: "label", text: "tasks, from Atelier's own ledger" })), 80, 860);
    hud.append(date, counter);
    const title = kinetic("Atelier", "kin display", { fontSize: "220px", position: "absolute", left: 0, right: 0, top: "330px", textAlign: "center", letterSpacing: "-.04em" });
    const sub = kinetic("A Git platform for many coding agents", "kin", { position: "absolute", left: 0, right: 0, top: "610px", textAlign: "center", font: "500 40px/1.2 var(--font-sans)", color: "var(--signal)" });
    hud.append(title.el, sub.el);
    el.append(hud);
    const tTitle = c.cueEnd(0) + 0.1;
    c.sfx(tTitle, "chime", 1);
    return {
      el,
      update(t) {
        const now = play(t);
        const dim = 1 - 0.65 * P(t, tTitle - 0.3, 1.2);
        F.at(now, dim);
        const k = P(t, 2.2, 9.6);
        const sc = lerp(1.25, 0.36, k);
        const xp = F.X(now);
        const cx = lerp(xp - 300, F.W / 2, P(t, 3.0, 8.5)), cy = lerp(F.MAINY - 420, F.MAINY - 80, k);
        const view = cam.set(t, [[0, cx, cy, sc]], 0.6);
        date.textContent = t < SWEEP_B + 0.3 ? new Date(now).toISOString().slice(0, 16).replace("T", "  ") + " UTC" : "";
        date.style.opacity = P(t, 0.3, 0.5) * (1 - P(t, SWEEP_B, 0.5));
        const shown = times.filter((x) => x <= now).length;
        counter.querySelector(".n").textContent = shown;
        counter.style.opacity = P(t, 0.6, 0.6) * (1 - P(t, tTitle - 0.5, 0.6));
        title.update(P(t, tTitle, 1.4));
        sub.update(P(t, tTitle + 0.9, 1.4));
        return view;
      },
    };
  };

  SCENES.cast = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 1920, 1080);
    const svg = svgFull(); world.append(svg);
    // The title, where the cold open left it, rises into a header.
    const title = h("div", { class: "abs display", text: "Atelier", style: { fontSize: "220px", left: "0px", width: "1920px", textAlign: "center", top: "330px", letterSpacing: "-.04em" } });
    const sub = kinetic("a multi-agent system for software work, with Git underneath", "kin", { position: "absolute", left: 0, width: "1920px", textAlign: "center", top: "610px", font: "500 40px/1.2 var(--font-sans)", color: "var(--signal)" });
    el.append(title, sub.el);
    const CX = 960, CY = 560;
    const ledger = pos(h("div", { class: "card", style: { padding: "22px 28px", width: "400px", textAlign: "center", borderColor: "var(--wire)" } }, h("div", { style: { font: "700 34px/1.2 var(--font-display)" }, text: "the ledger" }), h("div", { class: "mono dim", text: "a Durable Object per project; every event recorded", style: { fontSize: "17px", marginTop: "8px" } })), CX - 200, CY - 62);
    world.append(ledger);
    const f = data.facts;
    const revs = Object.entries(f.reviewsByModel).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const roles = [
      { at: [960, 175], name: "Planner", what: "splits a goal into parts", body: [chip(data.plan.planner), h("span", { class: "mono dim", text: ` plan t197: ${data.plan.proposed.length} parts`, style: { fontSize: "18px" } })] },
      { at: [1540, 360], name: "Builders", what: "many at once, each in its own fork", body: ["anthropic", "zai", "openai", "deepseek", "google", "xiaomi"].map((x) => famChip(x, { anthropic: "Claude", zai: "GLM", openai: "GPT", deepseek: "DeepSeek", google: "Gemini", xiaomi: "MiMo" }[x])) },
      { at: [1540, 790], name: "Reviewers", what: "another family than the builders", body: revs.map(([m, n]) => famChip(fam(m), `${NAMES[m] ?? m} ${n}`)) },
      { at: [960, 945], name: "Integrator", what: "merges parts onto a plan's branch; runs no model", body: [h("span", { class: "mono", text: "atelier/integrator", style: { fontSize: "20px", color: "var(--signal)" } })] },
      { at: [380, 790], name: "Runners", what: "on the owner's machines; take jobs from the queue", body: [["zai", "opencode"], ["anthropic", "claude"], ["openai", "codex"], ["google", "antigravity"]].map(([x, n]) => famChip(x, n)) },
      { at: [380, 360], name: "Owner", what: "approves the plan, accepts the result; the only person", body: [h("span", { class: "chip", style: { color: "var(--signal)" } }, h("span", { class: "dot" }), "the owner")] },
    ].map((r, i) => {
      const card = h("div", { class: "card", style: { padding: "16px 20px", width: "460px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "12px" } }, h("span", { class: "display", text: r.name, style: { fontSize: "34px" } }), h("span", { class: "mono dim", text: r.what, style: { fontSize: "16px" } })),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" } }, ...r.body));
      pos(card, r.at[0] - 230, r.at[1] - 70);
      world.append(card);
      const d = `M ${r.at[0]} ${r.at[1]} L ${CX} ${CY}`;
      const line = s("path", { d, fill: "none", stroke: "var(--line-bright)", "stroke-width": 2.5 });
      svg.append(line);
      const toL = beads(svg, d, i === 5 ? "#ffd166" : "#f4f1e8", 2, 5), fromL = beads(svg, `M ${CX} ${CY} L ${r.at[0]} ${r.at[1]}`, "#ffd166", 1, 5);
      return { ...r, card, line, toL, fromL, t0: i === 5 ? c.cue(6) : c.cue(i + 1) };
    });
    roles.forEach((r) => c.sfx(r.t0 - 0.1, "chime", 0.35));
    const keys = [[0, 960, 540, 1.0], [c.cue(0) + 3.5, 960, 560, 1.0]];
    roles.forEach((r) => { keys.push([r.t0 - 0.5, keys[keys.length - 1][1], keys[keys.length - 1][2], keys[keys.length - 1][3]]); keys.push([r.t0 + 0.7, (r.at[0] + CX) / 2, (r.at[1] + CY) / 2, 1.12]); });
    keys.push([c.cueEnd(6) - 1.6, keys[keys.length - 1][1], keys[keys.length - 1][2], 1.12], [c.cueEnd(6) + 0.2, 960, 560, 0.9]);
    return {
      el,
      update(t) {
        const view = cam.set(t, keys, 0.7);
        const up = P(t, 1.0, 1.8);
        title.style.transform = `translate(${-up * 640}px, ${-up * 330}px) scale(${lerp(1, 0.32, up)})`;
        title.style.transformOrigin = "50% 50%";
        sub.update(P(t, 0.4, 1.6));
        sub.el.style.transform = `translate(${-up * 300}px, ${-up * 575}px) scale(${lerp(1, 0.62, up)})`;
        sub.el.style.transformOrigin = "50% 50%";
        const gone = 1 - P(t, c.cue(1) - 0.8, 0.8);
        title.style.opacity = gone; sub.el.style.opacity = gone;
        pop(ledger, P(t, 2.2, 0.7), 0.6);
        ledger.style.boxShadow = `0 0 ${30 + 18 * Math.sin(t * 2.2)}px rgba(255,209,102,.35), 0 20px 60px rgba(0,0,0,.45)`;
        roles.forEach((r) => {
          pop(r.card, P(r.t0 ? t : 0, r.t0, 0.6), 0.7);
          [...r.card.querySelectorAll(".chip")].forEach((x, i) => fadeIn(x, P(t, r.t0 + 0.5 + i * 0.18, 0.4), 8));
          draw(r.line, P(t, r.t0 + 0.2, 0.8));
          r.toL.update(t, r.t0 + 0.8, 1.6, P(t, r.t0 + 0.8, 0.4));
          r.fromL.update(t, r.t0 + 1.6, 2.0, P(t, r.t0 + 1.6, 0.4));
        });
        return view;
      },
    };
  };

  SCENES.why = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const STEP = 1920;
    const PX = (i) => 960 + i * STEP;
    const cam = camera(world, STEP * 9, 1080);
    const starts = c.cues.map((_, i) => c.cue(i));
    const keys = flight(starts.map((t0, i) => [t0 - (i ? 0.5 : 0), PX(i), 540, 1]), 1.2, 0.84);
    starts.slice(1).forEach((t0) => c.sfx(t0 - 0.5, "whoosh", 0.7));
    const f = data.facts;
    // Intro: the three questions.
    const intro = region(0, 0); world.append(intro);
    const qs = ["Who owns this work?", "Did the tests really run?", "Who checked the change?"].map((q, i) => { const k = kinetic(q, "kin display", { position: "absolute", left: "160px", top: `${250 + i * 150}px`, fontSize: "88px" }); intro.append(k.el); return k; });
    const gitLine = pos(h("div", { class: "abs mono", style: { fontSize: "26px", color: "var(--text-muted)" }, html: "git log: <span style='color:var(--text)'>commits</span>, and nothing about these" }), 166, 730);
    intro.append(gitLine);
    const panels = [];
    const panel = (i, q, proof) => {
      const p = region(PX(i) - 960, 0);
      world.append(p);
      const k = kinetic(q, "kin display", { position: "absolute", left: "120px", top: "90px", fontSize: "70px", width: "1700px" });
      const L = pos(h("div", { class: "card side", style: { width: "820px", height: "560px", padding: "22px 26px", background: "rgba(255,77,116,.035)", borderColor: "rgba(255,77,116,.35)" } }, h("div", { class: "label", text: "With Git alone · an illustration", style: { color: "var(--fault)" } })), 120, 230);
      const R = pos(h("div", { class: "card side", style: { width: "820px", height: "560px", padding: "22px 26px", borderColor: "var(--observed-line)" } }, h("div", { class: "label", text: "With Atelier", style: { color: "var(--observed)" } })), 980, 230);
      const pr = pos(h("div", { class: "abs mono proof", style: { fontSize: "21px", color: "var(--signal)" }, html: proof }), 1004, 830);
      p.append(k.el, L, R, pr);
      const o = { p, k, L, R, pr, i, sL: svgFull(820, 560), sR: svgFull(820, 560) };
      L.append(o.sL); R.append(o.sR);
      panels.push(o);
      return o;
    };
    const inBox = (box, el2, x, y) => { pos(el2, x, y); if (!el2.classList.contains("abs") && !el2.classList.contains("card")) el2.classList.add("abs"); box.append(el2); return el2; };
    // 1 Ownership.
    const p1 = panel(1, "Who owns this work?", `the ledger: ${f.handoffs} handoffs, each recorded, each revoking a token`);
    p1.sL.append(s("line", { x1: 40, y1: 300, x2: 780, y2: 300, stroke: "#8f9cab", "stroke-width": 4 }));
    p1.sL.append(s("text", { x: 40, y: 280, fill: "#8f9cab", "font-size": 20, text: "one branch, two agents" }));
    const cA = [0, 1, 2, 3].map((i) => { const c1 = s("circle", { cx: 120 + i * 160, cy: 300, r: 12, fill: i % 2 ? "#3fe0b0" : "#ff8a5b" }); p1.sL.append(c1); return c1; });
    const clash = s("text", { x: 600, y: 380, fill: "#ff4d74", "font-size": 30, text: "✕ conflict" }); p1.sL.append(clash);
    const own = inBox(p1.R, h("div", { class: "card", style: { padding: "18px 22px", width: "520px" } }, h("div", { class: "label", text: "task" }), h("div", { class: "mono", style: { fontSize: "24px", marginTop: "10px" }, html: "owner <span style='color:var(--m-anthropic)'>agent A 🔒</span><br><span style='color:var(--signal)'>🔑 write token: its own fork only</span><br><span class='dim'>a handoff revokes it</span>" })), 60, 120);
    const refusedB = inBox(p1.R, h("div", { class: "abs mono", text: "agent B's claim: refused", style: { fontSize: "24px", color: "var(--fault)" } }), 60, 380);
    // 2 Tests.
    const p2 = panel(2, "Did the tests really run?", `the ledger: ${f.observedChecks.toLocaleString("en")} observed check results`);
    const say = inBox(p2.L, h("div", { class: "card", style: { padding: "18px 24px", font: "500 34px/1.3 var(--font-sans)" } }, "“tests pass ✓”", h("div", { class: "mono dim", text: "the agent's word", style: { fontSize: "18px", marginTop: "8px" } })), 120, 160);
    const qm = inBox(p2.L, h("div", { class: "abs display", text: "?", style: { fontSize: "160px", color: "var(--fault)" } }), 560, 120);
    const runs = inBox(p2.R, h("div", { class: "card", style: { padding: "18px 22px", width: "560px" } }, h("div", { class: "label", text: "Atelier runs them: a clean clone of the exact head" }), h("div", { class: "mono", style: { fontSize: "24px", marginTop: "12px", lineHeight: "1.8" }, html: "<div class='r1'><span style='color:var(--observed)'>✓ Observed</span> npm test</div><div class='r2'><span style='color:var(--observed)'>✓ Observed</span> typecheck</div><div class='r3 dim'>no pass at this head → no accept</div>" })), 60, 110);
    // 3 Review.
    const p3 = panel(3, "Who checked the change?", `the ledger: ${f.modelReviews} reviews by models · <span class="n1">0</span> sent back · <span class="n2">0</span> blocking findings`);
    const selfA = inBox(p3.L, h("div", { class: "abs" }, famChip("anthropic", "the author")), 120, 200);
    const selfB = inBox(p3.L, h("div", { class: "abs" }, famChip("anthropic", "the same model family"), h("span", { class: "mono", text: "  “looks right”", style: { fontSize: "24px", color: "var(--text-muted)" } })), 120, 330);
    const r3a = inBox(p3.R, h("div", { class: "abs" }, famChip("anthropic", "the author")), 60, 140);
    const r3b = inBox(p3.R, h("div", { class: "abs", style: { display: "flex", gap: "14px", alignItems: "center" } }, famChip("anthropic", "same family"), h("span", { class: "mono", text: "✕ does not count", style: { fontSize: "22px", color: "var(--fault)" } })), 60, 250);
    const r3c = inBox(p3.R, h("div", { class: "abs", style: { display: "flex", gap: "14px", alignItems: "center" } }, famChip("google", "another family"), h("span", { class: "mono", text: "✓ required to approve", style: { fontSize: "22px", color: "var(--observed)" } })), 60, 340);
    // 4 Main.
    const p4 = panel(4, "Is main still sound after merging?", "t278: three landings, merged as 5af22431 at the approved head");
    p4.sL.append(s("line", { x1: 40, y1: 420, x2: 780, y2: 420, stroke: "#8f9cab", "stroke-width": 5, class: "mainL" }));
    const m4a = s("path", { d: "M 120 200 C 300 200, 330 420, 460 420", fill: "none", stroke: "#ff8a5b", "stroke-width": 4 });
    const m4b = s("path", { d: "M 160 300 C 320 300, 360 420, 470 420", fill: "none", stroke: "#6f9bff", "stroke-width": 4 });
    p4.sL.append(m4a, m4b);
    const broke = s("text", { x: 500, y: 480, fill: "#ff4d74", "font-size": 28, text: "✕ main fails its tests" }); p4.sL.append(broke);
    const steps = ["landing lease: one at a time", "merge main into the task", "run the checks again", "review by another family", "accept the reviewed head", "merge exactly that head"].map((x, i) => inBox(p4.R, h("div", { class: "abs mono", style: { fontSize: "23px" }, html: `<span style="color:var(--signal)">${i + 1}</span>  ${x}` }), 60, 90 + i * 62));
    const planNote = inBox(p4.R, h("div", { class: "abs mono dim", text: "a plan's parts meet first on the plan's own branch", style: { fontSize: "20px" } }), 60, 480);
    // 5 Inbox.
    const p5 = panel(5, "What needs me now?", "real output of atelier show t278");
    const prs = Array.from({ length: 9 }, (_, i) => inBox(p5.L, h("div", { class: "card", style: { padding: "10px 16px", width: "420px", font: "500 20px/1.2 var(--font-mono)" } }, `pull request #${101 + i * 7}  · review?`), 120 + i * 28, 70 + i * 46));
    const recLine = data.terminal.t278.split("\n").find((x) => x.startsWith("Recommendation")) ?? "";
    const revLine = data.terminal.t278.split("\n").find((x) => x.startsWith("Reviews at this revision")) ?? "";
    const inbox = inBox(p5.R, h("div", { class: "card", style: { padding: "18px 22px", width: "740px" } }, h("div", { class: "label", text: "a decision brief" }), h("div", { class: "mono", style: { fontSize: "19px", marginTop: "10px", lineHeight: "1.55" }, html: `${esc(revLine)}<br><span style="color:var(--signal)">${esc(recLine)}</span>` })), 40, 90);
    const land = inBox(p5.R, h("div", { class: "abs mono", style: { fontSize: "26px" }, html: "<span style='color:var(--observed)'>$</span> atelier land t278 <span class='dim'> one command lands a task</span>" }), 40, 400);
    // 6 Models.
    const p6 = panel(6, "Which model is worth it?", "each model's record on the Models page; AI Gateway figures from GraphQL Analytics");
    const qms = ["anthropic", "zai", "openai", "google", "deepseek"].map((x, i) => inBox(p6.L, h("div", { class: "abs", style: { display: "flex", gap: "16px", alignItems: "center" } }, famChip(x, { anthropic: "Claude", zai: "GLM", openai: "GPT", google: "Gemini", deepseek: "DeepSeek" }[x]), h("span", { class: "display", text: "?", style: { fontSize: "40px", color: "var(--text-dim)" } })), 120, 90 + i * 80));
    const models = Object.entries(f.reviewsByModel).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = models[0][1];
    const bars = models.map(([m, n], i) => {
      const rj = f.rejectionsByModel[m] ?? 0;
      return inBox(p6.R, h("div", { class: "abs", style: { display: "flex", alignItems: "center", gap: "12px" } },
        h("div", { class: "mono", text: NAMES[m] ?? m, style: { width: "240px", fontSize: "18px", color: col(fam(m)), textAlign: "right" } }),
        h("div", { class: "bar", style: { position: "relative", height: "18px", width: `${n / max * 360}px`, background: col(fam(m)), opacity: 0.85, borderRadius: "3px" } }, h("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: `${rj / n * 100}%`, background: "var(--fault)", borderRadius: "3px" } })),
        h("div", { class: "mono dim", text: `${n} reviews · ${rj} sent back`, style: { fontSize: "16px" } })), 20, 90 + i * 50);
    });
    const gw = inBox(p6.R, h("div", { class: "abs mono", style: { fontSize: "20px", color: "var(--text-muted)" }, text: "AI Gateway: calls · failures · tokens · cost · median and p90 latency" }), 40, 420);
    // 7 Provenance.
    const p7 = panel(7, "What happened, and who did it?", "git notes --ref=atelier show 5af22431, the merge of t278");
    const commit = inBox(p7.L, h("div", { class: "card", style: { padding: "18px 22px", width: "660px", font: "400 22px/1.6 var(--font-mono)" } }, "commit a1b2c3d", h("br"), h("span", { class: "dim", text: "an example commit message" }), h("br"), h("span", { text: "Co-Authored-By: a model", style: { color: "var(--text-muted)" } }), h("div", { class: "dim", text: "a claim in a message; nothing checks it", style: { fontSize: "18px", marginTop: "10px", color: "var(--fault)" } })), 80, 120);
    const note = inBox(p7.R, h("div", { class: "card", style: { padding: "18px 22px", width: "760px" } }, h("div", { class: "label", text: "the provenance note on the merge, refs/notes/atelier" }), h("pre", { class: "mono", style: { fontSize: "15px", lineHeight: "1.6", whiteSpace: "pre-wrap", margin: "12px 0 0", color: "var(--text)" }, text: data.terminal.note })), 30, 90);
    const n1 = p3.pr.querySelector(".n1"), n2 = p3.pr.querySelector(".n2");
    [[3, 1.8, "reject"], [4, 2.0, "reject"]].forEach(([i, d, type]) => c.sfx(starts[i] + d, type, 0.6));
    [1, 2, 3, 4, 5, 6, 7].forEach((i) => c.sfx(starts[i] + 3.4, "approve", 0.45));
    return {
      el,
      update(t) {
        const view = cam.set(t, keys, 0.7);
        qs.forEach((k, i) => k.update(P(t, 0.3 + i * 1.1, 1.1)));
        gitLine.style.opacity = P(t, c.when("Git records commits"), 0.6);
        panels.forEach((p) => {
          const q = t - starts[p.i];
          p.k.update(P(q, -0.4, 1.0));
          fadeIn(p.L, P(q, 0.0, 0.5), 16);
          fadeIn(p.R, P(q, 1.8, 0.6), 16);
          p.L.style.filter = `grayscale(${0.3 + 0.5 * P(q, 2.4, 0.8)})`;
          p.L.style.opacity = P(q, 0, 0.5) * lerp(1, 0.75, P(q, 2.4, 0.8));
          fadeIn(p.pr, P(q, 3.0, 0.6), 8);
        });
        { const q = t - starts[1]; cA.forEach((x, i) => (x.style.opacity = P(q, 0.3 + i * 0.25, 0.3))); clash.style.opacity = P(q, 1.3, 0.3); pop(own, P(q, 2.0, 0.5), 0.8); refusedB.style.opacity = P(q, 2.8, 0.4); }
        { const q = t - starts[2]; pop(say, P(q, 0.2, 0.5), 0.8); qm.style.opacity = P(q, 1.0, 0.4); fadeIn(runs, P(q, 1.9, 0.5)); ["r1", "r2", "r3"].forEach((x, i) => (runs.querySelector("." + x).style.opacity = P(q, 2.3 + i * 0.5, 0.3))); }
        { const q = t - starts[3]; fadeIn(selfA, P(q, 0.2, 0.4)); fadeIn(selfB, P(q, 0.8, 0.4)); fadeIn(r3a, P(q, 1.9, 0.4)); fadeIn(r3b, P(q, 2.3, 0.4)); fadeIn(r3c, P(q, 2.8, 0.4));
          count(n1, f.modelRejections, (q - 3.2) / 1.6); count(n2, f.blockingFindings, (q - 3.5) / 1.6); }
        { const q = t - starts[4]; draw(m4a, P(q, 0.2, 0.8)); draw(m4b, P(q, 0.5, 0.8)); broke.style.opacity = P(q, 1.4, 0.3); p4.sL.querySelector(".mainL").setAttribute("stroke", q > 1.4 ? "#ff4d74" : "#8f9cab");
          steps.forEach((x, i) => fadeIn(x, P(q, 2.0 + i * 0.55, 0.35), 8)); planNote.style.opacity = P(q, c.when("Plans are integrated") - starts[4], 0.5); }
        { const q = t - starts[5]; prs.forEach((x, i) => fadeIn(x, P(q, 0.1 + i * 0.12, 0.3), -20)); fadeIn(inbox, P(q, 2.0, 0.5)); fadeIn(land, P(q, c.when("one command lands") - starts[5], 0.5)); }
        { const q = t - starts[6]; qms.forEach((x, i) => fadeIn(x, P(q, 0.1 + i * 0.15, 0.3))); bars.forEach((x, i) => { fadeIn(x, P(q, 1.9 + i * 0.12, 0.3), 6); const b = x.querySelector(".bar"); b.style.transformOrigin = "0 50%"; b.style.transform = `scaleX(${P(q, 2.0 + i * 0.12, 0.7)})`; }); gw.style.opacity = P(q, c.when("calls through Cloudflare") - starts[6], 0.5); }
        { const q = t - starts[7]; fadeIn(commit, P(q, 0.2, 0.5)); fadeIn(note, P(q, 1.9, 0.6)); }
        return view;
      },
    };
  };

  // The five tasks held at once and the t50 handoff, from the ledger.
  function forksReal(data, root, tB, tC, tHand) {
    const B = region(0, 0);
    root.append(B);
    const held = data.moment.held;
    const head = pos(h("div", { class: "abs" }, h("div", { class: "label", text: `${day(data.moment.at)} 2026 · ${utc(data.moment.at)} · from the ledger: ${held.length} tasks held at once` })), 140, 100);
    B.append(head);
    const svg = svgFull();
    const MAINY = 190;
    svg.append(s("line", { x1: 120, y1: MAINY, x2: 1800, y2: MAINY, stroke: "#f4f1e8", "stroke-width": 4 }));
    svg.append(s("text", { x: 120, y: MAINY - 18, fill: "var(--text-muted)", "font-size": 20, text: "main · the baseline repository in Artifacts" }));
    const lanes = held.map((hd, i) => {
      const y = 300 + i * 118, x0 = 220 + i * 70;
      const color = HEX[fam(hd.actor)];
      const p = s("path", { d: `M ${x0} ${MAINY} C ${x0} ${y - 40}, ${x0 + 20} ${y}, ${x0 + 90} ${y} L 1290 ${y}`, fill: "none", stroke: color, "stroke-width": 4 });
      svg.append(p);
      const b = beads(svg, `M ${x0 + 120} ${y} L 1290 ${y}`, color, 3, 7);
      const label = pos(h("div", { class: "abs" }, h("span", { class: "mono", text: hd.id + "  ", style: { fontSize: "22px", color: "var(--text)" } }), chip(hd.actor)), x0 + 110, y - 62);
      const repo = pos(h("div", { class: "abs mono", style: { fontSize: "18px", lineHeight: "1.35" }, html: `<span class="dim">Artifacts</span> cloudflare-git--${hd.id}<br><span class="dim">write token</span> <span style="color:${color}">${esc(hd.actor)}</span> only` }), 1320, y - 26);
      B.append(label, repo);
      return { p, b, label, repo };
    });
    B.prepend(svg);
    const C = region(1920, 0);
    root.append(C);
    const ho = data.stories.t50.handoffs[0];
    const svgC = svgFull();
    const yC = 470;
    svgC.append(s("line", { x1: 140, y1: 300, x2: 1800, y2: 300, stroke: "#f4f1e8", "stroke-width": 4 }));
    const fableP = s("path", { d: `M 220 300 C 220 ${yC - 40}, 240 ${yC}, 320 ${yC} L 960 ${yC}`, fill: "none", stroke: HEX[fam(ho.from)], "stroke-width": 5 });
    const glmP = s("path", { d: `M 960 ${yC} L 1640 ${yC}`, fill: "none", stroke: HEX[fam(ho.to)], "stroke-width": 5 });
    const knot = s("circle", { cx: 960, cy: yC, r: 11, fill: "#ffd166" });
    knot.style.filter = "drop-shadow(0 0 12px #ffd166)";
    svgC.append(fableP, glmP, knot);
    C.append(svgC);
    const cHead = pos(h("div", { class: "abs" }, h("div", { class: "label", text: `Task t50 · item.handoff · ${ho.at.slice(0, 10)} ${utc(ho.at, true)}` })), 140, 200);
    const from = pos(h("div", { class: "abs" }, chip(ho.from)), 420, yC + 34);
    const to = pos(h("div", { class: "abs" }, chip(ho.to)), 1100, yC + 34);
    const tokenOld = pos(h("div", { class: "abs mono", style: { fontSize: "20px", color: "var(--text-muted)" }, html: "🔑 write token" }), 420, yC + 92);
    const revoked = pos(h("div", { class: "abs mono", text: "revoked", style: { fontSize: "20px", color: "var(--fault)" } }), 600, yC + 92);
    const tokenNew = pos(h("div", { class: "abs mono", style: { fontSize: "20px", color: "var(--signal)" }, html: "🔑 new write token" }), 1100, yC + 92);
    const quote = pos(h("div", { class: "abs quote", style: { borderLeftColor: "var(--signal)", width: "1400px" }, html: `“${esc(ho.note)}”<span class="src">the handoff's note, as the ledger holds it</span>` }), 260, 700);
    C.append(cHead, from, to, tokenOld, revoked, tokenNew, quote);
    return (t) => {
      fadeIn(head, P(t, tB, 0.6));
      lanes.forEach((ln, i) => {
        draw(ln.p, P(t, tB + 0.4 + i * 0.45, 1.6));
        fadeIn(ln.label, P(t, tB + 0.9 + i * 0.45, 0.5), 10);
        fadeIn(ln.repo, P(t, tB + 2.2 + i * 0.45, 0.5), 10);
        ln.b.update(t, tB + 2.0 + i * 0.4, 2.6 + i * 0.3, P(t, tB + 2 + i * 0.4, 0.4));
      });
      draw(fableP, P(t, tC + 0.3, 3.0));
      knot.style.opacity = P(t, tHand - 0.6, 0.4);
      draw(glmP, P(t, tHand + 1.2, 4));
      fadeIn(cHead, P(t, tC, 0.6));
      fadeIn(from, P(t, tC + 0.8, 0.5));
      fadeIn(tokenOld, P(t, tC + 1.2, 0.5));
      tokenOld.style.textDecoration = t > tHand + 0.7 ? "line-through" : "none";
      revoked.style.opacity = P(t, tHand + 0.6, 0.4);
      fadeIn(to, P(t, tHand + 0.3, 0.5));
      fadeIn(tokenNew, P(t, tHand + 0.9, 0.5));
      fadeIn(quote, P(t, tHand + 2.2, 0.8));
    };
  }

  SCENES.forks = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 3840, 1080);
    const R = region(0, 0, 3840, 1080);
    world.append(R);
    const tHand = c.when("GLM-5.3 took the task");
    const real = forksReal(data, R, c.cue(0) + 0.2, c.cue(1), tHand);
    c.sfx(c.cue(1) - 0.5, "whoosh", 0.7); c.sfx(tHand, "chime", 0.6);
    const keys = flight([[0, 960, 540, 1.04], [c.cue(1) - 0.5, 2880, 540, 1.0]], 1.3, 0.82);
    return { el, update(t) { const view = cam.set(t, keys); real(t); return view; } };
  };

  SCENES.gate = (c, data) => {
    const st = data.stories.t278;
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 3840, 1080);
    // A: the idea.
    const A = region(0, 0); world.append(A);
    const sA = svgFull(); A.append(sA);
    const q0 = kinetic("The gate", "kin display", { position: "absolute", left: "150px", top: "200px", fontSize: "110px" });
    A.append(q0.el);
    const nodes = [["pushed head", "read from Artifacts", 160], ["clean clone", "of exactly that revision", 520], ["required checks", "run by Atelier", 880], ["review", "by another family", 1240], ["owner", "accepts and merges", 1580]].map(([a, b, x]) => {
      const n = pos(h("div", { class: "card", style: { padding: "16px 20px", width: "300px" } }, h("div", { style: { font: "600 26px/1.2 var(--font-sans)" }, text: a }), h("div", { class: "mono dim", text: b, style: { fontSize: "18px", marginTop: "6px" } })), x, 560);
      A.append(n); return n;
    });
    const edges = [0, 1, 2, 3].map((i) => beads(sA, `M ${[460, 820, 1180, 1540][i]} 610 L ${[520, 880, 1240, 1580][i]} 610`, "#ffd166", 1, 6));
    const flowAll = beads(sA, "M 160 700 L 1880 700", "#ffd166", 5, 5);
    const obsTag = pos(h("div", { class: "abs stamp", text: "Observed", style: { color: "var(--observed)", fontSize: "24px" } }), 905, 700);
    const repTag = pos(h("div", { class: "abs mono", html: "an agent's own word → <b style='color:var(--text-muted)'>Reported</b>: shown, never counted", style: { fontSize: "22px", color: "var(--text-dim)" } }), 160, 800);
    const famRow = pos(h("div", { class: "abs", style: { display: "flex", gap: "12px", alignItems: "center" } }, h("span", { class: "chip x1", style: { color: col("anthropic"), textDecoration: "line-through", opacity: 0.5 } }, h("span", { class: "dot" }), "same family"), famChip("google", "another family ✓")), 1180, 700);
    A.append(obsTag, repTag, famRow);
    // B: t278, from the ledger.
    const B = region(1920, 0); world.append(B);
    const L = st.landing;
    const header = pos(h("div", { class: "abs" },
      h("div", { class: "label", text: `Task t278 · ${day(st.mergedAt)} 2026 · built by` }),
      h("div", { style: { display: "flex", alignItems: "center", gap: "22px", marginTop: "10px" } },
        h("div", { class: "display", text: "Pull AI Gateway's logs", style: { fontSize: "54px" } }), chip(st.builders[0]))), 120, 92);
    B.append(header);
    const pushes = L.filter((e) => e.kind === "push.observed");
    const rounds = pushes.map((p) => ({ head: p.head, pushedAt: p.at, checks: L.filter((e) => e.kind === "evidence.observed" && e.head === p.head), review: st.reviews.find((r) => r.head === p.head) }));
    const COLS = [120, 470, 900, 1330];
    const colHead = ["Revision pushed", "Required checks, clean clone", "Review, another family", "Verdict"].map((x, i) => pos(h("div", { class: "abs label", text: x }), COLS[i], 236));
    B.append(...colHead);
    const rows = rounds.map((r, i) => {
      const y = 280 + i * 108;
      const head = pos(h("div", { class: "abs mono", style: { fontSize: "22px" }, html: `<span style="color:var(--text-bright)">${r.head}</span><br><span class="dim">${utc(r.pushedAt, true)}</span>` }), COLS[0], y);
      const checks = pos(h("div", { class: "abs mono", style: { fontSize: "21px", lineHeight: "1.5" } }, ...r.checks.map((ck) => h("div", { html: `<span style="color:var(--observed)">✓ observed</span> <span class="dim">${esc(ck.claim.split("&&").pop().trim())}</span>` }))), COLS[1], y);
      const rev = pos(h("div", { class: "abs" }, chip(r.review.by)), COLS[2], y + 6);
      const verdict = pos(h("div", { class: "abs" }, h("span", { class: "stamp", text: r.review.approve ? "approved" : "rejected", style: { color: r.review.approve ? "var(--observed)" : "var(--fault)" } }), h("span", { class: "mono dim", text: "  " + utc(r.review.at, true), style: { fontSize: "19px" } })), COLS[3], y + 2);
      B.append(head, checks, rev, verdict);
      const ring = pulseRing(B, COLS[3] + 90, y + 24, r.review.approve ? "var(--observed)" : "var(--fault)");
      return { head, checks, rev, verdict, ring };
    });
    const panel = (...kids) => { const p = pos(h("div", { class: "abs" }, ...kids), 120, 640, 1680); B.append(p); return p; };
    const findingsPanel = (r, title, verdicts) => panel(
      h("div", { class: "label", text: title }),
      h("div", { style: { display: "grid", gridTemplateColumns: `repeat(${r.review.findings.filter((f) => f.severity === "blocking").length}, 1fr)`, gap: "40px", marginTop: "16px" } },
        ...r.review.findings.filter((f) => f.severity === "blocking").map((f, i) => h("div", { class: "quote", html: `“${quoteHtml(f.text)}”<span class="src">${esc(f.file)}:${f.line} · blocking${verdicts[i] ? `<span style="color:var(--observed)"> · owner's verdict: ${esc(verdicts[i].verdict)}</span>` : ""}</span>` }))));
    const pF1 = findingsPanel(rounds[0], `Gemini 3.1 Pro's findings at ${rounds[0].head}, quoted`, st.verdicts.filter((v) => v.head === rounds[0].head));
    const pF2 = findingsPanel(rounds[1], `Its finding at ${rounds[1].head}, quoted`, st.verdicts.filter((v) => v.head === rounds[1].head));
    const acc = L.find((e) => e.kind === "item.accepted"), mer = L.find((e) => e.kind === "item.merged");
    const last = rounds.at(-1);
    const pMerge = panel(h("div", { class: "label", text: "The end of the landing, from the ledger" }),
      h("div", { class: "mono", style: { fontSize: "26px", marginTop: "18px", lineHeight: "1.7" }, html:
        `<span style="color:var(--observed)">review.approved</span>&nbsp;&nbsp;${esc(last.review.by)}&nbsp;&nbsp;<span class="dim">${utc(last.review.at, true)}</span><br>` +
        `<span style="color:var(--signal)">item.accepted</span>&nbsp;&nbsp;&nbsp;&nbsp;head ${last.head}&nbsp;&nbsp;<span class="dim">${utc(acc.at, true)}</span><br>` +
        `<span style="color:var(--main-line)">item.merged</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;as ${mer.mergeCommit}&nbsp;&nbsp;<span class="dim">${utc(mer.at, true)}</span>` }));
    const shot = browser("t278", "atelier.zone<b>/p/atelier/t278</b>", "captured from the live site");
    const shot2 = browser("t278", "atelier.zone<b>/p/atelier/t278</b>", "captured from the live site");
    el.append(shot.el, shot2.el);
    const tint = h("div", { class: "abs tint", style: { inset: 0, pointerEvents: "none" } });
    el.append(tint);
    const marks = data.screens.t278.marks;
    const thread = marks["Thread"].y - 40, reviewsY = marks["Checks and reviews"].y - 30;
    // Beats.
    const tB = c.when("Opus 5.5 built task");
    const R = [
      { head: tB + 3.2, checks: c.when("Its checks were observed"), rev: c.when("so Gemini 3.1 Pro"), verdict: c.cue(1) + 0.2 },
      { head: c.cue(2) + 0.3, checks: c.cue(2) + 0.9, rev: c.cue(2) + 1.4, verdict: c.when("Gemini rejected the second") + 0.4 },
      { head: c.cue(3) - 0.4, checks: c.cue(3) + 0.1, rev: c.cue(3) + 0.5, verdict: c.cue(3) + 1.2 },
    ];
    R.forEach((r, i) => c.sfx(r.verdict, i < 2 ? "reject" : "approve", 1));
    c.sfx(tB + 2.0, "whoosh", 0.8);
    c.sfx(c.when("merged eleven seconds") + 1.2, "chime", 0.8);
    const ts = c.cueEnd(3) + 0.5;
    const keys = [[0, 900, 600, 1.1], [tB + 2.0, 1000, 580, 1.0], [tB + 3.2, 2880, 540, 1.0], [c.cue(2), 2880, 560, 1.0], [c.cue(3), 2880, 540, 1.0]];
    return {
      el,
      update(t) {
        const view = cam.set(t, keys);
        q0.update(P(t, 0.1, 0.9));
        nodes.forEach((n, i) => pop(n, P(t, 0.3 + i * 0.3, 0.4), 0.85));
        edges.forEach((e, i) => e.update(t, 0.6 + i * 0.3, 0.9, 1));
        flowAll.update(t, 1.2, 3.0, P(t, 1.2, 0.4) * 0.7);
        pop(obsTag, P(t, 1.6, 0.4), 1.4);
        fadeIn(repTag, P(t, 1.9, 0.5));
        fadeIn(famRow, P(t, 2.2, 0.5));
        famRow.querySelector(".x1").style.opacity = lerp(1, 0.45, P(t, 2.6, 0.4));
        fadeIn(header, P(t, tB + 2.6, 0.7));
        colHead.forEach((x, i) => fadeIn(x, P(t, tB + 3.0 + i * 0.15, 0.5), 8));
        rows.forEach((r, i) => {
          fadeIn(r.head, P(t, R[i].head, 0.5), 10);
          [...r.checks.children].forEach((x, j) => fadeIn(x, P(t, R[i].checks + j * 0.5, 0.4), 6));
          fadeIn(r.rev, P(t, R[i].rev, 0.5), 10);
          const k = P(t, R[i].verdict, 0.35);
          r.verdict.style.opacity = k; r.verdict.style.transform = `scale(${lerp(1.6, 1, k)})`; r.verdict.style.transformOrigin = "0 50%";
          r.ring.update(t, R[i].verdict);
        });
        // A red wash on each rejection, a green one on approval.
        const wash = (a, color) => Math.max(0, 1 - Math.abs(t - a - 0.25) / 0.7) * (t > a ? 1 : 0);
        const red = Math.max(wash(R[0].verdict), wash(R[1].verdict)), green = wash(R[2].verdict);
        tint.style.boxShadow = red > 0 ? `inset 0 0 ${240 * red}px rgba(255,77,116,${0.55 * red})` : green > 0 ? `inset 0 0 ${240 * green}px rgba(95,224,143,${0.5 * green})` : "none";
        const win = (p, a, b) => { p.style.display = t >= a && t < b + 0.4 ? "block" : "none"; p.style.opacity = P(t, a, 0.5) * (1 - P(t, b, 0.4)); };
        win(pF1, R[0].verdict + 0.6, c.when("Both were fixed") + 0.6);
        [...pF1.querySelectorAll(".src span")].forEach((x) => { x.style.opacity = P(t, c.when("Both were fixed"), 0.4); });
        win(pF2, R[1].verdict + 0.6, c.cue(3));
        [...pF2.querySelectorAll(".src span")].forEach((x) => { x.style.opacity = P(t, c.when("That was fixed"), 0.4); });
        win(pMerge, c.cue(3) + 1.6, c.dur + 1);
        shot.show(t, ts, ts + 3.2);
        shot.pan(t, [[ts, thread - 40, 1.45, 360], [ts + 3.6, thread + 10, 1.45, 360]]);
        shot2.show(t, ts + 3.2);
        shot2.pan(t, [[ts + 3.2, reviewsY - 60, 1.45, 360], [c.dur, reviewsY, 1.45, 360]]);
        return view;
      },
    };
  };

  SCENES.catches = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 1920, 1080);
    const card = (id, x, rejectIdx) => {
      const st = data.stories[id];
      const rej = st.reviews.filter((r) => !r.approve);
      const r = rej[rejectIdx];
      const f = r.findings.find((x) => x.severity === "blocking");
      const ok = st.reviews.filter((x) => x.approve).at(-1);
      const first = f.text.split(/(?<=[.;])\s/)[0];
      const el2 = pos(h("div", { class: "card", style: { height: "420px" } },
        h("div", { class: "label", text: `Task ${id} · built by` }),
        h("div", { style: { display: "flex", gap: "12px", margin: "12px 0 18px", flexWrap: "wrap" } }, ...st.builders.map((b) => chip(b))),
        h("div", { style: { display: "flex", gap: "14px", alignItems: "center" } }, h("span", { class: "label", text: "reviewed by" }), chip(r.by),
          h("span", { class: "stamp rej", text: rej.length > 1 ? `rejected ×${rej.length}` : "rejected", style: { color: "var(--fault)", fontSize: "20px" } })),
        h("div", { class: "quote", style: { marginTop: "20px", fontSize: "22px" }, html: `“${quoteHtml(first)}”<span class="src">${esc(f.file)}:${f.line} · ${utc(r.at)}, ${day(r.at)}</span>` }),
        h("div", { class: "mono ok", style: { position: "absolute", bottom: "20px", fontSize: "20px", color: "var(--observed)" }, text: `fixed · approved by ${nice(ok.by)} ${utc(ok.at)} · merged` })), x, 112, 820);
      world.append(el2);
      return el2;
    };
    const a = card("t219", 120, 0), b = card("t252", 980, 1);
    const f = data.facts;

    const models = Object.entries(f.reviewsByModel).sort((x, y) => y[1] - x[1]);
    const max = models[0][1];
    const chart = pos(h("div", { class: "abs" }, h("div", { class: "label", text: "Reviews (bar) and rejections (red) by reviewing model, atelier project", style: { marginBottom: "10px" } }),
      ...models.map(([m, n]) => {
        const rj = f.rejectionsByModel[m] ?? 0;
        return h("div", { style: { display: "flex", alignItems: "center", gap: "12px", height: "33px" } },
          h("div", { class: "mono", text: NAMES[m] ?? m, style: { width: "260px", fontSize: "18px", color: col(fam(m)), textAlign: "right" } }),
          h("div", { class: "bar", style: { position: "relative", height: "18px", width: `${n / max * 420}px`, background: col(fam(m)), opacity: 0.85, borderRadius: "3px" } },
            h("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: `${rj / n * 100}%`, background: "var(--fault)", borderRadius: "3px" } })),
          h("div", { class: "mono dim", text: `${n} · ${rj}`, style: { fontSize: "17px" } }));
      })), 560, 568);
    world.append(chart);
    const tb = c.when("Gemini found in t252");
    c.sfx(c.cue(0) + 4, "reject", 0.5); c.sfx(tb + 1.5, "reject", 0.5);
    const tz = c.when("Both were fixed");
    return {
      el,
      update(t) {
        const view = cam.set(t, [[0, 900, 380, 1.12], [tb, 1060, 380, 1.12], [tz, 960, 560, 1.0]]);
        fadeIn(a, P(t, c.cue(0) + 0.4, 0.7));
        a.querySelector(".rej").style.opacity = P(t, c.cue(0) + 4.0, 0.4);
        a.querySelector(".quote").style.opacity = P(t, c.cue(0) + 4.6, 0.6);
        a.querySelector(".ok").style.opacity = P(t, tz, 0.5);
        fadeIn(b, P(t, tb, 0.7));
        b.querySelector(".rej").style.opacity = P(t, tb + 1.5, 0.4);
        b.querySelector(".quote").style.opacity = P(t, tb + 2.2, 0.6);
        b.querySelector(".ok").style.opacity = P(t, tz + 0.4, 0.5);
        fadeIn(chart, P(t, tz + 0.4, 0.6));
        [...chart.querySelectorAll(".bar")].forEach((x, i) => { x.style.transformOrigin = "0 50%"; x.style.transform = `scaleX(${P(t, tz + 0.6 + i * 0.12, 0.7)})`; });
        return view;
      },
    };
  };

  SCENES.plan = (c, data) => {
    const pl = data.plan;
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 3840, 1080);
    // A: the idea.
    const A = region(0, 0); world.append(A);
    const sA = svgFull(); A.append(sA);
    const ttl = kinetic("A goal becomes a plan", "kin display", { position: "absolute", left: "150px", top: "100px", fontSize: "64px" });
    A.append(ttl.el);
    const goalA = pos(h("div", { class: "card", style: { padding: "16px 26px", font: "600 28px/1.2 var(--font-sans)" } }, "a goal ", h("span", { class: "mono dim", text: " → planner model", style: { fontSize: "20px" } })), 160, 250);
    const hashA = pos(h("div", { class: "abs stamp", text: "approved once, by its hash", style: { color: "var(--signal)", fontSize: "22px" } }), 1200, 250);
    A.append(goalA, hashA);
    const fams = [["anthropic", "google"], ["zai", "anthropic"], ["openai", "zai"], ["google", "openai"]];
    const partsA = fams.map(([b, r], i) => {
      const x = 200 + i * 400, y = 430;
      const n = pos(h("div", { class: "card", style: { padding: "14px 20px", width: "320px", borderWidth: "3px", font: "500 22px/1.3 var(--font-mono)" } }, `part ${i + 1}`, h("div", { class: "who", style: { fontSize: "17px", marginTop: "6px" }, html: `<span style="color:${HEX[b]}">builder</span> · <span style="color:${HEX[r]}">reviewer</span>` })), x, y);
      A.append(n);
      const path = s("path", { d: `M ${x + 160} ${y + 96} C ${x + 160} 700, ${x + 260} 760, ${x + 340} 760`, fill: "none", stroke: HEX[b], "stroke-width": 3 });
      sA.append(path);
      return { n, b, r, path, x };
    });
    for (let i = 0; i < 3; i++) sA.append(s("path", { class: "dep", d: `M ${200 + i * 400 + 320} 475 L ${200 + (i + 1) * 400} 475`, stroke: "var(--line-bright)", "stroke-width": 3, fill: "none" }));
    const branchA = s("line", { x1: 160, y1: 760, x2: 1700, y2: 760, stroke: "#ffd166", "stroke-width": 5 });
    const toMainA = s("path", { d: "M 1700 760 C 1760 760, 1760 880, 1820 880", fill: "none", stroke: "#ffd166", "stroke-width": 5 });
    sA.append(branchA, toMainA, s("line", { x1: 160, y1: 880, x2: 1880, y2: 880, stroke: "#f4f1e8", "stroke-width": 5 }));
    sA.append(s("text", { x: 160, y: 745, fill: "var(--signal)", "font-size": 20, text: "the plan's branch · an integrator merges each approved part" }));
    sA.append(s("text", { x: 160, y: 865, fill: "var(--text-muted)", "font-size": 20, text: "main" }));
    // B: plan t197.
    const B = region(1920, 0); world.append(B);
    const tCreated = data.tasks.find((t) => t.id === "t197").createdAt;
    const goal = pos(h("div", { class: "card", style: { padding: "18px 24px" } },
      h("div", { class: "label", text: `Plan t197 · the owner's goal · ${day(tCreated)} 2026, ${utc(tCreated)}` }),
      h("div", { style: { font: "500 26px/1.4 var(--font-sans)", marginTop: "8px", color: "var(--text-bright)" }, text: pl.goal.slice(0, 200).replace(/\s+\S*$/, "") + " …" })), 120, 92, 1680);
    const planner = pos(h("div", { class: "abs", style: { display: "flex", gap: "12px", alignItems: "center" } }, h("span", { class: "label", text: "planner" }), chip(pl.planner), h("span", { class: "mono dim", text: `proposed ${pl.proposed.length} parts · ${utc(pl.proposedAt)}`, style: { fontSize: "19px" } })), 120, 262);
    const approve = pos(h("div", { class: "abs", style: { textAlign: "right" } }, h("span", { class: "stamp", text: `approved ${utc(pl.approvedAt)}`, style: { color: "var(--signal)", fontSize: "22px" } }), h("div", { class: "mono dim", text: `by its hash ${pl.hash.slice(0, 12)}…`, style: { fontSize: "18px", marginTop: "8px" } })), 1420, 244);
    B.append(goal, planner, approve);
    const depth = {};
    const byKey = Object.fromEntries(pl.proposed.map((p) => [p.key, p]));
    const dOf = (k) => depth[k] ?? (depth[k] = byKey[k].dependsOn.length ? 1 + Math.max(...byKey[k].dependsOn.map(dOf)) : 0);
    pl.proposed.forEach((p) => dOf(p.key));
    const perCol = {};
    const svg = svgFull(); B.append(svg);
    const nodes = {};
    const NW = 380, NH = 100;
    for (const p of pl.proposed) {
      const d = depth[p.key], i = (perCol[d] = (perCol[d] ?? -1) + 1);
      const x = 120 + d * 445, y = 322 + i * 110;
      const part = pl.parts.find((q) => q.key === p.key);
      const n = pos(h("div", { class: "card", style: { padding: "10px 16px", height: NH + "px", borderWidth: "2px" } },
        h("div", { class: "mono", style: { fontSize: "18px", color: "var(--text-bright)", whiteSpace: "nowrap" }, text: `${part.id}  ${p.key}` }),
        h("div", { class: "who mono", style: { fontSize: "16px", marginTop: "6px", lineHeight: "1.35" }, html:
          `<span class="dim">built</span> ${part.builders.map((b) => `<span style="color:${col(fam(b))}">${esc(nice(b))}</span>`).join(" + ")}<br><span class="dim">review</span> ${part.approvedBy.map((b) => `<span style="color:${col(fam(b))}">${esc(nice(b))}</span>`).join(", ")}` })), x, y, NW);
      B.append(n);
      nodes[p.key] = { el: n, x, y, part, d };
    }
    const edges = [];
    for (const p of pl.proposed) for (const dep of p.dependsOn) {
      const a = nodes[dep], b = nodes[p.key];
      const e = s("path", { d: `M ${a.x + NW} ${a.y + NH / 2} C ${a.x + NW + 40} ${a.y + NH / 2}, ${b.x - 40} ${b.y + NH / 2}, ${b.x} ${b.y + NH / 2}`, fill: "none", stroke: "var(--line-bright)", "stroke-width": 3 });
      svg.append(e); edges.push({ e, d: b.d });
    }
    const ints = pl.parts.filter((p) => p.integratedAt).sort((a, b) => (a.integratedAt < b.integratedAt ? -1 : 1));
    const t0 = Date.parse("2026-10-07T04:30:00Z"), t1 = Date.parse(pl.mergedAt) + 20 * 60000;
    const X = (iso) => 360 + (Date.parse(iso) - t0) / (t1 - t0) * 1340;
    const BY = 704, MY = 800;
    const branch = s("line", { x1: 320, y1: BY, x2: X(pl.mergedAt), y2: BY, stroke: "#ffd166", "stroke-width": 4 });
    const mainL = s("line", { x1: 320, y1: MY, x2: 1800, y2: MY, stroke: "#f4f1e8", "stroke-width": 4 });
    const toMain = s("path", { d: `M ${X(pl.mergedAt)} ${BY} C ${X(pl.mergedAt) + 40} ${BY}, ${X(pl.mergedAt) + 20} ${MY}, ${X(pl.mergedAt) + 70} ${MY}`, fill: "none", stroke: "#ffd166", "stroke-width": 4 });
    const bl = s("text", { x: 120, y: BY + 6, fill: "var(--signal)", "font-size": 19, text: "the plan's branch" });
    const ml = s("text", { x: 120, y: MY + 6, fill: "var(--text-muted)", "font-size": 19, text: "main" });
    svg.append(branch, mainL, toMain, bl, ml);
    const marks = ints.map((p) => {
      const x = X(p.integratedAt);
      const g = s("g", {});
      const color = HEX[fam(p.builders[0])];
      if (p.added) g.append(s("rect", { x: x - 8, y: BY - 8, width: 16, height: 16, transform: `rotate(45 ${x} ${BY})`, fill: color }));
      else g.append(s("circle", { cx: x, cy: BY, r: 10, fill: color, stroke: HEX[fam(p.approvedBy[0] ?? "")], "stroke-width": 4 }));
      g.append(s("text", { x, y: BY + [32, -20, 54, -42][ints.indexOf(p) % 4], "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 16, text: p.id }));
      svg.append(g);
      return { g, p };
    });
    const axis = s("text", { x: 1800, y: BY - 52, "text-anchor": "end", fill: "var(--text-dim)", "font-size": 16, text: `${day("2026-10-07T04:30:00Z")}, 04:30 UTC → ${utc(pl.mergedAt)}` });
    svg.append(axis);
    const addedNote = pos(h("div", { class: "abs mono dim", style: { fontSize: "17px" }, html: "◆ parts added to merge main into the branch as main moved" }), 160, 846);
    const mergedStamp = pos(h("div", { class: "abs" }, h("span", { class: "stamp", text: `merged ${utc(pl.mergedAt)}, ${day(pl.mergedAt)}`, style: { color: "var(--observed)", fontSize: "22px" } }),
      h("div", { class: "mono dim", text: `${ints.length} parts integrated · ${pl.jobsUsed} of ${pl.maxJobs} part dispatches used`, style: { fontSize: "18px", marginTop: "10px" } })), 1100, 818);
    B.append(addedNote, mergedStamp);
    const shot = browser("plans", "atelier.zone<b>/p/atelier/plans</b>", "captured from the live site");
    el.append(shot.el);
    const H = data.screens.plans.height;
    const tReal = c.cue(1);
    const tWho = c.cue(2), tInt = c.when("When main moved"), tMerged = c.cue(3);
    c.sfx(tReal - 0.5, "whoosh", 0.8); c.sfx(c.when("approved them") + 1.5, "chime", 0.6); c.sfx(tMerged + 2.5, "approve", 0.8);
    const ts = c.cueEnd(3) + 0.6;
    const tRoute = c.when("Atelier routes each part");
    const keys = [[0, 960, 520, 1.06], [tRoute, 1000, 600, 1.0], [tReal - 0.5, 1000, 600, 1.0], [tReal + 0.8, 2880, 540, 1.0], [tInt - 0.5, 2880, 540, 1.0], [tInt + 0.8, 2980, 700, 1.12], [tMerged + 3, 3080, 720, 1.12]];
    return {
      el,
      update(t) {
        const view = cam.set(t, keys);
        ttl.update(P(t, 0.2, 1.2));
        pop(goalA, P(t, 1.0, 0.5));
        partsA.forEach((p, i) => {
          pop(p.n, P(t, 2.2 + i * 0.3, 0.45), 0.7);
          const kc = P(t, tRoute + 0.8 + i * 0.3, 0.5);
          p.n.style.borderColor = kc > 0.5 ? HEX[p.r] : "var(--line-bright)";
          p.n.style.boxShadow = kc > 0.5 ? `inset 6px 0 0 ${HEX[p.b]}, 0 20px 60px rgba(0,0,0,.45)` : "";
          p.n.querySelector(".who").style.opacity = kc;
          draw(p.path, P(t, tRoute + 2.6 + Math.floor(i / 2) * 1.4, 1.2));
        });
        [...sA.querySelectorAll(".dep")].forEach((e, i) => (e.style.opacity = P(t, 3.4 + i * 0.2, 0.4)));
        pop(hashA, P(t, c.when("The owner approves the split"), 0.4), 1.4);
        draw(toMainA, P(t, tRoute + 5.6, 1.0));
        fadeIn(goal, P(t, tReal + 0.4, 0.7));
        fadeIn(planner, P(t, c.when("Opus 5.5 proposed"), 0.6));
        Object.values(nodes).forEach((n, i) => {
          const k = P(t, c.when("Opus 5.5 proposed") + 0.6 + n.d * 0.4 + i * 0.1, 0.5);
          n.el.style.opacity = k; n.el.style.transform = `scale(${lerp(0.85, 1, k)})`;
          const k2 = P(t, tWho + 0.4 + i * 0.4, 0.5);
          n.el.style.borderColor = k2 > 0.5 ? HEX[fam(n.part.approvedBy[0] ?? "")] : "var(--line-bright)";
          n.el.style.boxShadow = k2 > 0.5 ? `inset 6px 0 0 ${HEX[fam(n.part.builders[0])]}, 0 20px 60px rgba(0,0,0,.45)` : "";
          n.el.querySelector(".who").style.opacity = k2;
        });
        edges.forEach(({ e, d }) => { e.style.opacity = P(t, c.when("Opus 5.5 proposed") + 0.6 + d * 0.4, 0.5); });
        const ka = P(t, c.when("approved them"), 0.35);
        approve.style.opacity = ka; approve.style.transform = `scale(${lerp(1.4, 1, ka)})`; approve.style.transformOrigin = "100% 0";
        [branch, bl, axis].forEach((x) => (x.style.opacity = P(t, tInt - 1.5, 0.6)));
        [mainL, ml].forEach((x) => (x.style.opacity = P(t, tInt - 1.2, 0.6)));
        const span = tMerged + 2 - tInt;
        marks.forEach((m, i) => { const k = P(t, tInt - 0.8 + i * span / marks.length, 0.4); m.g.style.opacity = k; m.g.style.transform = `translateY(${(1 - k) * -30}px)`; });
        addedNote.style.opacity = P(t, tInt + 1, 0.5);
        toMain.style.opacity = P(t, tMerged + 2.2, 0.5);
        fadeIn(mergedStamp, P(t, tMerged + 2.6, 0.6), 10);
        shot.show(t, ts);
        shot.pan(t, [[ts, 250, 1.22, 330], [ts + 1.2, 250, 1.22, 330], [c.dur, Math.min(H - 840, 1500), 1.22, 330]]);
        return view;
      },
    };
  };

  SCENES.replay = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 3840, 1080);
    // A: events into the ledger.
    const A = region(0, 0); world.append(A);
    const sA = svgFull(); A.append(sA);
    const ttl = kinetic("Every step is an event", "kin display", { position: "absolute", left: "150px", top: "110px", fontSize: "64px" });
    A.append(ttl.el);
    const ledger = pos(h("div", { class: "card", style: { padding: "26px 30px", width: "420px", textAlign: "center" } }, h("div", { style: { font: "600 30px/1.2 var(--font-sans)" }, text: "the ledger" }), h("div", { class: "mono dim", text: "an append-only event log", style: { fontSize: "20px", marginTop: "8px" } })), 1300, 460);
    A.append(ledger);
    const evs = [["item.claimed", "#ff8a5b"], ["push.observed", "#6f9bff"], ["evidence.observed", "#5fe08f"], ["review.approved", "#ff8fcf"], ["item.merged", "#f4f1e8"]].map(([n, color], i) => {
      const e = pos(h("div", { class: "abs mono", text: n, style: { fontSize: "24px", color, padding: "8px 14px", border: `1.5px solid ${color}`, borderRadius: "8px", background: "rgba(0,0,0,.4)" } }), 160, 340 + i * 90);
      A.append(e);
      return e;
    });
    const flows = evs.map((_, i) => beads(sA, `M 460 ${360 + i * 90} C 900 ${360 + i * 90}, 1000 520, 1300 520`, "#ffd166", 2, 6));
    // B: the record.
    const B = region(1920, 0); world.append(B);
    const merged = data.tasks.filter((t) => t.state === "merged").sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : 1));
    const FAMS = ["anthropic", "zai", "openai", "deepseek", "google", "xiaomi"];
    const T0 = Date.parse("2026-10-03T21:00:00Z"), T1 = Date.parse(data.facts.cutoff);
    const X0 = 150, X1 = 1470;
    const X = (ms) => X0 + (ms - T0) / (T1 - T0) * (X1 - X0);
    const laneH = { anthropic: 230, zai: 120, openai: 64, deepseek: 64, google: 48, xiaomi: 40 };
    let y = 190;
    const laneY = {};
    for (const f of FAMS) { laneY[f] = y + laneH[f]; y += laneH[f] + 14; }
    const AXY = y + 6;
    const svg = svgFull(); B.append(svg);
    for (const f of FAMS) svg.append(s("line", { x1: X0, y1: laneY[f], x2: X1, y2: laneY[f], stroke: "var(--line)", "stroke-width": 1 }));
    svg.append(s("line", { x1: X0, y1: AXY, x2: X1, y2: AXY, stroke: "var(--line-bright)", "stroke-width": 2 }));
    const days = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
    const dayEls = days.map((d) => {
      const a = Math.max(T0, Date.parse(d + "T00:00:00Z")), b = Math.min(T1, Date.parse(d + "T00:00:00Z") + 86400000);
      svg.append(s("line", { x1: X(b), y1: 180, x2: X(b), y2: AXY + 8, stroke: "var(--line)", "stroke-width": 1, "stroke-dasharray": "4 6" }));
      svg.append(s("text", { x: (X(a) + X(b)) / 2, y: AXY + 30, "text-anchor": "middle", fill: "var(--text-dim)", "font-size": 18, text: day(d + "T00:00:00Z") }));
      const total = s("text", { x: (X(a) + X(b)) / 2, y: AXY + 70, "text-anchor": "middle", fill: "var(--text-bright)", "font-size": 34, "font-weight": 600, text: data.facts.mergedByDay[d] ?? 0 });
      svg.append(total);
      return { end: b, total, n: data.facts.mergedByDay[d] ?? 0 };
    });
    const stacks = {};
    const dots = merged.map((t) => {
      const f = t.builderFamilies[0] ?? "other";
      const lane = FAMS.includes(f) ? f : "anthropic";
      const x = X(Date.parse(t.mergedAt));
      const bin = Math.round(x / 11);
      const n = (stacks[lane + bin] = (stacks[lane + bin] ?? -1) + 1);
      const ring = t.crossBy[0];
      const dot = s("circle", { cx: bin * 11, cy: laneY[lane] - 7 - n * 11, r: 4.6, fill: HEX[f] ?? HEX.other, stroke: ring ? HEX[ring] : "none", "stroke-width": ring ? 2.4 : 0 });
      svg.append(dot);
      return { dot, ms: Date.parse(t.mergedAt), cross: t.crossAtFinal, families: t.builderFamilies };
    });
    const playhead = s("line", { x1: X0, y1: 176, x2: X0, y2: AXY, stroke: "#ffd166", "stroke-width": 2 });
    playhead.style.filter = "drop-shadow(0 0 8px #ffd166)";
    const clock = s("text", { x: X0, y: 166, fill: "var(--signal)", "font-size": 18, "text-anchor": "middle", text: "" });
    svg.append(playhead, clock);
    const panel = pos(h("div", { class: "abs" }, h("div", { class: "label", text: "Merged tasks built, by family", style: { marginBottom: "14px" } }),
      ...FAMS.map((f) => h("div", { class: "row", style: { display: "flex", alignItems: "center", gap: "12px", height: "46px" } },
        h("span", { style: { width: "16px", height: "16px", borderRadius: "50%", background: HEX[f], boxShadow: `0 0 10px ${HEX[f]}` } }),
        h("span", { class: "n mono", text: "0", style: { width: "56px", fontSize: "24px", color: "var(--text-bright)", textAlign: "right" } }),
        h("span", { text: FAMILY_NAME[f], style: { fontSize: "22px" } }))),
      h("div", { class: "mono dim", text: "A task two families built counts for each.", style: { fontSize: "15px", marginTop: "10px" } })), 1530, 190);
    B.append(panel);
    const head = pos(h("div", { class: "abs label", text: "Each dot: a merged task, at its merge time, in its builder's colour; ring: the family that approved it" }), 150, 112);
    B.append(head);
    FAMS.forEach((f) => svg.append(s("text", { x: X0 - 12, y: laneY[f] - 6, "text-anchor": "end", fill: HEX[f], "font-size": 16, text: { anthropic: "Claude", zai: "GLM", openai: "GPT", deepseek: "DeepSeek", google: "Gemini", xiaomi: "MiMo" }[f] })));
    const since = Date.parse(data.facts.lastMergeWithoutCrossApproval.at);
    const sinceG = s("g", {});
    sinceG.append(s("rect", { x: X(since), y: 180, width: X1 - X(since), height: AXY - 180, fill: "rgba(95,224,143,.07)" }));
    sinceG.append(s("line", { x1: X(since), y1: 180, x2: X(since), y2: AXY, stroke: "#5fe08f", "stroke-width": 2 }));
    svg.append(sinceG);
    const sinceLbl = pos(h("div", { class: "abs mono", style: { fontSize: "18px", color: "var(--observed)", width: "520px" }, text: `from ${utc(data.facts.lastMergeWithoutCrossApproval.at)}, ${day(data.facts.lastMergeWithoutCrossApproval.at)}: every task merged carries another family's approval` }), X(since) + 12, 140);
    B.append(sinceLbl);
    const big = pos(h("div", { class: "abs" }, h("span", { class: "big-num nn", text: "0", style: { fontSize: "80px", color: "var(--observed)" } }), h("span", { class: "big-num", text: ` of ${data.facts.states.merged}`, style: { fontSize: "44px", color: "var(--text-muted)" } }),
      h("div", { class: "label", text: "approved by another family at the merged revision", style: { width: "330px", marginTop: "6px" } })), 1530, 650);
    B.append(big);
    const shot = browser("flow", "atelier.zone<b>/p/atelier/flow</b>", "captured from the live site");
    el.append(shot.el);
    const g = data.screens.flow.marks;
    const gy = Object.entries(g).find(([k, v]) => k.startsWith("svg@") && v.h > 1000)?.[1].y ?? 300;
    const a = c.cue(1) + 0.8, b = c.when("Models of six families") - 0.2;
    // A soft tick as each day's merges land.
    for (let tt = a; tt < b; tt += 1 / 30) {
      const now0 = lerp(T0, T1, clamp((tt - a) / (b - a))), now1 = lerp(T0, T1, clamp((tt + 1 / 30 - a) / (b - a)));
      if (merged.some((m) => { const ms = Date.parse(m.mergedAt); return ms > now0 && ms <= now1; })) c.sfx(tt, "tick", 0.5);
    }
    c.sfx(c.cue(1) - 0.6, "whoosh", 0.8); c.sfx(c.cue(3) + 0.4, "swell", 0.8);
    const ts = c.cueEnd(3) + 0.8;
    const keys = [[0, 960, 540, 1.04], [c.cue(1) - 0.6, 960, 540, 1.0], [c.cue(1) + 0.6, 2880, 540, 1.0], [c.cue(3) + 0.2, 2880, 540, 1.0], [c.cue(3) + 2.2, 1920 + X(since) + 250, 470, 1.32]];
    return {
      el,
      update(t) {
        const view = cam.set(t, keys);
        ttl.update(P(t, 0.2, 1.2));
        evs.forEach((e, i) => fadeIn(e, P(t, 0.8 + i * 0.3, 0.5), 10));
        fadeIn(ledger, P(t, 1.2, 0.6));
        flows.forEach((f, i) => f.update(t, 1.6 + i * 0.25, 1.6, 1));
        ledger.style.boxShadow = `0 0 ${20 + 14 * Math.sin(t * 3)}px rgba(255,209,102,.35), 0 20px 60px rgba(0,0,0,.45)`;
        fadeIn(head, P(t, c.cue(1) + 0.4, 0.6));
        panel.style.opacity = P(t, c.cue(1) + 0.6, 0.6);
        const now = lerp(T0, T1, clamp((t - a) / (b - a)));
        playhead.setAttribute("x1", X(now)); playhead.setAttribute("x2", X(now)); clock.setAttribute("x", X(now));
        clock.textContent = t > a && t < b + 0.5 ? new Date(now).toISOString().slice(5, 16).replace("T", " ") + " UTC" : "";
        playhead.style.opacity = t > a - 0.3 && t < b + 1 ? 1 : 0;
        const live = {};
        const dim = P(t, c.cue(3) + 0.3, 0.8);
        for (const d of dots) {
          const k = clamp((now - d.ms) / 3.6e6 / 3);
          d.dot.style.opacity = (k > 0 ? 0.35 + 0.65 * k : 0) * (d.cross ? 1 : lerp(1, 0.2, dim));
          d.dot.setAttribute("r", k > 0 && k < 1 ? 4.6 + 4 * (1 - k) : 4.6);
          if (now >= d.ms) for (const f of d.families) live[f] = (live[f] ?? 0) + 1;
        }
        dayEls.forEach((dd) => { const k = clamp((now - dd.end + 6 * 3600e3) / (6 * 3600e3)); dd.total.style.opacity = k > 0 ? 1 : 0; dd.total.textContent = Math.round(dd.n * clamp(k)); });
        [...panel.querySelectorAll(".row")].forEach((r, i) => {
          r.querySelector(".n").textContent = live[FAMS[i]] ?? 0;
          const hi = P(t, c.when("Models of six families") + 1.6 + i * 0.6, 0.3) * (1 - P(t, c.when("Models of six families") + 2.2 + i * 0.6, 0.3));
          r.style.transform = `translateX(${hi * 14}px)`; r.style.filter = hi > 0.1 ? `drop-shadow(0 0 8px ${HEX[FAMS[i]]})` : "";
        });
        sinceG.style.opacity = P(t, c.when("Every task merged since"), 0.6);
        sinceLbl.style.opacity = sinceG.style.opacity;
        fadeIn(big, P(t, c.cue(3) + 0.6, 0.6));
        count(big.querySelector(".nn"), data.facts.mergedWithCrossFamilyApprovalAtFinalHead, (t - c.cue(3) - 0.6) / 2.2);
        shot.show(t, ts);
        shot.pan(t, [[ts, gy - 100, 1.24, 330], [ts + 1.0, gy - 100, 1.24, 330], [c.dur, gy + 700, 1.24, 330]]);
        return view;
      },
    };
  };

  SCENES.runners = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 3840, 1080);
    const term = pos(h("div", { class: "term", style: { height: "800px" } }, h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("span", { text: "  atelier — the owner's terminal", style: { marginLeft: "10px" } })), h("div", { style: { position: "absolute", top: "40px", left: 0, right: 0, bottom: 0, overflow: "hidden" } }, h("pre", {}))), 120, 120, 1680);
    world.append(term);
    const pre = term.querySelector("pre");
    const B = region(1920, 0); world.append(B);
    const sB = svgFull(); B.append(sB);
    const ttl = kinetic("The agents run on your machines", "kin display", { position: "absolute", left: "150px", top: "110px", fontSize: "64px" });
    B.append(ttl.el);
    const q = pos(h("div", { class: "card", style: { padding: "20px 26px", width: "380px" } }, h("div", { class: "label", text: "atelier.zone · the queue" }), h("div", { class: "mono", style: { fontSize: "23px", marginTop: "10px", lineHeight: "1.7" }, html: "build jobs<br>plan jobs<br>review jobs" })), 160, 380);
    const mac = pos(h("div", { class: "card", style: { padding: "20px 26px", width: "880px" } }, h("div", { class: "label", text: "the owner's machine · atelier runner" }),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginTop: "16px" } },
        ...[["zai", "opencode", "GLM-5.3 · DeepSeek V4 Pro"], ["anthropic", "claude", "Opus 5.5 · Sonnet 5.5 · Fable 5.1"], ["openai", "codex", "gpt-6-astra · gpt-6.1-sol"], ["google", "antigravity", "Gemini 3.1 Pro · GPT-OSS 120B"]].map(([f, tool, ms]) => h("div", { class: "tool", style: { padding: "12px 14px", border: `1.5px solid ${HEX[f]}`, borderRadius: "10px" } }, h("div", { class: "mono", text: tool, style: { fontSize: "22px", color: HEX[f] } }), h("div", { class: "mono dim", text: ms, style: { fontSize: "16px", marginTop: "4px" } }))))), 880, 330);
    B.append(q, mac);
    const jobs = beads(sB, "M 560 450 C 700 420, 760 420, 870 440", "#ffd166", 3, 8);
    const back = beads(sB, "M 870 620 C 760 660, 700 660, 560 600", "#5fe08f", 3, 7);
    const C = region(3840 - 1920, 0);
    const shot = browser("gateway", "atelier.zone<b>/models</b> · AI Gateway", "captured from the live site");
    Object.assign(shot.el.style, { top: "250px", height: "530px" });
    el.append(shot.el);
    const out = data.terminal.t278;
    const cmd = "atelier show t278";
    const t0 = c.cue(0) + 0.6;
    c.sfx(c.cue(1) - 0.3, "whoosh", 0.6);
    return {
      el,
      update(t) {
        const view = cam.set(t, [[0, 960, 560, 1.06], [c.cue(1), 960, 520, 1.0]]);
        fadeIn(term, P(t, 0.1, 0.5)); term.style.opacity = P(t, 0.1, 0.5) * (1 - 0.85 * P(t, c.cue(1) - 0.2, 0.6));
        let html = "";
        if (t >= t0) {
          const typed = Math.floor(clamp((t - t0) / (cmd.length / 20)) * cmd.length);
          html += `<span class="prompt">~/atelier $</span> ${esc(cmd.slice(0, typed))}`;
          const tOut = t0 + cmd.length / 20 + 0.35;
          if (t < tOut) html += `<span class="cursor"></span>`;
          else { const lines = out.trimEnd().split("\n"); html += "\n" + lines.slice(0, Math.min(lines.length, Math.floor((t - tOut) / 0.12) + 1)).map(esc).join("\n"); }
        }
        pre.innerHTML = html;
        ttl.update(P(t, c.cue(1) - 0.2, 1.2));
        fadeIn(q, P(t, c.cue(1) + 0.6, 0.5)); fadeIn(mac, P(t, c.cue(1) + 1.2, 0.5));
        [...mac.querySelectorAll(".tool")].forEach((x, i) => pop(x, P(t, c.cue(1) + 2.4 + i * 0.35, 0.4), 0.8));
        jobs.update(t, c.cue(1) + 2.0, 1.6, P(t, c.cue(1) + 2, 0.3)); back.update(t, c.cue(1) + 3.2, 1.6, P(t, c.cue(1) + 3.2, 0.3));
        shot.show(t, c.cue(1) - 0.2);
        shot.pan(t, [[c.cue(1) - 0.2, 0, 1.0, 0], [c.dur, 40, 1.05, 30]]);
        return view;
      },
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
      g.append(s("text", { x: 126, y: y + 34, fill: "var(--text-dim)", "font-size": 17, "letter-spacing": 2, text: label.toUpperCase() }));
      svg.append(g); return g;
    };
    const bMac = band(90, 200, "The owner's machines", "rgba(255,255,255,.015)");
    const bCf = band(320, 450, "Cloudflare", "rgba(95,224,143,.035)");
    const bNext = band(800, 110, "In progress", "rgba(255,255,255,.01)");
    bNext.querySelector("rect").setAttribute("stroke-dasharray", "8 8");
    const box = (x, y, w, hh, title, sub, opts = {}) => {
      const b = pos(h("div", { class: "card", style: { padding: "14px 18px", height: hh + "px", borderColor: opts.color ?? "var(--observed-line)", borderStyle: opts.dashed ? "dashed" : "solid", background: opts.dashed ? "transparent" : "var(--surface-raised)" } },
        h("div", { style: { font: "600 24px/1.2 var(--font-sans)", color: "var(--text-bright)" } }, opts.live ? h("span", { style: { display: "inline-block", width: "11px", height: "11px", borderRadius: "50%", background: "var(--observed)", marginRight: "10px", boxShadow: "0 0 10px var(--observed)", verticalAlign: "2px" } }) : null, title),
        h("div", { class: "mono", style: { fontSize: "17px", color: "var(--text-muted)", marginTop: "6px", lineHeight: "1.35" }, html: sub })), x, y, w);
      world.append(b); return { el: b, x, y, w, h: hh };
    };
    const cli = box(150, 140, 420, 120, "atelier CLI", "the owner's one command;<br>checks in a clean clone", { color: "var(--line-bright)" });
    const runner = box(620, 140, 420, 120, "Home runner", "build, plan and review jobs;<br>each model's own tool", { color: "var(--line-bright)" });
    const worker = box(700, 370, 520, 120, "Worker · atelier.zone", "the API, the pages<br>and the gate", { live: true });
    const ledger = box(150, 540, 440, 100, "Durable Objects: Ledger", "one per project, SQLite storage;<br>one request at a time", { live: true });
    const index = box(620, 540, 470, 100, "Durable Object: index", "what spans projects: tokens,<br>model pool, runner offers", { live: true });
    const art = box(1120, 540, 650, 100, "Artifacts", "Git repositories: a baseline per project,<br>a fork for every task and plan", { live: true });
    const logs = box(150, 660, 440, 100, "Workers Logs", "the Worker's logs, kept", { live: true });
    const aig = box(620, 660, 1150, 100, "AI Gateway · GraphQL Analytics API", "runners' pay-per-use calls through the gateway; the Models page<br>reads calls, failures, tokens, cost and latency per model", { live: true });
    const next = [["Access", "t270"], ["Browser Rendering", "t283"], ["R2", "t284"], ["Workflows", "t280"]].map(([n, id], i) => box(420 + i * 350, 826, 320, 66, n, `task ${id}`, { dashed: true, color: "var(--line-bright)" }));
    const centre = (b, side) => side === "top" ? [b.x + b.w / 2, b.y] : [b.x + b.w / 2, b.y + b.h];
    const edge = (a, b, color = "#ffd166") => {
      const [x1, y1] = centre(a, "bottom"), [x2, y2] = centre(b, "top");
      const d = `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
      const p = s("path", { d, fill: "none", stroke: "var(--line-bright)", "stroke-width": 2.5 });
      svg.append(p);
      return { p, b: beads(svg, d, color, 2, 6) };
    };
    const E = { cli: edge(cli, worker), runner: edge(runner, worker), ledger: edge(worker, ledger), index: edge(worker, index), art: edge(worker, art, "#5fe08f") };
    const tA = c.when("Artifacts holds"), tL = c.when("Each project's ledger");
    const vis = { cli: 0.8, runner: 1.2, ledger: tL + 0.4, index: tL + 2.6, art: tA + 0.6 };
    [tL, tA, c.cue(2)].forEach((x) => c.sfx(x, "chime", 0.35));
    const keys = [[0, 960, 430, 1.08], [tL - 0.3, 960, 450, 1.08], [tL + 0.8, 900, 540, 1.05], [tA - 0.2, 900, 540, 1.05], [tA + 1.0, 1010, 580, 1.05], [c.cue(2) - 0.4, 1010, 580, 1.05], [c.cue(2) + 0.8, 960, 540, 0.98]];
    return {
      el,
      update(t) {
        const view = cam.set(t, keys);
        const show = (b, a) => pop(b.el ?? b, P(t, a, 0.5), 0.85);
        bMac.style.opacity = P(t, 0.2, 0.5); show(cli, 0.4); show(runner, 0.7);
        bCf.style.opacity = P(t, c.cue(0) + 0.4, 0.5);
        show(worker, c.cue(0) + 0.9);
        show(ledger, tL + 0.2); show(index, tL + 2.4);
        show(art, tA + 0.3); show(logs, c.when("Workers Logs keeps")); show(aig, c.when("Workers Logs keeps") + 1.4);
        bNext.style.opacity = P(t, c.cue(2), 0.5);
        next.forEach((b, i) => show(b, c.cue(2) + 0.4 + i * 0.35));
        worker.el.style.boxShadow = `0 0 ${24 + 16 * Math.sin(t * 2.4)}px rgba(95,224,143,.3), 0 20px 60px rgba(0,0,0,.45)`;
        ledger.el.style.boxShadow = t > c.when("one owner per task holds") && t < c.when("one owner per task holds") + 2 ? "0 0 40px var(--observed)" : "";
        for (const [k, { p, b }] of Object.entries(E)) { const k0 = P(t, vis[k], 0.5); p.style.opacity = k0; b.update(t, vis[k] + 0.4, 1.8, k0); }
        return view;
      },
    };
  };

  SCENES.close = (c, data) => {
    const el = h("div");
    const F = field(data);
    const cam = camera(F.world, F.W, F.H);
    el.append(F.world);
    const hud = h("div", { class: "abs", style: { inset: 0 } });
    el.append(hud);
    const f = data.facts;
    const line = kinetic("Git keeps the code. Atelier keeps the record.", "kin display", { position: "absolute", left: 0, right: 0, top: "210px", textAlign: "center", fontSize: "92px" });
    hud.append(line.el);
    const nums = pos(h("div", { class: "abs", style: { display: "flex", gap: "120px", justifyContent: "center", width: "1920px", left: 0 } },
      ...[[f.tasks, "tasks"], [f.states.merged, "merged"], [Object.keys(f.mergedBuilderFamilies).length, "model families"]].map(([n, l]) => h("div", { style: { textAlign: "center" } }, h("div", { class: "big-num", "data-n": n, text: "0" }), h("div", { class: "label", text: l, style: { marginTop: "8px" } })))), 0, 370);
    const url = pos(h("div", { class: "abs display", text: "atelier.zone", style: { fontSize: "120px", width: "1920px", textAlign: "center", left: 0 } }), 0, 600);
    const repo = pos(h("div", { class: "abs mono", text: "github.com/pavithran/atelier · MIT licence", style: { fontSize: "34px", width: "1920px", textAlign: "center", color: "var(--signal)" } }), 0, 760);
    const t293 = pos(h("div", { class: "abs mono dim", text: `This film is task t293 in the same ledger · figures as of ${f.cutoff.slice(0, 10)} ${f.cutoff.slice(11, 16)} UTC`, style: { fontSize: "20px", width: "1920px", textAlign: "center" } }), 0, 830);
    hud.append(nums, url, repo, t293);
    c.sfx(c.cue(0) + 0.2, "swell", 0.7); c.sfx(c.cue(1), "chime", 0.9);
    return {
      el,
      update(t) {
        F.at(F.T1, 0.2 + 0.06 * Math.sin(t * 0.8));
        const view = cam.set(t, [[0, F.W / 2, F.MAINY - 80, 0.42], [c.dur, F.W / 2, F.MAINY - 60, 0.46]], 0.5);
        line.update(P(t, c.cue(0) + 0.3, 1.6));
        nums.style.opacity = P(t, c.when("It built itself") - 0.2, 0.6);
        [...nums.querySelectorAll(".big-num")].forEach((x, i) => count(x, Number(x.dataset.n), (t - c.when("It built itself") - i * 0.5) / 2.0));
        fadeIn(url, P(t, c.cue(1), 0.8));
        fadeIn(repo, P(t, c.when("its source") + 0.2, 0.8));
        fadeIn(t293, P(t, c.cueEnd(1) + 0.4, 0.8));
        return view;
      },
    };
  };

  // ── the player ──────────────────────────────────────────────────────────
  let built = [], captions = [], sounds = [];
  const capEl = () => document.querySelector("#caption span");
  // Scenes that hand over without a dip to black, because the next one
  // continues the picture.
  const MATCH = new Set(["cold>cast"]);

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
      const wrap = h("div", { class: "scene" });
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
    document.getElementById("grain").querySelector("feTurbulence").setAttribute("seed", String(Math.floor(T * 15) % 97 + 1));
    const ch = document.getElementById("chapter");
    ch.innerHTML = ["cold", "cast", "close"].includes(cur.sc.id) ? "" : `<b>${String(cur.n).padStart(2, "0")}</b>${esc(cur.sc.title)}`;
    ch.style.opacity = P(t, 0.3, 0.6);
    const cap = captions.find((k) => T >= k.start && T < k.end + 0.25);
    capEl().textContent = cap ? cap.text : "";
  }

  window.film = { init, seek, sounds: () => sounds.sort((a, b) => a.t - b.t) };
})();
