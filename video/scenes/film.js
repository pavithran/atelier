// The film's scenes. Each scene is a pure function of time: build() makes
// its elements once, and update(t) sets every property from the scene's
// local time t in seconds. build.mjs drives the clock with film.seek(T) and
// takes one screenshot per frame, so the frames are the same on every run.
// Narration beats come from the timeline: c.cue(i) is when cue i starts.

(() => {
  // ── helpers ─────────────────────────────────────────────────────────────
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const P = (t, a, d = 0.6) => ease(clamp((t - a) / d));
  const lerp = (a, b, k) => a + (b - a) * k;
  const SVGNS = "http://www.w3.org/2000/svg";

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
  // Backticked spans of a quoted finding become code.
  const quoteHtml = (x) => esc(x).replace(/`([^`]+)`/g, "<code>$1</code>");
  function fadeIn(el, k, dy = 22) { el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * dy}px)`; }
  function pos(el, x, y, w) { el.style.left = x + "px"; el.style.top = y + "px"; if (w) el.style.width = w + "px"; return el; }

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
  const FAMILY_NAME = { anthropic: "Anthropic · Claude", zai: "Zhipu · GLM", openai: "OpenAI · GPT", deepseek: "DeepSeek", google: "Google · Gemini", xiaomi: "Xiaomi · MiMo" };
  const NAMES = {
    "opus-5.5": "Opus 5.5", "sonnet-5.5": "Sonnet 5.5", "fable-5.1": "Fable 5.1", "glm-5.3": "GLM-5.3", "GLM-5.3-Flash-4_8bit": "GLM-5.3 Flash",
    "glm-5.3-flash": "GLM-5.3 Flash", "gpt-6-astra": "gpt-6-astra", "gpt-6.1-sol": "gpt-6.1-sol", "gpt-6": "gpt-6", "gpt-5.5": "gpt-5.5",
    "gemini-3.1-pro": "Gemini 3.1 Pro", "gemini-3.1-pro-preview": "Gemini 3.1 Pro preview", "deepseek-v4-pro": "DeepSeek V4 Pro",
    "xiaomi-mimo-v2.6-pro": "MiMo v2.6 Pro", "gpt-oss-120b": "GPT-OSS 120B",
  };
  const nice = (a) => NAMES[a.split("/").pop()] ?? a.split("/").pop();
  const chip = (actor, extra = "") => h("span", { class: "chip", style: { color: col(fam(actor)) } }, h("span", { class: "dot" }), nice(actor) + extra);
  const utc = (iso, secs = false) => iso.slice(11, secs ? 19 : 16) + " UTC";
  const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const day = (iso) => `${Number(iso.slice(8, 10))} ${MONTH[Number(iso.slice(5, 7)) - 1]}`;
  const dur = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;

  // A real page in a browser window, panned by keyframes [t, y, scale] in
  // the captured image's pixels (1920 wide).
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
    };
  }

  // Faint threads that fork from a main line and return to it, coloured by
  // the builder family of real merged tasks, in merge order.
  function threads(data, { y0 = 1000, top = 760, count = 44, opacity = 0.32 } = {}) {
    const merged = data.tasks.filter((t) => t.state === "merged").sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : 1));
    const svg = s("svg", { width: 1920, height: 1080, class: "abs", style: `left:0;top:0;opacity:${opacity}` });
    svg.append(s("line", { x1: 0, y1: y0, x2: 1920, y2: y0, stroke: "var(--main-line)", "stroke-width": 2.5, opacity: 0.7 }));
    const paths = [];
    for (let i = 0; i < count; i++) {
      const t = merged[Math.floor(i * merged.length / count)];
      const x0 = -80 + i * 46, len = 240 + ((i * 97) % 7) * 70, y = y0 - 30 - ((i * 53) % 9) * ((y0 - top) / 9);
      const d = `M ${x0} ${y0} C ${x0 + 40} ${y0}, ${x0 + 30} ${y}, ${x0 + 80} ${y} L ${x0 + 80 + len} ${y} C ${x0 + 130 + len} ${y}, ${x0 + 120 + len} ${y0}, ${x0 + 170 + len} ${y0}`;
      const p = s("path", { d, fill: "none", stroke: col(t.builderFamilies[0] ?? "other"), "stroke-width": 2.5 });
      svg.append(p);
      paths.push(p);
    }
    return {
      el: svg,
      update(t) {
        paths.forEach((p, i) => {
          const L = p.__len ?? (p.__len = p.getTotalLength());
          const k = clamp((t - i * 0.12) / 3.2);
          p.style.strokeDasharray = L;
          p.style.strokeDashoffset = L * (1 - ease(k));
        });
      },
    };
  }

  // ── scenes ──────────────────────────────────────────────────────────────
  const SCENES = {};

  SCENES.open = (c, data) => {
    const el = h("div");
    const th = threads(data, { y0: 1010, top: 830 });
    el.append(th.el);
    const lines = [
      ["Many agents. One repository.", "var(--text-bright)"],
      ["Nothing merges without proof.", "var(--text-bright)"],
      ["Atelier built itself this way.", "var(--signal)"],
    ].map(([text, color], i) => { const l = pos(h("div", { class: "abs display", text, style: { fontSize: "96px", lineHeight: "1.05", color } }), 140, 170 + i * 122); el.append(l); return l; });
    const f = data.facts;
    const fams = Object.keys(f.mergedBuilderFamilies).length;
    const nums = [[f.tasks, "tasks in its own project"], [f.states.merged, "merged"], [fams, "model families built them"]].map(([n, label], i) => {
      const box = pos(h("div", { class: "abs" }, h("div", { class: "big-num", text: "0" }), h("div", { class: "label", text: label, style: { marginTop: "10px" } })), 140 + i * 470, 560);
      el.append(box);
      return { box, n };
    });
    const foot = pos(h("div", { class: "abs mono dim", text: `atelier.zone · the atelier project's ledger, ${f.cutoff.slice(0, 10)} ${f.cutoff.slice(11, 16)} UTC`, style: { fontSize: "19px" } }), 140, 752);
    el.append(foot);
    return {
      el,
      update(t) {
        th.update(t);
        fadeIn(lines[0], P(t, 0.25, 0.8));
        fadeIn(lines[1], P(t, c.cue(1), 0.8));
        fadeIn(lines[2], P(t, c.cue(2), 0.8));
        const n0 = c.cue(2) + 1.2;
        nums.forEach(({ box, n }, i) => {
          fadeIn(box, P(t, n0 + i * 0.35, 0.6));
          box.firstChild.textContent = Math.round(n * ease(clamp((t - n0 - i * 0.35) / 1.6)));
        });
        fadeIn(foot, P(t, n0 + 1.4, 0.8));
      },
    };
  };

  SCENES.forks = (c, data) => {
    const el = h("div");
    // A: one task, one owner.
    const A = h("div", { class: "abs", style: { inset: 0 } });
    const card = pos(h("div", { class: "card" },
      h("div", { class: "label", text: "Task t70 · from the ledger" }),
      h("div", { style: { font: "700 36px/1.2 var(--font-display)", margin: "12px 0 16px", color: "var(--text-bright)" }, html: "Two commands for an agent: <code>atelier start ID</code> and <code>atelier done \"summary\"</code>…" }),
      h("div", { class: "mono dim", style: { fontSize: "20px" }, html: "scope&nbsp;&nbsp;<span style='color:var(--text)'>cli/** · test/** · README.md</span>" }),
      h("div", { class: "mono", style: { fontSize: "22px", marginTop: "18px" } }, h("span", { class: "dim", text: "owner  " }), h("span", { class: "owner", text: "none" }))), 200, 230, 860);
    A.append(card);
    const owner = card.querySelector(".owner");
    const agent = pos(h("div", { class: "abs" }, chip("codex/gpt-6-astra")), 200, 640);
    const second = pos(h("div", { class: "abs" }, h("span", { class: "chip", style: { color: "var(--text-muted)" } }, h("span", { class: "dot" }), "a second agent")), 1300, 470);
    const refused = pos(h("div", { class: "abs mono", text: "claim refused: t70 already has an owner", style: { color: "var(--fault)", fontSize: "22px" } }), 1120, 560);
    const ledgerBox = pos(h("div", { class: "card", style: { padding: "18px 22px" } },
      h("div", { class: "label", text: "The project's Durable Object" }),
      h("div", { class: "mono", style: { fontSize: "20px", marginTop: "12px" }, html: "item.claimed&nbsp;&nbsp;<span style='color:var(--m-openai)'>codex/gpt-6-astra</span><br><span class='dim'>2026-10-05 14:33:55 UTC</span>" }),
      h("div", { class: "mono dim", style: { fontSize: "18px", marginTop: "10px" }, text: "one request at a time" })), 1180, 230, 560);
    A.append(agent, second, refused, ledgerBox);
    el.append(A);

    // B: five tasks held at once, each in its own fork.
    const B = h("div", { class: "abs", style: { inset: 0 } });
    const held = data.moment.held;
    const head = pos(h("div", { class: "abs" }, h("div", { class: "label", text: `${day(data.moment.at)} 2026 · ${utc(data.moment.at)} · the ledger shows ${held.length} tasks held at once` })), 140, 100);
    B.append(head);
    const svg = s("svg", { width: 1920, height: 1080, class: "abs", style: "left:0;top:0" });
    const MAINY = 190;
    svg.append(s("line", { x1: 120, y1: MAINY, x2: 1800, y2: MAINY, stroke: "var(--main-line)", "stroke-width": 4 }));
    svg.append(s("text", { x: 120, y: MAINY - 18, fill: "var(--text-muted)", "font-size": 20, text: "main · the baseline repository in Artifacts" }));
    const lanes = held.map((hd, i) => {
      const y = 300 + i * 118, x0 = 220 + i * 70;
      const color = col(fam(hd.actor));
      const d = `M ${x0} ${MAINY} C ${x0} ${y - 40}, ${x0 + 20} ${y}, ${x0 + 90} ${y} L 1290 ${y}`;
      const p = s("path", { d, fill: "none", stroke: color, "stroke-width": 4 });
      const dots = [0, 1, 2, 3].map(() => s("circle", { r: 7, fill: "var(--surface)", stroke: color, "stroke-width": 3, cy: y }));
      svg.append(p, ...dots);
      const label = pos(h("div", { class: "abs" }, h("span", { class: "mono", text: hd.id + "  ", style: { fontSize: "22px", color: "var(--text)" } }), chip(hd.actor)), x0 + 110, y - 62);
      const repo = pos(h("div", { class: "abs mono", style: { fontSize: "18px", lineHeight: "1.35" }, html: `<span class="dim">Artifacts</span> cloudflare-git--${hd.id}<br><span class="dim">write token</span> <span style="color:${color}">${esc(hd.actor)}</span> only` }), 1320, y - 26);
      B.append(label, repo);
      return { p, dots, label, repo, x0, y };
    });
    const block = s("g", {});
    const L3 = lanes[2];
    block.append(s("line", { x1: 1000, y1: L3.y - 14, x2: 1000, y2: MAINY + 26, stroke: "var(--fault)", "stroke-width": 3, "stroke-dasharray": "8 8" }));
    block.append(s("text", { x: 1016, y: MAINY + 52, fill: "var(--fault)", "font-size": 21, text: "✕ push to main refused: the token covers this fork only" }));
    svg.append(block);
    B.prepend(svg);
    el.append(B);

    // C: a handoff, t50.
    const C = h("div", { class: "abs", style: { inset: 0 } });
    const ho = data.stories.t50.handoffs[0];
    const svgC = s("svg", { width: 1920, height: 1080, class: "abs", style: "left:0;top:0" });
    const yC = 470;
    svgC.append(s("line", { x1: 140, y1: 300, x2: 1800, y2: 300, stroke: "var(--main-line)", "stroke-width": 4 }));
    const fableP = s("path", { d: `M 220 300 C 220 ${yC - 40}, 240 ${yC}, 320 ${yC} L 960 ${yC}`, fill: "none", stroke: col(fam(ho.from)), "stroke-width": 5 });
    const glmP = s("path", { d: `M 960 ${yC} L 1640 ${yC}`, fill: "none", stroke: col(fam(ho.to)), "stroke-width": 5 });
    const knot = s("circle", { cx: 960, cy: yC, r: 11, fill: "var(--signal)" });
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
    el.append(C);

    return {
      el,
      update(t) {
        const tB = c.cue(2), tC = c.cue(3);
        // A
        A.style.opacity = 1 - P(t, tB - 0.6, 0.6);
        A.style.display = t < tB ? "block" : "none";
        fadeIn(card, P(t, 0.2, 0.7));
        fadeIn(ledgerBox, P(t, 0.6, 0.7));
        const k = P(t, c.cue(0) + 3.0, 1.2);
        pos(agent, lerp(200, 230, k), lerp(640, 470, k));
        agent.style.opacity = P(t, c.cue(0) + 1.2, 0.5) * (1 - k);
        owner.textContent = k > 0.95 ? "codex/gpt-6-astra  🔒" : "none";
        owner.style.color = k > 0.95 ? "var(--m-openai)" : "var(--text-dim)";
        ledgerBox.children[1].style.opacity = k > 0.95 ? 1 : 0;
        const t2 = c.cue(1) + 0.8, bounce = clamp((t - t2) / 1.4);
        const bx = bounce < 0.5 ? lerp(1300, 1080, ease(bounce * 2)) : lerp(1080, 1300, ease((bounce - 0.5) * 2));
        pos(second, bx, 470);
        second.style.opacity = P(t, c.cue(1), 0.4);
        refused.style.opacity = P(t, t2 + 0.7, 0.4);
        // B
        B.style.display = t >= tB - 0.6 && t < tC ? "block" : "none";
        B.style.opacity = P(t, tB - 0.4, 0.7) * (1 - P(t, tC - 0.6, 0.6));
        fadeIn(head, P(t, tB, 0.6));
        lanes.forEach((ln, i) => {
          const L = ln.p.__len ?? (ln.p.__len = ln.p.getTotalLength());
          const q = P(t, tB + 0.4 + i * 0.45, 1.6);
          ln.p.style.strokeDasharray = L; ln.p.style.strokeDashoffset = L * (1 - q);
          fadeIn(ln.label, P(t, tB + 0.9 + i * 0.45, 0.5), 10);
          fadeIn(ln.repo, P(t, tB + 2.2 + i * 0.45, 0.5), 10);
          ln.dots.forEach((dot, j) => {
            const appear = tB + 2.6 + i * 0.3 + j * 1.6;
            const x = lerp(ln.x0 + 160, 1250, clamp((t - appear) / 9) * 0.25 + j * 0.24);
            dot.setAttribute("cx", x);
            dot.style.opacity = P(t, appear, 0.3);
          });
        });
        block.style.opacity = P(t, tB + (tC - tB) * 0.62, 0.5);
        // C
        C.style.display = t >= tC - 0.6 ? "block" : "none";
        C.style.opacity = P(t, tC - 0.3, 0.6);
        const Lf = fableP.__len ?? (fableP.__len = fableP.getTotalLength());
        const qf = P(t, tC + 0.3, 3.5);
        fableP.style.strokeDasharray = Lf; fableP.style.strokeDashoffset = Lf * (1 - qf);
        const hand = c.cue(3) + (c.cueEnd(3) - c.cue(3)) * 0.42;
        knot.style.opacity = P(t, hand - 0.6, 0.4);
        const Lg = 680; glmP.style.strokeDasharray = Lg; glmP.style.strokeDashoffset = Lg * (1 - P(t, hand + 1.2, 4));
        fadeIn(cHead, P(t, tC, 0.6));
        fadeIn(from, P(t, tC + 0.8, 0.5));
        fadeIn(tokenOld, P(t, tC + 1.2, 0.5));
        const tk = P(t, hand, 1.4);
        tokenOld.style.textDecoration = tk > 0.5 ? "line-through" : "none";
        revoked.style.opacity = P(t, hand + 0.6, 0.4);
        fadeIn(to, P(t, hand + 0.3, 0.5));
        fadeIn(tokenNew, P(t, hand + 0.9, 0.5));
        fadeIn(quote, P(t, hand + 2.2, 0.8));
      },
    };
  };

  SCENES.gate = (c, data) => {
    const st = data.stories.t278;
    const el = h("div");
    const header = pos(h("div", { class: "abs" },
      h("div", { class: "label", text: `Task t278 · ${day(st.mergedAt)} 2026 · built by` }),
      h("div", { style: { display: "flex", alignItems: "center", gap: "22px", marginTop: "10px" } },
        h("div", { class: "display", text: "Pull AI Gateway's logs into Analytics Engine", style: { fontSize: "50px" } }), chip(st.builders[0]))), 120, 92);
    el.append(header);
    // The rounds, from the ledger's events.
    const L = st.landing;
    const pushes = L.filter((e) => e.kind === "push.observed");
    const reviews = st.reviews;
    const rounds = pushes.map((p, i) => {
      const checks = L.filter((e) => e.kind === "evidence.observed" && e.head === p.head);
      const rv = reviews.find((r) => r.head === p.head);
      return { head: p.head, pushedAt: p.at, checks, review: rv };
    });
    const COLS = [120, 470, 900, 1330];
    const colHead = ["Revision pushed", "Required checks, clean clone", "Review, another family", "Verdict"].map((x, i) => pos(h("div", { class: "abs label", text: x }), COLS[i], 236));
    el.append(...colHead);
    const rows = rounds.map((r, i) => {
      const y = 280 + i * 108;
      const head = pos(h("div", { class: "abs mono", style: { fontSize: "22px" }, html: `<span style="color:var(--text-bright)">${r.head}</span><br><span class="dim">${utc(r.pushedAt, true)}</span>` }), COLS[0], y);
      const checks = pos(h("div", { class: "abs mono", style: { fontSize: "21px", lineHeight: "1.5" } },
        ...r.checks.map((ck) => h("div", { html: `<span style="color:var(--observed)">✓ observed</span> <span class="dim">${esc(ck.claim.split("&&").pop().trim())}</span>` }))), COLS[1], y);
      const rev = pos(h("div", { class: "abs" }, chip(r.review.by)), COLS[2], y + 6);
      const verdict = pos(h("div", { class: "abs" }, h("span", { class: "stamp", text: r.review.approve ? "approved" : "rejected", style: { color: r.review.approve ? "var(--observed)" : "var(--fault)" } }), h("span", { class: "mono dim", text: "  " + utc(r.review.at, true), style: { fontSize: "19px" } })), COLS[3], y + 2);
      el.append(head, checks, rev, verdict);
      return { head, checks, rev, verdict, y };
    });
    // The lower panel changes with the narration.
    const panel = (...kids) => { const p = pos(h("div", { class: "abs" }, ...kids), 120, 640, 1680); el.append(p); return p; };
    const r0 = rounds[0];
    const pEvidence = panel(
      h("div", { class: "label", text: `How the checks at ${r0.head} were recorded` }),
      h("div", { class: "mono", style: { fontSize: "22px", marginTop: "16px", lineHeight: "1.7" } },
        ...r0.checks.map((ck) => h("div", { html: `<span style="color:var(--observed)">Observed</span>&nbsp;&nbsp;${esc(ck.claim)}&nbsp;&nbsp;<span class="dim">passed ${utc(ck.at, true)}</span>` })),
        h("div", { style: { opacity: 0.45 }, html: `<span>Reported</span>&nbsp;&nbsp;&nbsp;an agent's own word that its tests pass&nbsp;&nbsp;<span class="dim">shown, never counted by the gate</span>` })));
    const fams = ["claude-code/opus-5.5", "claude-code/sonnet-5.5", "claude-code/fable-5.1"];
    const pReviewer = panel(
      h("div", { class: "label", text: "Who may approve: a model of another family than everyone who worked on t278" }),
      h("div", { style: { display: "flex", gap: "18px", alignItems: "center", marginTop: "20px" } },
        ...fams.map((a) => h("span", { class: "chip excluded", style: { color: col(fam(a)), opacity: 0.4, textDecoration: "line-through" } }, h("span", { class: "dot" }), nice(a))),
        h("span", { class: "mono dim", text: "same family as the builder", style: { fontSize: "20px", marginRight: "40px" } }),
        chip(r0.review.by), h("span", { class: "mono", text: "took the review", style: { fontSize: "20px", color: "var(--observed)" } })));
    const findingsPanel = (r, title, verdicts) => panel(
      h("div", { class: "label", text: title }),
      h("div", { style: { display: "grid", gridTemplateColumns: `repeat(${r.review.findings.filter((f) => f.severity === "blocking").length}, 1fr)`, gap: "40px", marginTop: "16px" } },
        ...r.review.findings.filter((f) => f.severity === "blocking").map((f, i) => h("div", { class: "quote", html: `“${quoteHtml(f.text)}”<span class="src">${esc(f.file)}:${f.line} · blocking${verdicts[i] ? `<span style="color:var(--observed)"> · owner's verdict: ${esc(verdicts[i].verdict)}</span>` : ""}</span>` }))));
    const v1 = st.verdicts.filter((v) => v.head === rounds[0].head);
    const v2 = st.verdicts.filter((v) => v.head === rounds[1].head);
    const pF1 = findingsPanel(rounds[0], `Gemini 3.1 Pro's findings at ${rounds[0].head}, quoted`, v1);
    const pF2 = findingsPanel(rounds[1], `Its finding at ${rounds[1].head}, quoted`, v2);
    const acc = L.find((e) => e.kind === "item.accepted"), mer = L.find((e) => e.kind === "item.merged");
    const last = rounds.at(-1);
    const pMerge = panel(
      h("div", { class: "label", text: "The end of the landing, from the ledger" }),
      h("div", { class: "mono", style: { fontSize: "26px", marginTop: "18px", lineHeight: "1.7" }, html:
        `<span style="color:var(--observed)">review.approved</span>&nbsp;&nbsp;${esc(last.review.by)}&nbsp;&nbsp;<span class="dim">${utc(last.review.at, true)}</span><br>` +
        `<span style="color:var(--signal)">item.accepted</span>&nbsp;&nbsp;&nbsp;&nbsp;head ${last.head}&nbsp;&nbsp;<span class="dim">${utc(acc.at, true)}</span><br>` +
        `<span style="color:var(--main-line)">item.merged</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;as ${mer.mergeCommit}&nbsp;&nbsp;<span class="dim">${utc(mer.at, true)}</span>` }));
    const shot = browser("t278", "atelier.zone<b>/p/atelier/t278</b>", "captured from the live site");
    const shot2 = browser("t278", "atelier.zone<b>/p/atelier/t278</b>", "captured from the live site");
    el.append(shot.el, shot2.el);
    const marks = data.screens.t278.marks;
    const thread = marks["Thread"].y - 40, reviewsY = marks["Checks and reviews"].y - 30;
    return {
      el,
      update(t) {
        const end = c.dur;
        fadeIn(header, P(t, 0.2, 0.7));
        colHead.forEach((x, i) => fadeIn(x, P(t, 1.0 + i * 0.15, 0.5), 8));
        const R = [
          { head: c.cue(0) + 1.4, checks: c.cue(1) + 0.6, rev: c.cue(2) + 2.5, verdict: c.cue(3) + 0.3 },
          { head: c.cue(4) + 0.4, checks: c.cue(4) + 1.0, rev: c.cue(4) + 1.6, verdict: c.cue(4) + 2.4 },
          { head: c.cue(5) - 0.4, checks: c.cue(5) + 0.0, rev: c.cue(5) + 0.4, verdict: c.cue(5) + 1.0 },
        ];
        rows.forEach((r, i) => {
          fadeIn(r.head, P(t, R[i].head, 0.5), 10);
          [...r.checks.children].forEach((x, j) => fadeIn(x, P(t, R[i].checks + j * 0.5, 0.4), 6));
          fadeIn(r.rev, P(t, R[i].rev, 0.5), 10);
          const k = P(t, R[i].verdict, 0.35);
          r.verdict.style.opacity = k; r.verdict.style.transform = `scale(${lerp(1.5, 1, k)})`; r.verdict.style.transformOrigin = "0 50%";
        });
        const win = (p, a, b) => { p.style.display = t >= a && t < b + 0.4 ? "block" : "none"; p.style.opacity = P(t, a, 0.5) * (1 - P(t, b, 0.4)); };
        win(pEvidence, c.cue(1) + 0.8, c.cue(2));
        win(pReviewer, c.cue(2) + 0.6, c.cue(3));
        [...pReviewer.querySelectorAll(".excluded")].forEach((x, i) => { x.style.opacity = lerp(1, 0.4, P(t, c.cue(2) + 2.0 + i * 0.2, 0.5)); x.style.textDecoration = t > c.cue(2) + 2.2 + i * 0.2 ? "line-through" : "none"; });
        win(pF1, c.cue(3) + 0.6, c.cue(4) + 0.6);
        [...pF1.querySelectorAll(".src span")].forEach((x) => { x.style.opacity = P(t, c.cue(4) + 0.0, 0.4); });
        win(pF2, c.cue(4) + 3.0, c.cue(5));
        [...pF2.querySelectorAll(".src span")].forEach((x) => { x.style.opacity = P(t, c.cue(4) + (c.cueEnd(4) - c.cue(4)) * 0.8, 0.4); });
        win(pMerge, c.cue(5) + 1.4, end + 1);
        // The real page, after the narration.
        const ts = c.cueEnd(5) + 0.6;
        shot.el.style.display = t >= ts ? "block" : "none";
        shot.el.style.opacity = P(t, ts, 0.6);
        shot.el.style.transform = `translateY(${(1 - P(t, ts, 0.8)) * 40}px)`;
        shot.pan(t, [[ts, thread - 40, 1.45, 360], [ts + 3, thread + 10, 1.45, 360]]);
        const t2 = ts + 3.0;
        shot2.el.style.display = t >= t2 ? "block" : "none";
        shot2.el.style.opacity = P(t, t2, 0.5);
        shot2.pan(t, [[t2, reviewsY - 60, 1.45, 360], [c.dur, reviewsY, 1.45, 360]]);
      },
    };
  };

  SCENES.catches = (c, data) => {
    const el = h("div");
    const card = (id, x, rejectIdx, approveNote) => {
      const st = data.stories[id];
      const rej = st.reviews.filter((r) => !r.approve);
      const r = rej[rejectIdx];
      const f = r.findings.find((x) => x.severity === "blocking");
      const ok = st.reviews.filter((x) => x.approve).at(-1);
      const firstSentence = f.text.split(/(?<=[.;])\s/)[0];
      const el2 = pos(h("div", { class: "card", style: { height: "420px" } },
        h("div", { class: "label", text: `Task ${id} · built by` }),
        h("div", { style: { display: "flex", gap: "12px", margin: "12px 0 18px", flexWrap: "wrap" } }, ...st.builders.map((b) => chip(b))),
        h("div", { style: { display: "flex", gap: "14px", alignItems: "center" } }, h("span", { class: "label", text: "reviewed by" }), chip(r.by),
          h("span", { class: "stamp rej", text: rej.length > 1 ? `rejected ×${rej.length}` : "rejected", style: { color: "var(--fault)", fontSize: "20px" } })),
        h("div", { class: "quote", style: { marginTop: "20px", fontSize: "22px" }, html: `“${quoteHtml(firstSentence)}”<span class="src">${esc(f.file)}:${f.line} · ${utc(r.at)}, ${day(r.at)}</span>` }),
        h("div", { class: "mono ok", style: { position: "absolute", bottom: "20px", fontSize: "20px", color: "var(--observed)" }, text: `fixed · approved by ${nice(ok.by)} ${utc(ok.at)} · merged` })), x, 112, 820);
      el.append(el2);
      return el2;
    };
    const a = card("t219", 120, 0), b = card("t252", 980, 1);
    // Reviews by model, in this project.
    const f = data.facts;
    const stats = pos(h("div", { class: "abs", style: { display: "flex", gap: "70px", alignItems: "flex-end" } },
      ...[[f.modelReviews, "reviews by models"], [f.modelRejections, "sent the work back"], [f.blockingFindings, "blocking findings"]].map(([n, l]) => h("div", {}, h("div", { class: "big-num", text: n, style: { fontSize: "92px" } }), h("div", { class: "label", text: l, style: { marginTop: "6px" } })))), 120, 600);
    el.append(stats);
    const models = Object.entries(f.reviewsByModel).sort((x, y) => y[1] - x[1]);
    const max = models[0][1];
    const chart = pos(h("div", { class: "abs" }, h("div", { class: "label", text: "Reviews (bar) and rejections (red) by reviewer, atelier project", style: { marginBottom: "10px" } }),
      ...models.map(([m, n]) => {
        const rj = f.rejectionsByModel[m] ?? 0;
        return h("div", { style: { display: "flex", alignItems: "center", gap: "12px", height: "33px" } },
          h("div", { class: "mono", text: NAMES[m] ?? m, style: { width: "260px", fontSize: "18px", color: col(fam(m)), textAlign: "right" } }),
          h("div", { class: "bar", style: { position: "relative", height: "18px", width: `${n / max * 420}px`, background: col(fam(m)), opacity: 0.85, borderRadius: "3px" } },
            h("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: `${rj / n * 100}%`, background: "var(--fault)", borderRadius: "3px" } })),
          h("div", { class: "mono dim", text: `${n} · ${rj}`, style: { fontSize: "17px" } }));
      })), 1080, 568);
    el.append(chart);
    return {
      el,
      update(t) {
        fadeIn(a, P(t, c.cue(0) + 0.6, 0.7));
        a.querySelector(".rej").style.opacity = P(t, c.cue(0) + 5.0, 0.4);
        a.querySelector(".quote").style.opacity = P(t, c.cue(0) + 6.0, 0.6);
        a.querySelector(".ok").style.opacity = P(t, c.cue(1) + 6.5, 0.5);
        fadeIn(b, P(t, c.cue(1), 0.7));
        b.querySelector(".rej").style.opacity = P(t, c.cue(1) + 2.0, 0.4);
        b.querySelector(".quote").style.opacity = P(t, c.cue(1) + 3.0, 0.6);
        b.querySelector(".ok").style.opacity = P(t, c.cue(1) + 6.8, 0.5);
        fadeIn(stats, P(t, c.cue(2) + 0.2, 0.6));
        fadeIn(chart, P(t, c.cue(2) + 1.2, 0.6));
        [...chart.querySelectorAll(".bar")].forEach((x, i) => { x.style.transformOrigin = "0 50%"; x.style.transform = `scaleX(${P(t, c.cue(2) + 1.4 + i * 0.12, 0.7)})`; });
      },
    };
  };

  SCENES.plan = (c, data) => {
    const pl = data.plan;
    const el = h("div");
    const goal = pos(h("div", { class: "card", style: { padding: "18px 24px" } },
      h("div", { class: "label", text: `Plan t197 · the owner's goal · ${day(data.tasks.find((t) => t.id === "t197").createdAt)} 2026, ${utc(data.tasks.find((t) => t.id === "t197").createdAt)}` }),
      h("div", { style: { font: "500 26px/1.4 var(--font-sans)", marginTop: "8px", color: "var(--text-bright)" }, text: pl.goal.slice(0, 200).replace(/\s+\S*$/, "") + " …" })), 120, 92, 1680);
    el.append(goal);
    const planner = pos(h("div", { class: "abs", style: { display: "flex", gap: "12px", alignItems: "center" } }, h("span", { class: "label", text: "planner" }), chip(pl.planner), h("span", { class: "mono dim", text: `proposed ${pl.proposed.length} parts · ${utc(pl.proposedAt)}`, style: { fontSize: "19px" } })), 120, 262);
    el.append(planner);
    const approve = pos(h("div", { class: "abs", style: { textAlign: "right" } }, h("span", { class: "stamp", text: `approved ${utc(pl.approvedAt)}`, style: { color: "var(--signal)", fontSize: "22px" } }), h("div", { class: "mono dim", text: `by its hash ${pl.hash.slice(0, 12)}…`, style: { fontSize: "18px", marginTop: "8px" } })), 1420, 244);
    el.append(approve);
    // The proposed parts, by dependency depth.
    const depth = {};
    const byKey = Object.fromEntries(pl.proposed.map((p) => [p.key, p]));
    const dOf = (k) => depth[k] ?? (depth[k] = byKey[k].dependsOn.length ? 1 + Math.max(...byKey[k].dependsOn.map(dOf)) : 0);
    pl.proposed.forEach((p) => dOf(p.key));
    const perCol = {};
    const svg = s("svg", { width: 1920, height: 1080, class: "abs", style: "left:0;top:0" });
    el.append(svg);
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
      el.append(n);
      nodes[p.key] = { el: n, x, y, part, d };
    }
    const edges = [];
    for (const p of pl.proposed) for (const dep of p.dependsOn) {
      const a = nodes[dep], b = nodes[p.key];
      const e = s("path", { d: `M ${a.x + NW} ${a.y + NH / 2} C ${a.x + NW + 40} ${a.y + NH / 2}, ${b.x - 40} ${b.y + NH / 2}, ${b.x} ${b.y + NH / 2}`, fill: "none", stroke: "var(--line-bright)", "stroke-width": 3 });
      svg.append(e); edges.push({ e, d: b.d });
    }
    // Integration onto the plan's branch, at the real times.
    const ints = pl.parts.filter((p) => p.integratedAt).sort((a, b) => (a.integratedAt < b.integratedAt ? -1 : 1));
    const t0 = Date.parse("2026-10-07T04:30:00Z"), t1 = Date.parse(pl.mergedAt) + 20 * 60000;
    const X = (iso) => 360 + (Date.parse(iso) - t0) / (t1 - t0) * 1340;
    const BY = 704, MY = 800;
    const branch = s("line", { x1: 320, y1: BY, x2: X(pl.mergedAt), y2: BY, stroke: "var(--signal)", "stroke-width": 4 });
    const mainL = s("line", { x1: 320, y1: MY, x2: 1800, y2: MY, stroke: "var(--main-line)", "stroke-width": 4 });
    const toMain = s("path", { d: `M ${X(pl.mergedAt)} ${BY} C ${X(pl.mergedAt) + 40} ${BY}, ${X(pl.mergedAt) + 20} ${MY}, ${X(pl.mergedAt) + 70} ${MY}`, fill: "none", stroke: "var(--signal)", "stroke-width": 4 });
    const bl = s("text", { x: 120, y: BY + 6, fill: "var(--signal)", "font-size": 19, text: "the plan's branch" });
    const ml = s("text", { x: 120, y: MY + 6, fill: "var(--text-muted)", "font-size": 19, text: "main" });
    svg.append(branch, mainL, toMain, bl, ml);
    const marks = ints.map((p) => {
      const x = X(p.integratedAt);
      const g = s("g", {});
      const color = col(fam(p.builders[0]));
      if (p.added) g.append(s("rect", { x: x - 8, y: BY - 8, width: 16, height: 16, transform: `rotate(45 ${x} ${BY})`, fill: color }));
      else g.append(s("circle", { cx: x, cy: BY, r: 10, fill: color, stroke: col(fam(p.approvedBy[0] ?? "")), "stroke-width": 4 }));
      g.append(s("text", { x, y: BY + [32, -20, 54, -42][ints.indexOf(p) % 4], "text-anchor": "middle", fill: "var(--text-muted)", "font-size": 16, text: p.id }));
      svg.append(g);
      return { g, p };
    });
    const addedNote = pos(h("div", { class: "abs mono dim", style: { fontSize: "17px" }, html: "◆ parts added to merge main into the branch as main moved" }), 160, 846);
    const mergedStamp = pos(h("div", { class: "abs" }, h("span", { class: "stamp", text: `accepted and merged ${utc(pl.mergedAt)}, ${day(pl.mergedAt)}`, style: { color: "var(--observed)", fontSize: "22px" } }),
      h("div", { class: "mono dim", text: `${ints.length} parts integrated · ${pl.jobsUsed} of ${pl.maxJobs} part dispatches used`, style: { fontSize: "18px", marginTop: "10px" } })), 1100, 818);
    el.append(addedNote, mergedStamp);
    const axis = s("text", { x: 1800, y: BY - 52, "text-anchor": "end", fill: "var(--text-dim)", "font-size": 16, text: `${day("2026-10-07T04:30:00Z")}, 04:30 UTC → ${utc(pl.mergedAt)}` });
    svg.append(axis);
    const shot = browser("plans", "atelier.zone<b>/p/atelier/plans</b>", "captured from the live site");
    el.append(shot.el);
    const H = data.screens.plans.height;
    return {
      el,
      update(t) {
        fadeIn(goal, P(t, c.cue(0) + 1.0, 0.7));
        fadeIn(planner, P(t, c.cue(1), 0.6));
        Object.values(nodes).forEach((n, i) => {
          const k = P(t, c.cue(1) + 0.8 + n.d * 0.5 + i * 0.12, 0.5);
          n.el.style.opacity = k; n.el.style.transform = `scale(${lerp(0.85, 1, k)})`;
          const k2 = P(t, c.cue(2) + 1.5 + i * 0.35, 0.5);
          n.el.style.borderColor = k2 > 0.5 ? col(fam(n.part.approvedBy[0] ?? "")) : "var(--line-bright)";
          n.el.style.boxShadow = k2 > 0.5 ? `inset 6px 0 0 ${col(fam(n.part.builders[0]))}, 0 20px 60px rgba(0,0,0,.45)` : "";
          n.el.querySelector(".who").style.opacity = k2;
        });
        edges.forEach(({ e, d }) => { e.style.opacity = P(t, c.cue(1) + 0.8 + d * 0.5, 0.5); });
        const ka = P(t, c.cue(1) + (c.cueEnd(1) - c.cue(1)) * 0.6, 0.35);
        approve.style.opacity = ka; approve.style.transform = `scale(${lerp(1.4, 1, ka)})`; approve.style.transformOrigin = "100% 0";
        const ti = c.cue(3);
        [branch, bl, axis].forEach((x) => (x.style.opacity = P(t, ti, 0.6)));
        [mainL, ml].forEach((x) => (x.style.opacity = P(t, ti + 0.3, 0.6)));
        const span = c.cueEnd(3) - ti;
        marks.forEach((m, i) => { const k = P(t, ti + 0.8 + i * (span - 1.5) / marks.length, 0.4); m.g.style.opacity = k; m.g.style.transform = `translateY(${(1 - k) * -30}px)`; });
        addedNote.style.opacity = P(t, ti + span * 0.7, 0.5);
        toMain.style.opacity = P(t, c.cue(4) + 1.0, 0.5);
        fadeIn(mergedStamp, P(t, c.cue(4) + 2.0, 0.6), 10);
        const ts = c.cueEnd(4) + 0.6;
        shot.el.style.display = t >= ts ? "block" : "none";
        shot.el.style.opacity = P(t, ts, 0.6);
        shot.el.style.transform = `translateY(${(1 - P(t, ts, 0.8)) * 40}px)`;
        shot.pan(t, [[ts, 250, 1.22, 330], [ts + 1.2, 250, 1.22, 330], [c.dur, Math.min(H - 840, 1500), 1.22, 330]]);
      },
    };
  };

  SCENES.replay = (c, data) => {
    const el = h("div");
    const merged = data.tasks.filter((t) => t.state === "merged").sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : 1));
    const FAMS = ["anthropic", "zai", "openai", "deepseek", "google", "xiaomi"];
    const T0 = Date.parse("2026-10-03T21:00:00Z"), T1 = Date.parse("2026-10-08T00:00:00Z");
    const X0 = 150, X1 = 1470;
    const X = (ms) => X0 + (ms - T0) / (T1 - T0) * (X1 - X0);
    const laneH = { anthropic: 230, zai: 120, openai: 64, deepseek: 64, google: 48, xiaomi: 40 };
    let y = 190;
    const laneY = {};
    for (const f of FAMS) { laneY[f] = y + laneH[f]; y += laneH[f] + 14; }
    const AXY = y + 6;
    const svg = s("svg", { width: 1920, height: 1080, class: "abs", style: "left:0;top:0" });
    el.append(svg);
    for (const f of FAMS) {
      svg.append(s("line", { x1: X0, y1: laneY[f], x2: X1, y2: laneY[f], stroke: "var(--line)", "stroke-width": 1 }));
    }
    svg.append(s("line", { x1: X0, y1: AXY, x2: X1, y2: AXY, stroke: "var(--line-bright)", "stroke-width": 2 }));
    const days = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
    const dayEls = days.map((d) => {
      const a = Math.max(T0, Date.parse(d + "T00:00:00Z")), b = Date.parse(d + "T00:00:00Z") + 86400000;
      const g = s("g", {});
      g.append(s("line", { x1: X(b), y1: 180, x2: X(b), y2: AXY + 8, stroke: "var(--line)", "stroke-width": 1, "stroke-dasharray": "4 6" }));
      g.append(s("text", { x: (X(a) + X(b)) / 2, y: AXY + 30, "text-anchor": "middle", fill: "var(--text-dim)", "font-size": 18, text: day(d + "T00:00:00Z") }));
      const total = s("text", { x: (X(a) + X(b)) / 2, y: AXY + 70, "text-anchor": "middle", fill: "var(--text-bright)", "font-size": 34, "font-weight": 600, text: data.facts.mergedByDay[d] ?? 0 });
      g.append(total);
      svg.append(g);
      return { end: b, total };
    });
    // Dots stacked in 11-pixel columns within each lane.
    const stacks = {};
    const dots = merged.map((t) => {
      const f = t.builderFamilies[0] ?? "other";
      const lane = FAMS.includes(f) ? f : "anthropic";
      const x = X(Date.parse(t.mergedAt));
      const bin = Math.round(x / 11);
      const key = lane + bin;
      const n = (stacks[key] = (stacks[key] ?? -1) + 1);
      const cx = bin * 11, cy = laneY[lane] - 7 - n * 11;
      const ring = t.crossBy[0];
      const dot = s("circle", { cx, cy, r: 4.6, fill: col(f), stroke: ring ? col(ring) : "none", "stroke-width": ring ? 2.4 : 0 });
      svg.append(dot);
      return { dot, ms: Date.parse(t.mergedAt), cross: t.crossAtFinal, families: t.builderFamilies };
    });
    const playhead = s("line", { x1: X0, y1: 176, x2: X0, y2: AXY, stroke: "var(--signal)", "stroke-width": 2 });
    svg.append(playhead);
    const clock = s("text", { x: X0, y: 166, fill: "var(--signal)", "font-size": 18, "text-anchor": "middle", text: "" });
    svg.append(clock);
    // The family panel.
    const counts = data.facts.mergedBuilderFamilies;
    const panel = pos(h("div", { class: "abs" }, h("div", { class: "label", text: "Merged tasks built, by family", style: { marginBottom: "14px" } }),
      ...FAMS.map((f) => h("div", { class: "row", style: { display: "flex", alignItems: "center", gap: "12px", height: "46px" } },
        h("span", { style: { width: "16px", height: "16px", borderRadius: "50%", background: col(f), boxShadow: `0 0 10px ${col(f)}` } }),
        h("span", { class: "n mono", text: "0", style: { width: "56px", fontSize: "24px", color: "var(--text-bright)", textAlign: "right" } }),
        h("span", { text: FAMILY_NAME[f], style: { fontSize: "22px" } }))),
      h("div", { class: "mono dim", text: "A task two families built counts for each.", style: { fontSize: "15px", marginTop: "10px" } })), 1530, 190);
    el.append(panel);
    const head = pos(h("div", { class: "abs label", text: "Each dot: a merged task, at its merge time, in its builder's colour; ring: the family that approved it" }), 150, 112);
    el.append(head);
    const lanesLbl = FAMS.map((f) => { const l = s("text", { x: X0 - 12, y: laneY[f] - 6, "text-anchor": "end", fill: col(f), "font-size": 16, text: f === "zai" ? "GLM" : { anthropic: "Claude", openai: "GPT", deepseek: "DeepSeek", google: "Gemini", xiaomi: "MiMo" }[f] }); svg.append(l); return l; });
    // Since t193: every merge carries another family's approval.
    const since = Date.parse(data.facts.lastMergeWithoutCrossApproval.at);
    const sinceG = s("g", {});
    sinceG.append(s("rect", { x: X(since), y: 180, width: X1 - X(since), height: AXY - 180, fill: "rgba(95,224,143,.06)" }));
    sinceG.append(s("line", { x1: X(since), y1: 180, x2: X(since), y2: AXY, stroke: "var(--observed)", "stroke-width": 2 }));
    svg.append(sinceG);
    const sinceLbl = pos(h("div", { class: "abs mono", style: { fontSize: "18px", color: "var(--observed)", width: "520px" }, text: `from ${utc(data.facts.lastMergeWithoutCrossApproval.at)}, ${day(data.facts.lastMergeWithoutCrossApproval.at)}: ${data.facts.mergesSinceThen - 1} tasks in a row, each with another family's approval` }), X(since) + 12, 144);
    el.append(sinceLbl);
    const big = pos(h("div", { class: "abs" }, h("span", { class: "big-num", text: `${data.facts.mergedWithCrossFamilyApprovalAtFinalHead}`, style: { fontSize: "80px", color: "var(--observed)" } }), h("span", { class: "big-num", text: ` of ${data.facts.states.merged}`, style: { fontSize: "44px", color: "var(--text-muted)" } }),
      h("div", { class: "label", text: "approved by another family at the merged revision", style: { width: "330px", marginTop: "6px" } })), 1530, 650);
    el.append(big);
    const shot = browser("flow", "atelier.zone<b>/p/atelier/flow</b>", "captured from the live site");
    el.append(shot.el);
    const g = data.screens.flow.marks;
    const gy = Object.entries(g).find(([k, v]) => k.startsWith("svg@") && v.h > 1000)?.[1].y ?? 300;
    return {
      el,
      update(t) {
        fadeIn(head, P(t, 0.3, 0.6));
        panel.style.opacity = P(t, 0.6, 0.6);
        const a = c.cue(0) + 1.0, b = c.cueEnd(1) - 0.3;
        const now = lerp(T0, T1, clamp((t - a) / (b - a)));
        playhead.setAttribute("x1", X(now)); playhead.setAttribute("x2", X(now));
        clock.setAttribute("x", X(now));
        clock.textContent = t > a && t < b + 0.5 ? new Date(now).toISOString().slice(5, 16).replace("T", " ") + " UTC" : "";
        playhead.style.opacity = t > a - 0.3 && t < b + 1 ? 1 : 0;
        const live = {};
        const dim = P(t, c.cue(3) + 0.3, 0.8);
        for (const d of dots) {
          const k = clamp((now - d.ms) / 3.6e6 / 3);
          d.dot.style.opacity = (k > 0 ? 0.35 + 0.65 * k : 0) * (d.cross ? 1 : lerp(1, 0.22, dim));
          if (now >= d.ms) for (const f of d.families) live[f] = (live[f] ?? 0) + 1;
        }
        dayEls.forEach((dd) => (dd.total.style.opacity = now >= Math.min(dd.end, T1 - 1) ? 1 : 0));
        [...panel.querySelectorAll(".row")].forEach((r, i) => {
          r.querySelector(".n").textContent = live[FAMS[i]] ?? 0;
          const hi = P(t, c.cue(2) + 1.2 + i * 0.75, 0.3) * (1 - P(t, c.cue(2) + 1.95 + i * 0.75, 0.3));
          r.style.transform = `translateX(${hi * 12}px)`;
        });
        lanesLbl.forEach((l) => (l.style.opacity = P(t, 0.8, 0.6)));
        sinceG.style.opacity = P(t, c.cue(3) + (c.cueEnd(3) - c.cue(3)) * 0.55, 0.6);
        sinceLbl.style.opacity = sinceG.style.opacity;
        fadeIn(big, P(t, c.cue(3) + 0.6, 0.6));
        const ts = c.cueEnd(3) + 0.8;
        shot.el.style.display = t >= ts ? "block" : "none";
        shot.el.style.opacity = P(t, ts, 0.6);
        shot.el.style.transform = `translateY(${(1 - P(t, ts, 0.8)) * 40}px)`;
        shot.pan(t, [[ts, gy - 100, 1.24, 330], [ts + 1.0, gy - 100, 1.24, 330], [c.dur, gy + 700, 1.24, 330]]);
      },
    };
  };

  SCENES.terminal = (c, data) => {
    const el = h("div");
    const term = pos(h("div", { class: "term", style: { height: "800px" } }, h("div", { class: "bar" }, h("i"), h("i"), h("i"), h("span", { text: "  atelier — the owner's terminal", style: { marginLeft: "10px" } })), h("div", { class: "scroll", style: { position: "absolute", top: "40px", left: 0, right: 0, bottom: 0, overflow: "hidden" } }, h("pre", {}))), 120, 100, 1680);
    el.append(term);
    const pre = term.querySelector("pre"), scroller = term.querySelector(".scroll");
    const sessions = [["atelier show t278", data.terminal.t278], ["atelier show t197", data.terminal.t197]];
    // The landing, from the ledger.
    const L = data.stories.t278.landing;
    const lastLease = L.filter((e) => e.kind === "land.lease").at(-1);
    const land = L.filter((e) => e.kind.startsWith("land.") && e.at >= lastLease.at);
    const NAMES_LAND = { "land.lease": "took the project's landing lease", "land.merge": "merged main into the task", "land.regenerate": "regenerated fixtures", "land.push": "pushed the head", "land.check": "ran the required checks", "land.submit": "submitted", "land.review": "waited for the review", "land.accept": "accepted the head", "land.merged": "merged into main" };
    const landCard = pos(h("div", { class: "card", style: { padding: "26px 32px" } },
      h("div", { class: "label", text: `t278's third landing, as the ledger recorded it · ${day(lastLease.at)} 2026` }),
      h("div", { class: "mono", style: { fontSize: "24px", marginTop: "18px", lineHeight: "1.75" } },
        ...land.map((e) => h("div", { class: "ln", html: `<span class="dim">${utc(e.at, true).replace(" UTC", "")}</span>&nbsp;&nbsp;<span style="color:var(--signal)">${e.kind.padEnd(16, " ")}</span>${esc(NAMES_LAND[e.kind] ?? "")}${e.kind === "land.merge" && e.skipped ? " (already current)" : ""}${e.kind === "land.review" ? `: <span style="color:var(--observed)">approved by Gemini 3.1 Pro</span>` : ""}${e.kind === "land.merged" ? ` as ${e.mergeCommit}` : ""}&nbsp;&nbsp;<span class="dim">${dur(e.ms)}</span>` })))), 260, 150, 1400);
    el.append(landCard);
    return {
      el,
      update(t) {
        const starts = [c.cue(0) + 0.6, c.cue(1) - 0.2];
        let html = "";
        sessions.forEach(([cmd, out], i) => {
          const t0 = starts[i];
          if (t < t0) return;
          const typed = Math.floor(clamp((t - t0) / (cmd.length / 22)) * cmd.length);
          html += `<span class="prompt">~/atelier $</span> ${esc(cmd.slice(0, typed))}`;
          const tOut = t0 + cmd.length / 22 + 0.35;
          if (t < tOut) { html += `<span class="cursor"></span>\n`; return; }
          const lines = out.trimEnd().split("\n");
          const shown = Math.min(lines.length, Math.floor((t - tOut) / 0.09) + 1);
          html += "\n" + lines.slice(0, shown).map(esc).join("\n") + "\n\n";
        });
        if (t >= starts[1] + 3) html += `<span class="prompt">~/atelier $</span> <span class="cursor"></span>`;
        pre.innerHTML = html;
        const over = pre.scrollHeight - (800 - 40);
        pre.style.transform = `translateY(${-Math.max(0, over)}px)`;
        const tl = c.cue(2) + 0.2;
        term.style.opacity = 1 - P(t, tl, 0.5);
        term.style.display = t < tl + 0.6 ? "block" : "none";
        landCard.style.display = t >= tl ? "block" : "none";
        fadeIn(landCard, P(t, tl + 0.3, 0.6));
        [...landCard.querySelectorAll(".ln")].forEach((x, i) => fadeIn(x, P(t, tl + 0.8 + i * 0.75, 0.4), 6));
      },
    };
  };

  SCENES.cloud = (c, data) => {
    const el = h("div");
    const svg = s("svg", { width: 1920, height: 1080, class: "abs", style: "left:0;top:0" });
    el.append(svg);
    const band = (y, hgt, label, color) => {
      const g = s("g", {});
      g.append(s("rect", { x: 100, y, width: 1720, height: hgt, rx: 18, fill: color, stroke: "var(--line)", "stroke-width": 1.5 }));
      g.append(s("text", { x: 126, y: y + 34, fill: "var(--text-dim)", "font-size": 17, "letter-spacing": 2, text: label.toUpperCase() }));
      svg.append(g); return g;
    };
    const bMac = band(90, 200, "The owner's machines", "rgba(255,255,255,.015)");
    const bCf = band(320, 450, "Cloudflare", "rgba(95,224,143,.035)");
    const bNext = band(800, 110, "Open tasks, not live", "rgba(255,255,255,.01)");
    bNext.querySelector("rect").setAttribute("stroke-dasharray", "8 8");
    const box = (x, y, w, hh, title, sub, opts = {}) => {
      const b = pos(h("div", { class: "card", style: { padding: "14px 18px", height: hh + "px", borderColor: opts.color ?? "var(--observed-line)", borderStyle: opts.dashed ? "dashed" : "solid", background: opts.dashed ? "transparent" : "var(--surface-raised)" } },
        h("div", { style: { font: "600 24px/1.2 var(--font-sans)", color: "var(--text-bright)" } }, opts.live ? h("span", { style: { display: "inline-block", width: "11px", height: "11px", borderRadius: "50%", background: "var(--observed)", marginRight: "10px", boxShadow: "0 0 10px var(--observed)", verticalAlign: "2px" } }) : null, title),
        h("div", { class: "mono", style: { fontSize: "17px", color: "var(--text-muted)", marginTop: "6px", lineHeight: "1.35" }, html: sub })), x, y, w);
      el.append(b); return { el: b, x, y, w, h: hh };
    };
    const cli = box(150, 140, 420, 120, "atelier CLI", "the owner's one command;<br>runs checks in a clean clone", { color: "var(--line-bright)" });
    const runner = box(620, 140, 420, 120, "Home runner", "takes build, plan and review<br>jobs from the queue", { color: "var(--line-bright)" });
    const tools = pos(h("div", { class: "abs", style: { display: "flex", gap: "12px", flexWrap: "wrap", width: "680px" } },
      ...[["opencode", "zai"], ["claude", "anthropic"], ["codex", "openai"], ["antigravity", "google"]].map(([n, f]) => h("span", { class: "chip", style: { color: col(f) } }, h("span", { class: "dot" }), n))), 1100, 160);
    const toolsLbl = pos(h("div", { class: "abs mono dim", text: "each model's own command-line tool, in the task's workspace", style: { fontSize: "17px" } }), 1100, 236);
    el.append(tools, toolsLbl);
    const worker = box(700, 370, 520, 120, "Worker · atelier.zone", "the pages, the API and the gate;<br>a cron every five minutes", { live: true });
    const ledger = box(150, 540, 440, 100, "Durable Objects: Ledger", "one per project, SQLite storage;<br>one request at a time", { live: true });
    const index = box(620, 540, 470, 100, "Durable Object: index", "projects, model pool, agent<br>tokens, runners' offers", { live: true });
    const art = box(1120, 540, 650, 100, "Artifacts", "Git repositories: the baseline,<br>and a fork for every task", { live: true });
    const ae = box(150, 660, 440, 100, "Workers Analytics Engine", "metrics: dataset atelier_metrics", { live: true });
    const aig = box(620, 660, 470, 100, "AI Gateway", "logs of model calls, read by the Worker", { live: true });
    const logs = box(1120, 660, 650, 100, "Workers Logs", "what the Worker does, kept by Cloudflare", { live: true });
    const next = [["Access", "t270"], ["Workflows", "t280"], ["R2", "t284"], ["Browser Rendering", "t283"]].map(([n, id], i) => box(420 + i * 350, 826, 320, 66, n, `open task ${id}`, { dashed: true, color: "var(--line-bright)" }));
    const centre = (b, side) => side === "top" ? [b.x + b.w / 2, b.y] : [b.x + b.w / 2, b.y + b.h];
    const edge = (a, b) => {
      const [x1, y1] = centre(a, "bottom"), [x2, y2] = centre(b, "top");
      const p = s("path", { d: `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`, fill: "none", stroke: "var(--line-bright)", "stroke-width": 2.5 });
      const dot = s("circle", { r: 6, fill: "var(--signal)" });
      svg.append(p, dot);
      return { p, dot };
    };
    const E = {
      cli: edge(cli, worker), runner: edge(runner, worker),
      ledger: edge(worker, ledger), index: edge(worker, index), art: edge(worker, art),
    };
    // Lines from the worker's bottom to the lower row pass behind the upper row.
    return {
      el,
      update(t) {
        const show = (b, a) => fadeIn(b.el ?? b, P(t, a, 0.5), 12);
        bCf.style.opacity = P(t, c.cue(0), 0.5);
        show(worker, c.cue(0) + 0.6);
        show(ledger, c.cue(1) + 0.3); show(index, c.cue(1) + 3.2);
        show(art, c.cue(2) + 0.3); show(ae, c.cue(2) + 4.0); show(aig, c.cue(2) + 6.0); show(logs, c.cue(2) + 8.6);
        bMac.style.opacity = P(t, c.cue(3), 0.5);
        show(cli, c.cue(3) + 0.3); show(runner, c.cue(3) + 1.6); fadeIn(tools, P(t, c.cue(3) + 3.2, 0.5)); fadeIn(toolsLbl, P(t, c.cue(3) + 3.6, 0.5));
        bNext.style.opacity = P(t, c.cue(4), 0.5);
        next.forEach((b, i) => show(b, c.cue(4) + 0.4 + i * 0.4));
        const vis = { cli: c.cue(3) + 0.6, runner: c.cue(3) + 1.9, ledger: c.cue(1) + 0.6, index: c.cue(1) + 3.4, art: c.cue(2) + 0.6 };
        for (const [k, { p, dot }] of Object.entries(E)) {
          const k0 = P(t, vis[k], 0.5);
          p.style.opacity = k0;
          const L = p.__len ?? (p.__len = p.getTotalLength());
          const ph = ((t - vis[k]) / 1.8) % 1;
          const pt = p.getPointAtLength(L * (ph < 0 ? 0 : ph));
          dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y);
          dot.style.opacity = k0 * (t > vis[k] + 0.5 ? 0.9 : 0);
        }
      },
    };
  };

  SCENES.public = (c, data) => {
    const el = h("div");
    const a = browser("showcase", "atelier.zone<b>/showcase</b>", "public · captured from the live site");
    const b = browser("how", "atelier.zone<b>/how</b>", "public · captured from the live site");
    el.append(a.el, b.el);
    const sm = data.screens.showcase.marks, hm = data.screens.how.marks;
    return {
      el,
      update(t) {
        const tb = c.cue(1) - 0.2;
        a.el.style.opacity = P(t, 0, 0.5) * (1 - P(t, tb, 0.5));
        a.el.style.display = t < tb + 0.6 ? "block" : "none";
        a.pan(t, [[0, 0, 1], [1.2, 0, 1], [tb, sm["Task stories"].y - 160, 1]]);
        b.el.style.display = t >= tb ? "block" : "none";
        b.el.style.opacity = P(t, tb, 0.5);
        b.pan(t, [[tb, hm["The loop"].y - 60, 1], [c.dur, hm["The loop"].y + 120, 1]]);
      },
    };
  };

  SCENES.close = (c, data) => {
    const el = h("div");
    const th = threads(data, { y0: 1010, top: 740, opacity: 0.4 });
    el.append(th.el);
    const url = pos(h("div", { class: "abs display", text: "atelier.zone", style: { fontSize: "150px", width: "1920px", textAlign: "center", left: 0 } }), 0, 250);
    const repo = pos(h("div", { class: "abs mono", text: "github.com/pavithran/atelier · MIT licence", style: { fontSize: "40px", width: "1920px", textAlign: "center", color: "var(--signal)" } }), 0, 470);
    const t293 = pos(h("div", { class: "abs mono dim", text: `This film is task t293 in the atelier project's ledger · figures as of ${data.facts.cutoff.slice(0, 10)} ${data.facts.cutoff.slice(11, 16)} UTC`, style: { fontSize: "21px", width: "1920px", textAlign: "center" } }), 0, 580);
    el.append(url, repo, t293);
    return {
      el,
      update(t) {
        th.update(t);
        fadeIn(url, P(t, 0.3, 0.8));
        fadeIn(repo, P(t, c.cue(0) + 2.5, 0.8));
        fadeIn(t293, P(t, c.cue(1), 0.8));
      },
    };
  };

  // ── the player ──────────────────────────────────────────────────────────
  let TL = null, built = [], captions = [];
  const capEl = () => document.querySelector("#caption span");

  async function init(tl, data) {
    TL = tl;
    await document.fonts.load('800 60px "Bricolage Grotesque"');
    await document.fonts.load('700 60px "Bricolage Grotesque"');
    await document.fonts.load('400 20px "IBM Plex Sans"');
    await document.fonts.load('500 20px "IBM Plex Sans"');
    await document.fonts.load('600 20px "IBM Plex Sans"');
    await document.fonts.load('400 20px "IBM Plex Mono"');
    await document.fonts.load('500 20px "IBM Plex Mono"');
    await document.fonts.ready;
    const root = document.getElementById("scenes");
    tl.scenes.forEach((sc, i) => {
      const make = SCENES[sc.id];
      if (!make) throw new Error("no scene " + sc.id);
      const ctx = { cue: (k) => sc.cues[Math.min(k, sc.cues.length - 1)].start, cueEnd: (k) => sc.cues[Math.min(k, sc.cues.length - 1)].end, dur: sc.dur };
      const wrap = h("div", { class: "scene" });
      root.append(wrap);
      wrap.classList.add("on");
      const scene = make(ctx, data);
      wrap.append(scene.el);
      wrap.classList.remove("on");
      built.push({ sc, wrap, scene, n: i + 1 });
      for (const cue of sc.cues) for (const k of cue.captions) captions.push({ start: sc.start + k.start, end: sc.start + k.end, text: k.text });
    });
    await Promise.all([...document.images].map((im) => im.decode().catch(() => { throw new Error("image failed: " + im.src); })));
  }

  function seek(T) {
    let cur = built.find((b) => T >= b.sc.start && T < b.sc.start + b.sc.dur) ?? built[built.length - 1];
    for (const b of built) b.wrap.classList.toggle("on", b === cur);
    const t = T - cur.sc.start;
    cur.wrap.classList.add("on");
    cur.scene.update(t);
    const FADE = 0.45;
    const edge = Math.min(t / FADE, (cur.sc.dur - t) / FADE);
    document.getElementById("fade").style.opacity = clamp(1 - edge);
    const ch = document.getElementById("chapter");
    ch.innerHTML = cur.sc.id === "open" || cur.sc.id === "close" ? "" : `<b>${String(cur.n).padStart(2, "0")}</b>${esc(cur.sc.title)}`;
    ch.style.opacity = P(t, 0.3, 0.6);
    const cap = captions.find((k) => T >= k.start && T < k.end + 0.25);
    capEl().textContent = cap ? cap.text : "";
  }

  window.film = { init, seek };
})();
