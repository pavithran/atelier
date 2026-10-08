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
    ["qwen", /^qwen|qwq/i],
    ["minimax", /minimax/i],
  ];
  const fam = (a) => { const n = a.split("/").pop(); return (FAMILIES.find(([, re]) => re.test(n) || re.test(a)) ?? ["other"])[0]; };
  const col = (f) => `var(--m-${f})`;
  const HEX = { anthropic: "#ff8a5b", openai: "#3fe0b0", zai: "#6f9bff", google: "#ff8fcf", deepseek: "#5ad1e6", xiaomi: "#ff9e40", qwen: "#b5e55c", minimax: "#ff9f7a", other: "#8f9cab" };
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
    const SWEEP_A = 0.3, SWEEP_B = 9.6;
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
    const cam = camera(world, 3840, 2160);
    const svg = svgFull(); world.append(svg);
    // The handoff, below the roles: the camera goes there for the last cue.
    const R = region(0, 1080, 3840, 1080); world.append(R);
    const tHand = c.when("handed task t50");
    const handoff = forksReal(data, R, 1e9, c.cue(2), tHand);
    const CX = 960, CY = 420;
    const ledger = pos(h("div", { class: "card", style: { padding: "20px 26px", width: "380px", textAlign: "center", borderColor: "var(--wire)" } }, h("div", { style: { font: "700 32px/1.2 var(--font-display)" }, text: "the ledger" }), h("div", { class: "mono dim", text: "every event, recorded by the server", style: { fontSize: "17px", marginTop: "8px" } })), CX - 190, CY - 58);
    world.append(ledger);
    const f = data.facts;
    const rules = (txt) => h("span", { class: "chip", style: { color: "var(--signal)" } }, h("span", { class: "dot" }), txt);
    const famLabel = { anthropic: "Claude", zai: "GLM", openai: "GPT", deepseek: "DeepSeek", google: "Gemini", xiaomi: "MiMo" };
    // Seven roles on an ellipse around the ledger, clear of the captions.
    const spec = [
      ["Planner", "a model splits a goal into parts", [chip(data.plan.planner), h("span", { class: "mono dim", text: " planned t197", style: { fontSize: "17px" } })], "A planner model"],
      ["Builders", "models, many at once, each in its own fork", Object.keys(f.mergedBuilderFamilies).map((x) => famChip(x, famLabel[x] ?? x)), "Builder models"],
      ["Reviewers", "models of another family than the builders", Object.entries(f.reviewsByModel).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m]) => famChip(fam(m), NAMES[m] ?? m)), "Reviewer models"],
      ["Orchestrator", "Atelier's code: routes each part to a builder and a reviewer", [rules("rules, no model"), h("span", { class: "mono dim", text: " src/plans/route.ts", style: { fontSize: "16px" } })], "Atelier's own code"],
      ["Integrator", "merges parts onto the plan's branch; a conflict goes to a model", [rules("rules, no model"), famChip("zai", "merge-main job: a model")], "The integrator"],
      ["Runners", "on the owner's machines; start each model's own tool", [...[["zai", "opencode"], ["anthropic", "claude"], ["openai", "codex"], ["google", "antigravity"]].map(([x, n]) => famChip(x, n)), h("span", { class: "mono", text: "subscription · AI Gateway · local models", style: { fontSize: "15px", color: "var(--signal)", width: "100%" } })], "Runners on"],
      ["Owner", "approves the plan, merges the result", [h("span", { class: "chip", style: { color: "var(--signal)", fontSize: "18px" } }, h("span", { class: "dot" }), "the owner, or a session on its decisions")], "and the owner, or"],
    ];
    const roles = spec.map(([name, what, body, cueAt], i) => {
      const a = -Math.PI / 2 + i * (2 * Math.PI / spec.length);
      const x = CX + Math.cos(a) * 700 * (Math.abs(Math.cos(a)) > 0.9 ? 0.97 : 1), y = CY + Math.sin(a) * 285 + (Math.sin(a) > 0.6 ? 20 : 0) - (Math.sin(a) < -0.9 ? 10 : 0);
      const xr = Math.max(255, Math.min(1665, x));
      const yAdj = name === "Runners" ? -75 : name === "Owner" ? -35 : 0;
      const card = h("div", { class: "card", style: { padding: "14px 18px", width: "470px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "12px", flexWrap: "wrap" } }, h("span", { class: "display", text: name, style: { fontSize: "32px" } }), h("span", { class: "mono dim", text: what, style: { fontSize: "15px" } })),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" } }, ...body));
      pos(card, xr - 235, y + yAdj - 62);
      world.append(card);
      const d = `M ${xr} ${y + yAdj} L ${CX} ${CY}`;
      const line = s("path", { d, fill: "none", stroke: "var(--line-bright)", "stroke-width": 2.5 });
      svg.append(line);
      const t0 = c.when(cueAt);
      return { card, line, toL: beads(svg, d, "#f4f1e8", 2, 5), fromL: beads(svg, `M ${CX} ${CY} L ${xr} ${y + yAdj}`, "#ffd166", 1, 5), t0, x: xr, y: y + yAdj };
    });
    roles.forEach((r) => c.sfx(r.t0 - 0.05, "chime", 0.3));
    const keys = [[0, 960, 500, 0.96], [roles[0].t0 - 0.6, 960, 500, 1.0]];
    roles.forEach((r) => { const L = keys[keys.length - 1]; keys.push([r.t0 - 0.4, L[1], L[2], L[3]], [r.t0 + 0.6, (r.x + CX * 2) / 3, Math.max(440, Math.min(500, (r.y + CY * 2) / 3 + 40)), 1.0]); });
    keys.push([c.cue(2) - 1.6, keys[keys.length - 1][1], keys[keys.length - 1][2], 1.0], [c.cue(2) - 0.9, 960, 500, 0.9], [c.cue(2) - 0.2, 960, 500, 0.9], [c.cue(2) + 0.8, 2880, 1620, 1.0]);
    c.sfx(c.cue(2), "whoosh", 0.6); c.sfx(tHand, "chime", 0.5);
    return {
      el,
      update(t) {
        const view = cam.set(t, keys, 0.6);
        pop(ledger, P(t, 0.2, 0.7), 0.6);
        handoff(t);
        ledger.style.boxShadow = `0 0 ${30 + 18 * Math.sin(t * 2.2)}px rgba(255,209,102,.35), 0 20px 60px rgba(0,0,0,.45)`;
        roles.forEach((r) => {
          pop(r.card, P(t, r.t0, 0.5), 0.75);
          draw(r.line, P(t, r.t0 + 0.1, 0.7));
          r.toL.update(t, r.t0 + 0.6, 1.5, P(t, r.t0 + 0.6, 0.4));
          r.fromL.update(t, r.t0 + 1.2, 2.0, P(t, r.t0 + 1.2, 0.4));
        });
        return view;
      },
    };
  };

  SCENES.metrics = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 1920 * 5, 1080);
    const f = data.facts;
    // A: built and reviewed, on one scale.
    const A = region(0, 0); world.append(A);
    A.append(kinetic("Built, and reviewed", "kin display", { position: "absolute", left: "120px", top: "70px", fontSize: "70px" }).el);
    const ttlA = A.lastChild;
    const head = pos(h("div", { class: "abs" }, h("div", { class: "label", text: "Merged tasks built, by family (headline)" }),
      h("div", { style: { display: "flex", gap: "34px", marginTop: "12px" } }, ...Object.entries(f.mergedBuilderFamilies).sort((a, b) => b[1] - a[1]).map(([x, n]) => h("div", {}, h("div", { class: "big-num hf", "data-n": n, text: "0", style: { fontSize: "64px", color: col(x) } }), h("div", { class: "label", text: FAMILY_NAME[x] }))))), 120, 190);
    A.append(head);
    const both = {};
    for (const [m, n] of Object.entries(f.mergedBuilderModels)) (both[m] ??= { b: 0, r: 0 }).b += n;
    for (const [m, n] of Object.entries(f.reviewsByModel)) (both[m] ??= { b: 0, r: 0 }).r += n;
    const rows = Object.entries(both).filter(([, v]) => v.b + v.r >= 5).sort((a, b) => (b[1].b + b[1].r) - (a[1].b + a[1].r)).slice(0, 9);
    const max = Math.max(...rows.map(([, v]) => Math.max(v.b, v.r)));
    const chart = pos(h("div", { class: "abs" },
      h("div", { style: { display: "flex", gap: "30px", marginBottom: "10px", marginLeft: "290px" } }, h("span", { class: "mono", html: "<span style='display:inline-block;width:14px;height:14px;background:var(--text);margin-right:8px'></span>built: merged tasks it worked on", style: { fontSize: "18px" } }), h("span", { class: "mono", html: "<span style='display:inline-block;width:14px;height:14px;border:2px solid var(--text-muted);margin-right:8px'></span>reviewed: reviews it recorded", style: { fontSize: "18px" } })),
      ...rows.map(([m, v]) => h("div", { style: { display: "flex", alignItems: "center", gap: "12px", height: "50px" } },
        h("div", { class: "mono", text: NAMES[m] ?? m, style: { width: "280px", fontSize: "19px", textAlign: "right", color: col(fam(m)), fontWeight: 600 } }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, h("div", { class: "bar", style: { height: "15px", width: `${Math.max(2, v.b / max * 1100)}px`, background: col(fam(m)), borderRadius: "3px" } }), h("span", { class: "mono", text: `built ${v.b}`, style: { fontSize: "15px", color: "var(--text-muted)" } })),
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, h("div", { class: "bar", style: { height: "15px", width: `${Math.max(2, v.r / max * 1100)}px`, border: `2px solid ${col(fam(m))}`, borderRadius: "3px", boxSizing: "border-box" } }), h("span", { class: "mono", text: `reviewed ${v.r}`, style: { fontSize: "15px", color: "var(--text-muted)" } })))))), 120, 400);
    A.append(chart);
    // B: AI Gateway, C: the record.
    const B = region(1920, 0); world.append(B);
    B.append(kinetic("Cost and latency, per model", "kin display", { position: "absolute", left: "120px", top: "70px", fontSize: "70px" }).el);
    const ttlB = B.lastChild;
    const gw = h("div", { class: "shot", style: { position: "absolute", left: "120px", top: "220px", width: "1584px", height: "443px", borderRadius: "14px", overflow: "hidden", boxShadow: "0 30px 80px rgba(20,24,29,.25), 0 0 0 1px var(--line-bright)" } }, h("img", { src: "../.cache/screens/gateway.png", style: { width: "1584px" } }));
    B.append(gw, pos(h("div", { class: "abs mono", text: "atelier.zone/models · AI Gateway, from Cloudflare's GraphQL Analytics · captured from the live site", style: { fontSize: "18px", color: "var(--text-muted)" } }), 120, 690));
    // B2: the fleet, by how each model is paid for.
    const B2 = region(5760, 0); world.append(B2);
    B2.append(kinetic("One fleet, one gate", "kin display", { position: "absolute", left: "120px", top: "70px", fontSize: "70px" }).el);
    const ttlB2 = B2.lastChild;
    const groups = [
      ["Subscriptions", (e) => e.provider === "subscription", ""],
      ["Pay per use", (e) => e.provider === "openrouter" || e.provider === "deepseek", "kimi-k2.7-code joined " + day((data.fleet.find((e) => e.id === "kimi-k2.7-code") ?? { addedAt: data.facts.cutoff }).addedAt)],
      ["Local, no per-call cost", (e) => e.provider === "ai-studio", "on the owner's network · " + data.localDispatches.map((x) => `${x.id} → ${x.model}`).join(", ")],
    ];
    const cols = groups.map(([name, pick, note], i) => pos(h("div", { class: "card", style: { padding: "20px 24px", width: "540px", height: "560px" } },
      h("div", { class: "display", text: name, style: { fontSize: "36px" } }),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "18px", alignItems: "flex-start" } }, ...data.fleet.filter(pick).map((e) => h("span", { class: "chip", style: { color: col(e.family), fontSize: "24px" } }, h("span", { class: "dot" }), e.id))),
      note ? h("div", { class: "mono", text: note, style: { fontSize: "18px", marginTop: "18px", color: "var(--signal)", fontWeight: 600 } }) : null), 120 + i * 570, 200));
    B2.append(...cols);
    const C = region(3840, 0); world.append(C);
    C.append(kinetic("Each model's record", "kin display", { position: "absolute", left: "120px", top: "70px", fontSize: "70px" }).el);
    const ttlC = C.lastChild;
    const rel = h("div", { class: "shot", style: { position: "absolute", left: "120px", top: "200px", width: "1584px", height: "640px", borderRadius: "14px", overflow: "hidden", boxShadow: "0 30px 80px rgba(20,24,29,.25), 0 0 0 1px var(--line-bright)" } }, h("img", { src: "../.cache/screens/reliability.png", style: { width: "1584px", position: "absolute", left: 0, top: 0 } }));
    const fv = f.findingVerdicts;
    const verdict = pos(h("div", { class: "abs mono", style: { fontSize: "24px", fontWeight: 600 }, html: `the owner's verdicts on review findings: <span style="color:var(--observed)">${(fv.confirmed ?? 0) + (fv.fixed ?? 0)} confirmed or fixed</span> · <span style="color:var(--fault)">${fv.refuted ?? 0} refuted</span>` }), 120, 870);
    C.append(rel, verdict);
    // D: how it learns.
    const D = region(7680, 0); world.append(D);
    D.append(kinetic("How it learns from use", "kin display", { position: "absolute", left: "120px", top: "70px", fontSize: "70px" }).el);
    const ttlD = D.lastChild;
    const formula = pos(h("div", { class: "card", style: { padding: "22px 28px", width: "1680px" } },
      h("div", { class: "label", text: "plan routing's score for each model · src/models/routing.ts, src/plans/route.ts" }),
      h("div", { class: "mono", style: { fontSize: "30px", marginTop: "14px", lineHeight: "1.6" }, html: "evidence  <span style='color:var(--observed)'>+ 100 × (observed passes + approvals + merges)</span>  <span style='color:var(--fault)'>− 100 × (failures + rejections)</span>" }),
      h("div", { class: "mono dim", style: { fontSize: "20px", marginTop: "6px" }, text: "from this project's ledger; ties go to the better reliability across projects" }),
      h("div", { class: "mono soon", style: { fontSize: "21px", marginTop: "14px", color: "var(--signal)", fontWeight: 600 }, text: "in progress: a speed term (t260) and reviewers ranked by precision (t263)" })), 120, 190);
    const tasks = ["t296", "t298"].map((id, i) => {
      const tk = data.selfTasks?.[id];
      return pos(h("div", { class: "card", style: { padding: "18px 24px", width: "820px", height: "300px" } }, h("div", { class: "label", text: `${id} · filed ${tk ? utc(tk.createdAt) + ", " + day(tk.createdAt) : ""} · ${tk?.state ?? ""}` }), h("div", { style: { font: "500 22px/1.45 var(--font-sans)", marginTop: "10px" }, text: (tk?.title ?? "").slice(0, 260).replace(/\s+\S*$/, "") + " …" })), 120 + i * 860, 560);
    });
    D.append(formula, ...tasks);
    const tS = c.when("Calls through Cloudflare"), tC = c.when("The Models page keeps"), tL = c.cue(1), tD = c.cue(2);
    [tS, tC, tL, tD].forEach((x) => c.sfx(x - 0.5, "whoosh", 0.6));
    c.sfx(c.cue(3), "chime", 0.5);
    const keys = flight([[0, 960, 540, 1.0], [tS - 0.5, 2880, 540, 1.0], [tC - 0.5, 4800, 540, 1.0], [tL - 0.5, 6720, 540, 1.0], [tD - 0.5, 8640, 540, 1.0]], 1.0, 0.86);
    return {
      el,
      update(t) {
        const view = cam.set(t, keys, 0.6);
        [[ttlA, 0], [ttlB, tS - 0.3], [ttlB2, tL - 0.3], [ttlC, tC - 0.3], [ttlD, tD - 0.3]].forEach(([x, a]) => [...x.children].forEach((w, i) => { const e = ease(clamp((t - a) / 0.9 * (x.children.length + 2) - i)); w.style.opacity = e; w.style.transform = `translateY(${(1 - e) * 30}px)`; }));
        fadeIn(gw, P(t, tS, 0.6)); gw.firstChild.style.transform = `scale(${1 + 0.03 * clamp((t - tS) / 8)})`;
        fadeIn(head, P(t, 0.4, 0.5));
        [...head.querySelectorAll(".hf")].forEach((x, i) => count(x, Number(x.dataset.n), (t - 0.6 - i * 0.15) / 1.4));
        fadeIn(chart, P(t, 1.2, 0.5));
        [...chart.querySelectorAll(".bar")].forEach((x, i) => { x.style.transformOrigin = "0 50%"; x.style.transform = `scaleX(${P(t, 1.4 + i * 0.08, 0.8)})`; });
        const tSub = c.when("subscription models"), tPay = c.when("pay-per-use"), tLoc = c.when("and local models");
        cols.forEach((x, i) => { fadeIn(x, P(t, [tSub, tPay, tLoc][i] - 0.2, 0.5)); [...x.querySelectorAll(".chip")].forEach((ch, j) => pop(ch, P(t, [tSub, tPay, tLoc][i] + j * 0.15, 0.35), 0.7)); });
        fadeIn(rel, P(t, tC, 0.6)); rel.firstChild.style.transform = `translateY(${-P(t, tC + 1.5, 9) * 300}px)`;
        fadeIn(verdict, P(t, c.when("So far"), 0.5));
        fadeIn(formula, P(t, tD, 0.6));
        formula.querySelector(".soon").style.opacity = P(t, c.when("Speed and reviewer"), 0.5);
        tasks.forEach((x, i) => fadeIn(x, P(t, i ? c.when("Tests failed") : c.when("A runner lost"), 0.5)));
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
    const tB = c.when("Opus 5.5 built t278");
    const tDrop = c.when("then for logs"), tFixed = c.when("Both were fixed"), tThird = c.when("The third head");
    const R = [
      { head: tB + 0.3, checks: tB + 0.8, rev: c.when("so Gemini reviewed"), verdict: c.when("and rejected it twice") + 0.3 },
      { head: tDrop - 0.6, checks: tDrop - 0.3, rev: tDrop - 0.1, verdict: tDrop + 0.4 },
      { head: tFixed, checks: tFixed + 0.4, rev: tFixed + 0.8, verdict: tThird + 0.4 },
    ];
    const r219 = data.stories.t219.reviews.find((r) => !r.approve);
    const f219 = r219.findings.find((x) => x.severity === "blocking");
    const p219 = pos(h("div", { class: "abs" }, h("div", { class: "label", text: `t219 · built by ${data.stories.t219.builders.map(nice).join(" and ")} · rejected by ${nice(r219.by)}` }),
      h("div", { class: "quote", style: { marginTop: "14px", width: "1500px" }, html: `“${quoteHtml(f219.text.split(/(?<=[.;])\s/)[0])}”<span class="src">${esc(f219.file)}:${f219.line} · blocking · ${utc(r219.at)}, ${day(r219.at)}</span>` }),
      h("div", { class: "mono", style: { fontSize: "24px", marginTop: "18px", color: "var(--fault)", fontWeight: 600 }, text: `models have sent work back ${data.facts.modelRejections} times` })), 2040, 640);
    world.append(p219);
    R.forEach((r, i) => c.sfx(r.verdict, i < 2 ? "reject" : "approve", 1));
    
    c.sfx(c.when("merged eleven seconds") + 1.2, "chime", 0.8);
    const ts = c.cueEnd(2) + 0.6;
    c.sfx(tB - 0.5, "whoosh", 0.6);
    const keys = [[0, 960, 600, 1.06], [tB - 0.6, 1000, 580, 1.0], [tB + 0.4, 2880, 540, 1.0]];
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
        fadeIn(header, P(t, tB - 0.2, 0.6));
        colHead.forEach((x, i) => fadeIn(x, P(t, tB + 0.1 + i * 0.1, 0.4), 8));
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
        win(pF1, R[0].verdict + 0.4, tDrop - 0.1);
        [...pF1.querySelectorAll(".src span")].forEach((x) => { x.style.opacity = P(t, R[0].verdict + 1.5, 0.4); });
        win(pF2, R[1].verdict + 0.3, tThird);
        [...pF2.querySelectorAll(".src span")].forEach((x) => { x.style.opacity = P(t, tFixed, 0.4); });
        win(pMerge, R[2].verdict + 0.5, c.cue(2) - 0.2);
        win(p219, c.cue(2), c.dur + 1);
        shot.show(t, ts, ts + 2.6);
        shot.pan(t, [[ts, thread - 40, 1.45, 360], [ts + 3.0, thread + 10, 1.45, 360]]);
        shot2.show(t, ts + 2.6);
        shot2.pan(t, [[ts + 2.6, reviewsY - 60, 1.45, 360], [c.dur, reviewsY, 1.45, 360]]);
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
    const tReal = -0.4;
    const tWho = c.cue(1), tInt = c.cue(1) + 1.5, tMerged = c.cue(2);
    c.sfx(c.when("by hash eleven") + 0.3, "chime", 0.6); c.sfx(c.when("the whole plan merged"), "approve", 0.8);
    const ts = c.cueEnd(2) + 0.6;
    const tRoute = -10;
    const keys = [[0, 2880, 520, 1.04], [tWho, 2880, 540, 1.0], [tInt - 0.5, 2880, 540, 1.0], [tInt + 0.8, 2880, 560, 1.02], [c.dur, 2890, 565, 1.03]];
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
        const ka = P(t, c.when("by hash eleven"), 0.35);
        approve.style.opacity = ka; approve.style.transform = `scale(${lerp(1.4, 1, ka)})`; approve.style.transformOrigin = "100% 0";
        [branch, bl, axis].forEach((x) => (x.style.opacity = P(t, tInt - 1.5, 0.6)));
        [mainL, ml].forEach((x) => (x.style.opacity = P(t, tInt - 1.2, 0.6)));
        const span = c.when("the whole plan merged") - tInt;
        marks.forEach((m, i) => { const k = P(t, tInt - 0.8 + i * span / marks.length, 0.4); m.g.style.opacity = k; m.g.style.transform = `translateY(${(1 - k) * -30}px)`; });
        addedNote.style.opacity = P(t, tInt + 1, 0.5);
        toMain.style.opacity = P(t, c.when("the whole plan merged"), 0.5);
        fadeIn(mergedStamp, P(t, c.when("the whole plan merged") + 0.3, 0.6), 10);
        shot.show(t, ts);
        shot.pan(t, [[ts, 250, 1.22, 330], [ts + 1.2, 250, 1.22, 330], [c.dur, Math.min(H - 840, 1500), 1.22, 330]]);
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
    const bNext = band(800, 110, "Next", "rgba(255,255,255,.01)");
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
    const next = [["Access", "t270 · built, not yet on"], ["R2", "t284 · built, not yet on"], ["Browser Rendering", "t283 · in progress"], ["Workflows", "t280 · in progress"]].map(([n, id], i) => box(420 + i * 350, 826, 320, 66, n, id, { dashed: true, color: "var(--line-bright)" }));
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
    [tL, tA, c.cue(1)].forEach((x) => c.sfx(x, "chime", 0.3));
    const keys = [[0, 960, 480, 1.04], [tL - 0.3, 960, 490, 1.04], [tL + 0.8, 900, 540, 1.05], [tA - 0.2, 900, 540, 1.05], [tA + 1.0, 1010, 580, 1.05], [c.cue(1) - 0.4, 1010, 580, 1.05], [c.cue(1) + 0.8, 960, 540, 0.98]];
    return {
      el,
      update(t) {
        const view = cam.set(t, keys);
        const show = (b, a) => pop(b.el ?? b, P(t, a, 0.5), 0.85);
        bMac.style.opacity = P(t, 0.2, 0.5); show(cli, 0.4); show(runner, 0.7);
        bCf.style.opacity = P(t, c.cue(0) + 0.4, 0.5);
        show(worker, c.cue(0) + 0.9);
        show(ledger, tL + 0.2); show(index, tL + 2.4);
        show(art, tA + 0.3); show(logs, c.cue(1) + 0.2); show(aig, c.cue(1) + 0.9);
        bNext.style.opacity = P(t, c.when("Access and R2"), 0.5);
        next.forEach((b, i) => show(b, c.when("Access and R2") + 0.2 + i * 0.35));
        worker.el.style.boxShadow = `0 0 ${24 + 16 * Math.sin(t * 2.4)}px rgba(95,224,143,.3), 0 20px 60px rgba(0,0,0,.45)`;
        ledger.el.style.boxShadow = t > c.when("Each project's ledger") && t < c.when("Each project's ledger") + 2 ? "0 0 40px var(--observed)" : "";
        for (const [k, { p, b }] of Object.entries(E)) { const k0 = P(t, vis[k], 0.5); p.style.opacity = k0; b.update(t, vis[k] + 0.4, 1.8, k0); }
        return view;
      },
    };
  };

  const CHAPTERS = ["Why Git alone isn't enough", "Who does the work", "Nothing merges without proof", "Big goals become plans", "It measures, and it learns", "It runs on Cloudflare"];

  SCENES.contents = (c, data) => {
    const el = h("div");
    const F = field(data);
    const cam = camera(F.world, F.W, F.H);
    el.append(F.world);
    const title = h("div", { class: "abs display", text: "Atelier", style: { fontSize: "220px", left: "0px", width: "1920px", textAlign: "center", top: "330px", letterSpacing: "-.04em" } });
    const sub = h("div", { class: "abs", text: "A Git platform for many coding agents", style: { left: "0px", width: "1920px", textAlign: "center", top: "610px", font: "500 40px/1.2 var(--font-sans)", color: "var(--signal)" } });
    el.append(title, sub);
    const head = pos(h("div", { class: "abs label", text: "In this video", style: { fontSize: "22px", color: "var(--signal)" } }), 760, 250);
    el.append(head);
    const words = ["why Git alone", "who does the work", "nothing merges without", "big goals become", "measures and learns", "what it runs on"];
    const rows = CHAPTERS.map((t, i) => {
      const r = pos(h("div", { class: "abs", style: { display: "flex", alignItems: "baseline", gap: "26px" } }, h("span", { class: "mono", text: String(i + 1), style: { fontSize: "34px", color: "var(--signal)", width: "30px" } }), h("span", { class: "display", text: t, style: { fontSize: "54px" } })), 760, 300 + i * 82);
      el.append(r);
      return { r, t0: c.when(words[i]) };
    });
    rows.forEach((x) => c.sfx(x.t0, "tick", 0.8));
    return {
      el,
      update(t) {
        F.at(F.T1, 0.28);
        const view = cam.set(t, [[0, F.W / 2, F.MAINY - 80, 0.36], [c.dur, F.W / 2, F.MAINY - 60, 0.4]], 0.5);
        const up = P(t, c.when("Here's what's coming") - 0.4, 1.2);
        title.style.transform = `translate(${-up * 560}px, ${-up * 120}px) scale(${lerp(1, 0.5, up)})`;
        sub.style.opacity = 1 - up;
        head.style.opacity = up;
        rows.forEach((x, i) => {
          const k = P(t, x.t0 - 0.1, 0.4);
          x.r.style.opacity = k * (t > x.t0 + 1.4 && i < rows.length - 1 ? 0.55 : 1) + (t > x.t0 + 1.4 && i < rows.length - 1 ? 0 : 0);
          x.r.style.transform = `translateX(${(1 - k) * 40}px)`;
        });
        rows.forEach((x) => { if (t > c.cueEnd(0) - 0.3) x.r.style.opacity = 1; });
        return view;
      },
    };
  };

  SCENES.why = (c, data) => {
    const el = h("div");
    const world = h("div");
    el.append(world);
    const cam = camera(world, 3840, 1080);
    const A = region(0, 0); world.append(A);
    const qs = ["Who owns the work?", "Did the tests really run?", "Who checked the change?"].map((q, i) => { const k = kinetic(q, "kin display", { position: "absolute", left: "160px", top: `${230 + i * 150}px`, fontSize: "92px" }); A.append(k.el); return k; });
    const gitLine = pos(h("div", { class: "abs mono", style: { fontSize: "28px", color: "var(--text-muted)" }, html: "git log: <span style='color:var(--text)'>commits</span>, and none of these answers" }), 166, 700);
    A.append(gitLine);
    const B = region(1920, 0); world.append(B);
    const st = data.stories.t278;
    const ttl = kinetic("A commit message, and a record", "kin display", { position: "absolute", left: "120px", top: "70px", fontSize: "70px" });
    B.append(ttl.el);
    const left = pos(h("div", { class: "card", style: { padding: "20px 24px", width: "700px", height: "620px" } },
      h("div", { class: "label", text: "git log -1 de67194 · written by the agent", style: { color: "var(--fault)" } }),
      h("pre", { class: "mono", style: { fontSize: "21px", lineHeight: "1.6", whiteSpace: "pre-wrap", margin: "16px 0 0", color: "var(--text)" }, text: data.terminal.commit }),
      h("div", { class: "mono claims", style: { fontSize: "19px", marginTop: "26px", lineHeight: "1.8", color: "var(--text-muted)" }, html: "no head it was checked at<br>no test results<br>no reviewer, no rejections<br>nothing verifies the author line" })), 120, 190);
    const L = st.landing;
    const evLine = (e) => {
      const who = e.actor === "pavi" ? "the owner" : nice(e.actor);
      const what = { "item.claimed": "claimed", "push.observed": `pushed, head ${e.head} read from Artifacts`, "evidence.observed": `check observed passing at ${e.head}`, "review.rejected": "rejected, with blocking findings", "review.approved": "approved", "item.accepted": `accepted at ${e.head}`, "item.merged": `merged as ${e.mergeCommit}` }[e.kind];
      return what ? `<span class="dim">${utc(e.at, true).replace(" UTC", "")}</span>  <span style="color:${e.kind === "review.rejected" ? "var(--fault)" : e.kind === "review.approved" || e.kind === "item.merged" ? "var(--observed)" : "var(--text)"}">${esc(who)}</span> ${esc(what)}` : null;
    };
    const claimed = { at: "2026-10-07T20:27:16.169Z", kind: "item.claimed", actor: st.builders[0] };
    const seen = new Set();
    const lines = [claimed, ...L].filter((e) => { if (e.kind === "evidence.observed") { if (seen.has(e.head)) return false; seen.add(e.head); } return true; }).map(evLine).filter(Boolean);
    const right = pos(h("div", { class: "card", style: { padding: "20px 24px", width: "940px", height: "620px", borderColor: "var(--observed-line)" } },
      h("div", { class: "label", text: "t278 in the ledger · written by the server, from what it observed", style: { color: "var(--observed)" } }),
      h("div", { class: "mono", style: { fontSize: "18px", lineHeight: "1.75", marginTop: "14px" } }, ...lines.map((x) => h("div", { class: "ev", html: x })))), 860, 190);
    const note = pos(h("div", { class: "abs mono", style: { fontSize: "18px", color: "var(--signal)", width: "1680px", fontWeight: 600 }, html: `git notes --ref=atelier show 5af22431 → ${esc(data.terminal.note.split("\n")[0])} · ${esc((data.terminal.note.split("\n")[3] ?? "").slice(0, 70))}…` }), 120, 830);
    B.append(left, right, note);
    c.sfx(c.cue(1) - 0.4, "whoosh", 0.6); c.sfx(c.cue(2), "swell", 0.6);
    const keys = [[0, 960, 540, 1.02], [c.cue(1) - 0.4, 960, 540, 1.0], [c.cue(1) + 0.6, 2880 - 400, 520, 1.12], [c.cue(2) - 0.2, 2880 - 400, 520, 1.12], [c.cue(2) + 0.6, 2880 + 340, 520, 1.08], [c.when("as a note"), 2880, 560, 1.0]];
    return {
      el,
      update(t) {
        const view = cam.set(t, keys, 0.6);
        qs.forEach((k, i) => k.update(P(t, c.when(["who owns", "whether the tests", "or who checked"][i]) - 0.2, 0.8)));
        gitLine.style.opacity = P(t, c.when("or who checked") + 1.2, 0.5);
        ttl.update(P(t, c.cue(1) - 0.2, 0.9));
        fadeIn(left, P(t, c.cue(1) + 0.2, 0.5));
        left.querySelector(".claims").style.opacity = P(t, c.when("Nothing checks"), 0.5);
        fadeIn(right, P(t, c.cue(2), 0.5));
        [...right.querySelectorAll(".ev")].forEach((x, i) => fadeIn(x, P(t, c.cue(2) + 0.3 + i * 0.3, 0.3), 6));
        fadeIn(note, P(t, c.when("as a note") - 0.2, 0.6));
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
    const lines = ["One owner per task.", "Checks Atelier ran itself.", "Another model family's approval.", "Plans built in parallel.", "A record of every model."].map((t, i) => {
      const l = pos(h("div", { class: "abs display", text: t, style: { fontSize: "52px", width: "1920px", textAlign: "center", left: 0 } }), 0, 170 + i * 74);
      hud.append(l); return l;
    });
    const key = ["One owner", "Checks Atelier", "Another model", "Plans built", "A record"];
    const line = kinetic("Git keeps the code. Atelier keeps the record.", "kin display", { position: "absolute", left: 0, right: 0, top: "250px", textAlign: "center", fontSize: "84px" });
    hud.append(line.el);
    const nums = pos(h("div", { class: "abs", style: { display: "flex", gap: "120px", justifyContent: "center", width: "1920px", left: 0 } },
      ...[[f.tasks, "tasks"], [f.states.merged, "merged"]].map(([n, l]) => h("div", { style: { textAlign: "center" } }, h("div", { class: "big-num", "data-n": n, text: "0" }), h("div", { class: "label", text: l, style: { marginTop: "8px" } })))), 0, 400);
    const url = pos(h("div", { class: "abs display", text: "atelier.zone", style: { fontSize: "120px", width: "1920px", textAlign: "center", left: 0 } }), 0, 600);
    const repo = pos(h("div", { class: "abs mono", text: "github.com/pavithran/atelier · MIT licence", style: { fontSize: "34px", width: "1920px", textAlign: "center", color: "var(--signal)" } }), 0, 760);
    const t293 = pos(h("div", { class: "abs mono dim", text: `This film is task t293 in the same ledger · figures as of ${f.cutoff.slice(0, 10)} ${f.cutoff.slice(11, 16)} UTC`, style: { fontSize: "20px", width: "1920px", textAlign: "center" } }), 0, 830);
    hud.append(nums, url, repo, t293);
    key.forEach((k) => c.sfx(c.when(k), "tick", 0.7));
    c.sfx(c.cue(1), "swell", 0.7); c.sfx(c.cue(2), "chime", 0.9);
    return {
      el,
      update(t) {
        F.at(F.T1, 0.2 + 0.06 * Math.sin(t * 0.8));
        const view = cam.set(t, [[0, F.W / 2, F.MAINY - 80, 0.42], [c.dur, F.W / 2, F.MAINY - 60, 0.46]], 0.5);
        const out = 1 - P(t, c.cue(1) - 0.4, 0.5);
        lines.forEach((l, i) => fadeIn(l, P(t, c.when(key[i]) - 0.1, 0.4) * out, 14));
        line.update(P(t, c.cue(1), 1.2));
        nums.style.opacity = P(t, c.when("It built itself") - 0.2, 0.6);
        [...nums.querySelectorAll(".big-num")].forEach((x, i) => count(x, Number(x.dataset.n), (t - c.when("It built itself") - i * 0.4) / 1.6));
        fadeIn(url, P(t, c.cue(2), 0.7));
        fadeIn(repo, P(t, c.when("open source") + 0.1, 0.7));
        fadeIn(t293, P(t, c.cueEnd(2) + 0.3, 0.7));
        return view;
      },
    };
  };

  // ── the player ──────────────────────────────────────────────────────────
  let built = [], captions = [], sounds = [];
  const capEl = () => document.querySelector("#caption span");
  // Scenes that hand over without a dip to black, because the next one
  // continues the picture.
  const MATCH = new Set(["cold>contents"]);
  const LIGHT = new Set(["why", "metrics"]);
  const CHAPTER_OF = { why: 1, cast: 2, gate: 3, plan: 4, metrics: 5, cloud: 6 };

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
    ch.innerHTML = CHAPTER_OF[cur.sc.id] ? `<b>${CHAPTER_OF[cur.sc.id]}</b>${esc(CHAPTERS[CHAPTER_OF[cur.sc.id] - 1])}` : "";
    ch.style.opacity = P(t, 0.3, 0.6);
    const cap = captions.find((k) => T >= k.start && T < k.end + 0.25);
    capEl().textContent = cap ? cap.text : "";
  }

  window.film = { init, seek, sounds: () => sounds.sort((a, b) => a.t - b.t) };
})();
