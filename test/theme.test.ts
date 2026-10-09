import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Palette B (t367): near-black ground, warm-white text, a muted grey that
// still reads, electric blue as the one accent, red for failures only and
// green for an observed pass only. These tests read the stylesheets the
// pages inline and hold them to that: every text colour meets WCAG AA on
// every surface it can sit on, in dark and in light, and no other hue (the
// old copper and brown among them) is left outside the agents' chart colours.

const theme = readFileSync("src/theme.css", "utf8");
const layout = readFileSync("src/layout.css", "utf8");
const how = readFileSync("src/how.css", "utf8");

type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB;
};
const luminance = ([r, g, b]: RGB) => {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
// Hue in degrees, and chroma as a share of the full range: a colour with
// little chroma is a grey whatever its hue says.
const hue = (hex: string) => {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const chroma = (hex: string) => { const c = rgb(hex); return (Math.max(...c) - Math.min(...c)) / 255; };
const NEUTRAL = 0.08;

// The tokens of one block: `--name: #hex`.
const tokens = (block: string) => new Map([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]));
const dark = tokens(theme.slice(theme.indexOf(":root {"), theme.indexOf("@media")));
const lightStart = theme.indexOf("@media (prefers-color-scheme: light)");
const light = tokens(theme.slice(lightStart, theme.indexOf("\n}\n", lightStart)));

test("the theme has palette B and nothing else: one dark set and its light counterpart", () => {
  assert.doesNotMatch(theme, /data-theme=/, "a second named theme is left in theme.css");
  assert.equal(dark.get("surface"), "#0a0a0f");
  assert.equal(dark.get("shell"), "#0a0a0f");
  assert.equal(dark.get("text"), "#ececf2");
  assert.equal(dark.get("signal"), "#4d8bff");
  assert.equal(dark.get("music-accent"), "#4d8bff");
  // Panels are raised from the ground, a little.
  for (const t of ["surface-raised", "inset"]) assert.ok(luminance(rgb(dark.get(t)!)) > luminance(rgb("#0a0a0f")), `${t} is not raised`);
  assert.ok(light.size > 20, "the light theme is missing");
});

for (const [name, set] of [["dark", dark], ["light", light]] as const) {
  test(`every text colour meets WCAG AA on every surface, ${name}`, () => {
    const grounds = ["shell", "surface", "surface-raised", "inset"];
    const inks = ["text", "text-bright", "text-muted", "text-dim", "signal", "signal-hot", "signal-bright", "caution", "observed", "fault"];
    for (const ground of grounds) for (const ink of inks) {
      const ratio = contrast(set.get(ink)!, set.get(ground)!);
      assert.ok(ratio >= 4.5, `${name}: --${ink} ${set.get(ink)} on --${ground} ${set.get(ground)} is ${ratio.toFixed(2)}:1, under 4.5`);
    }
    // A primary button's label on the accent.
    const onAccent = contrast(set.get("on-accent")!, set.get("signal")!);
    assert.ok(onAccent >= 4.5, `${name}: --on-accent on --signal is ${onAccent.toFixed(2)}:1`);
  });

  test(`blue is the one accent, red only for failures and green only for a pass, ${name}`, () => {
    for (const [token, hex] of set) {
      if (chroma(hex) < NEUTRAL) continue;
      const h = hue(hex);
      if (token.startsWith("fault")) assert.ok(h >= 345 || h <= 10, `--${token} ${hex} is not red`);
      else if (token.startsWith("observed")) assert.ok(h >= 120 && h <= 160, `--${token} ${hex} is not green`);
      else assert.ok(h >= 205 && h <= 230, `--${token} ${hex} (hue ${Math.round(h)}) is not the accent's blue`);
    }
  });
}

// A status tag paints a translucent tint of its ink (layout.css: .tag.go and
// its siblings) over whatever row it sits in, an inset or hovered row
// included, so its text is measured against the composited colour.
const TAGS = [...layout.matchAll(/\.tag\.([a-z]+)\s*\{\s*color:\s*var\(--([a-z-]+)\);\s*background:\s*rgba\(var\(--([a-z-]+)-rgb\),\s*([.\d]+)\)/g)]
  .map((m) => ({ name: m[1], ink: m[2], tint: m[3], alpha: Number(m[4]) }));
const over = (tint: string, alpha: number, ground: string) => {
  const [a, b] = [rgb(tint), rgb(ground)];
  return "#" + a.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("");
};

for (const [name, set] of [["dark", dark], ["light", light]] as const) {
  test(`every status tag meets WCAG AA over every row it sits in, ${name}`, () => {
    assert.ok(TAGS.length >= 4, "the status tags were not found in layout.css");
    for (const tag of TAGS) for (const ground of ["shell", "surface", "surface-raised", "inset"]) {
      const bg = over(set.get(tag.tint)!, tag.alpha, set.get(ground)!);
      const ratio = contrast(set.get(tag.ink)!, bg);
      assert.ok(ratio >= 4.5, `${name}: .tag.${tag.name} on --${ground} is ${ratio.toFixed(2)}:1, under 4.5`);
    }
  });
}

// Every rule in layout.css and how.css that fades, tints or paints in a
// company colour is either text measured here, composited over each surface
// in both themes, or a shape that carries no text. A new rule of the kind
// that is neither fails until it is measured.
const css = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
// A selector list split on its own commas, not those inside :not() or :has().
const selectors = (list: string) => {
  const out = [""];
  let depth = 0;
  for (const ch of list) {
    if (ch === "," && depth === 0) { out.push(""); continue; }
    depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    out[out.length - 1] += ch;
  }
  return out.map((s) => s.trim());
};
const rules = [layout, how].flatMap((s) => [...css(s).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap(([, sel, body]) => selectors(sel).map((x) => ({ sel: x, body }))));
const rule = (sel: string) => {
  const r = rules.find((x) => x.sel === sel);
  assert.ok(r, `${sel} is not in the page styles`);
  return r.body;
};
const opacityOf = (sel: string) => Number(/(?:^|;)\s*opacity:\s*([.\d]+)/.exec(rule(sel))?.[1] ?? 1);
const percentOf = (sel: string) => Number(/color-mix\(in srgb, var\(--c[^)]*\)\)? (\d+)%/.exec(rule(sel))![1]) / 100;

// The company colours, and the main line, as each theme resolves them.
const layoutTokens = (block: string) => new Map([...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const layoutDark = layoutTokens(layout.slice(0, layout.indexOf("@media (prefers-color-scheme: light)")));
const layoutLight = new Map([...layoutDark, ...layoutTokens(layout.slice(layout.indexOf("@media (prefers-color-scheme: light)"), layout.indexOf("\n}\n", layout.indexOf("@media (prefers-color-scheme: light)"))))]);
const resolve = (value: string, own: Map<string, string>, set: Map<string, string>): string => {
  const ref = /^var\(--([a-z-]+)\)$/.exec(value);
  if (!ref) return value.toLowerCase();
  return own.has(ref[1]) ? resolve(own.get(ref[1])!, own, set) : set.get(ref[1])!;
};
const THEMES = [["dark", dark, layoutDark], ["light", light, layoutLight]] as const;
const companies = (own: Map<string, string>, set: Map<string, string>) =>
  [...own].filter(([k]) => k.startsWith("m-") || k === "main-line").map(([k, v]) => [k, resolve(v, own, set)] as const);
const GROUNDS = ["shell", "surface", "surface-raised", "inset"];

// Text the page styles fade, tint or colour, and what it sits on. Each entry
// gives the pairs to measure in one theme: a label, the ink as painted (its
// opacity applied over the ground) and the ground.
type Pair = [string, string, string];
type Theme = { set: Map<string, string>; own: Map<string, string>; grounds: string[] };
const at = (ink: string, alpha: number, ground: string): Pair => [`${ink} at ${alpha}`, over(ink, alpha, ground), ground];
// A translucent fill names its colour by the `--name-rgb` triple.
const triple = (t: Theme, token: string) => {
  const block = t.set === dark ? theme.slice(theme.indexOf(":root {"), lightStart) : theme.slice(lightStart, theme.indexOf("\n}\n", lightStart));
  const m = new RegExp(`--${token}-rgb:\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)`).exec(block);
  assert.ok(m, `--${token}-rgb is not in the theme`);
  return "#" + m.slice(1).map((c) => Number(c).toString(16).padStart(2, "0")).join("");
};
const tinted = (t: Theme, token: string, alpha: number) => t.grounds.map((g) => over(triple(t, token), alpha, g));
const inks = (t: Theme, names: string[], grounds: string[]) => names.flatMap((n) => grounds.map((g): Pair => [`--${n}`, t.set.get(n)!, g]));
const companyText = (t: Theme, alpha: number, spans = false) => companies(t.own, t.set).flatMap(([k, c]) =>
  [...t.grounds, ...(spans ? [percentOf(".span-past"), percentOf(".span-now")].flatMap((a) => t.grounds.map((g) => over(c, a, g))) : [])]
    .map((g): Pair => { const p = at(c, alpha, g); return [`--${k} ${p[0]}`, p[1], g]; }));
const tintRule = (sel: string) => /background:\s*rgba\(var\(--([a-z-]+)-rgb\),\s*([.\d]+)\)/.exec(rule(sel))!;
const bandRule = (sel: string) => /fill:\s*rgba\(var\(--([a-z-]+)-rgb\),\s*([.\d]+)\)/.exec(rule(sel))!;
const onTint = (t: Theme, sel: string, names: string[]) => { const [, token, a] = tintRule(sel); return inks(t, names, tinted(t, token, Number(a))); };
const onBand = (t: Theme, sel: string) => { const [, token, a] = bandRule(sel); return inks(t, ["text-muted", "text", "text-bright"], tinted(t, token, Number(a))); };

const TEXT: Record<string, (t: Theme) => Pair[]> = {
  // The Studio's holder labels sit on the holder's band, past and current.
  ".span-label": (t) => companyText(t, opacityOf(".span-label"), true),
  ".span-label.now": (t) => companyText(t, opacityOf(".span-label.now"), true),
  // A graph card's head in its holder's colour, on the card.
  ".graph text.g-card-head": (t) => companyText(t, 1),
  ".g-name.main-name": (t) => companyText(t, 1).filter(([l]) => l.startsWith("--main-line")),
  ".g-sha": (t) => companyText(t, 1).filter(([l]) => l.startsWith("--main-line")),
  // The replay button: the accent's label colour on the main line's.
  ".stage-head a.replay": (t) => [["--on-accent", t.set.get("on-accent")!, resolve("var(--main-line)", t.own, t.set)]],
  ".flow-hero h1 .you": (t) => inks(t, ["signal"], t.grounds),
  ".tally .you dd": (t) => inks(t, ["signal"], t.grounds),
  ".resting-graph h2 .you": (t) => inks(t, ["signal"], t.grounds),
  ".moments li.catch p": (t) => {
    const amount = Number(/var\(--fault\) (\d+)%/.exec(rule(".moments li.catch p"))![1]) / 100;
    return t.grounds.map((g) => ["fault mixed into text", over(t.set.get("fault")!, amount, t.set.get("text")!), g]);
  },
  ".tag.go": (t) => onTint(t, ".tag.go", ["observed"]),
  ".tag.ask": (t) => onTint(t, ".tag.ask", ["caution"]),
  ".tag.bad": (t) => onTint(t, ".tag.bad", ["fault"]),
  ".tag.signal": (t) => onTint(t, ".tag.signal", ["signal-hot"]),
  ".diff .add": (t) => onTint(t, ".diff .add", ["text"]),
  ".diff .del": (t) => onTint(t, ".diff .del", ["text"]),
  // The current step: its verb, its line and its number.
  ".task-steps li.current": (t) => onTint(t, ".task-steps li.current", ["text-bright", "signal-hot", "text-muted"]),
  // Lanes and bands the How diagrams lay their labels on.
  ".hw-lane": (t) => onBand(t, ".hw-lane"),
  ".hw-lane-rec": (t) => onBand(t, ".hw-lane-rec"),
  ".lay-band": (t) => onBand(t, ".lay-band"),
  ".lay-band-cloud": (t) => onBand(t, ".lay-band-cloud"),
  ".pf-lane": (t) => onBand(t, ".pf-lane"),
  ".pf-lane-atelier": (t) => onBand(t, ".pf-lane-atelier"),
  // The sign-in form's translucent sheet over the dimmed showcase graph:
  // the brightest thread behind it, at the backdrop's opacity.
  ".login.over-graph .login-form": (t) => {
    const sheet = Number(/var\(--page\) (\d+)%/.exec(rule(".login.over-graph .login-form"))![1]) / 100;
    const page = t.set.get("surface")!;
    const behind = companies(t.own, t.set).map(([, c]) => over(over(c, opacityOf(".login-backdrop"), page), 1 - sheet, page));
    return inks(t, ["text", "text-muted", "text-dim"], behind);
  },
};
// Rules that fade or colour shapes only; none of them selects text.
const SHAPES: Record<string, string> = {
  ".span-past": "the past holder's band; its label is measured over it",
  ".span-now": "the current holder's band; its label is measured over it",
  ".login-backdrop": "the showcase graph dimmed behind sign-in, aria-hidden decoration",
  ".g-card": "a hidden card, shown at full opacity",
  ".graph:has(.g-task:hover) .g-task:not(:hover) > :not(text, a)": "the other tasks' threads and marks; their labels stay at full opacity",
  ".graph:has(.g-task:focus-within) .g-task:not(:focus-within) > :not(text, a)": "the other tasks' threads and marks; their labels stay at full opacity",
  ".g-main": "the main line", ".g-thread": "a thread", ".g-lane": "a lane's thread",
  ".g-task.closed .g-thread": "a closed thread", ".g-task.closed .g-bead": "a closed task's marks", ".g-task.closed .g-cap": "a closed thread's cap",
  ".g-head": "a thread's head", ".g-head.local": "a local run's head", ".g-bead.local > :not(.hit)": "a local run's mark",
  ".g-merge": "a merge dot", ".g-card rect": "a card's frame", ".g-bead.approve path": "an approval mark", ".g-bead.reject path": "a rejection mark",
  ".g-bead.handoff path": "a handoff mark", ".g-bead.accept circle": "an acceptance mark", ".g-edge > path": "a review edge", ".g-edge g path": "a review edge's mark",
  ".tally-bar span": "a tally bar", ".legend-line i": "a legend swatch", ".moments .dot": "a moment's dot",
  ".project-card.has-waiting": "a card's border", ".family-mark": "a family dot",
  "from": "keyframes arrive, ending at full opacity", "to": "keyframes arrive, ending at full opacity",
  "50%": "keyframes breathe, on a pulsing dot", "0%": "keyframes breathe, on a pulsing dot", "100%": "keyframes breathe, on a pulsing dot",
};
const FADED = /(?:^|;)\s*opacity:\s*(?!1\b)[.\d]|rgba\(|color-mix\(|var\(--c\b|var\(--m-|var\(--main-line\)/;
// The classes drawn as SVG text in the sources, so a shape rule naming one is caught.
const TEXT_CLASSES = new Set(readdirSync("src").filter((f) => f.endsWith(".ts")).flatMap((f) =>
  [...readFileSync(`src/${f}`, "utf8").matchAll(/<(?:text|tspan)\b[^>]*class="([^"$]+)/g)].flatMap((m) => m[1].split(/\s+/))));

test("every faded, tinted or company-coloured rule is measured text or a shape without text", () => {
  for (const { sel, body } of rules) {
    if (!FADED.test(body)) continue;
    assert.ok(sel in TEXT || sel in SHAPES, `${sel} fades or colours something that is not measured: { ${body.trim()} }`);
  }
  for (const sel of Object.keys(SHAPES)) {
    // What a selector excludes, :not(text, a) among it, is not what it selects.
    const selected = sel.replace(/:not\([^)]*\)/g, "");
    assert.doesNotMatch(selected, /\btext\b|tspan/, `${sel} is listed as a shape but selects text`);
    for (const c of selected.match(/\.[a-z][\w-]*/g) ?? []) assert.ok(!TEXT_CLASSES.has(c.slice(1)), `${sel} is listed as a shape but ${c} is drawn as text`);
  }
  assert.match(readFileSync("src/ui.ts", "utf8"), /class="login-backdrop" aria-hidden="true"/);
  assert.match(rule(".g-card"), /visibility: hidden/);
  // Only dots breathe.
  for (const { sel, body } of rules) if (/animation:[^;]*\bbreathe\b/.test(body)) assert.match(sel, /\.pulse$|\.g-head$/, `${sel} breathes`);
});

for (const [name, set, own] of THEMES) {
  test(`every faded, tinted or company-coloured text meets WCAG AA over every surface it sits on, ${name}`, () => {
    const t: Theme = { set, own, grounds: GROUNDS.map((g) => set.get(g)!) };
    // The graph's task labels take their holder's colour inline (src/graph.ts).
    const pairs: [string, Pair][] = [...Object.entries(TEXT).flatMap(([sel, f]) => f(t).map((p) => [sel, p] as [string, Pair])),
      ...companyText(t, 1).map((p) => [".g-name, inline", p] as [string, Pair])];
    const failing = pairs.filter(([, [, ink, ground]]) => contrast(ink, ground) < 4.5)
      .map(([sel, [label, ink, ground]]) => `${sel}: ${label} (${ink}) on ${ground} is ${contrast(ink, ground).toFixed(2)}:1`);
    assert.deepEqual(failing, [], `${name}: text under 4.5:1`);
  });
}

test("company colours are painted only inside charts and their legends", () => {
  // Every rule that paints with --c (the company colour a chart sets) or a
  // --m-<family> token, other than the owner's, which is the accent.
  const CHARTS = /^(\.span-(past|now|label)|\.tally-bar|\.legend-line|\.(graph|track-svg) |\.g-|\.moments \.dot$)/;
  for (const [file, css] of [["src/layout.css", layout], ["src/how.css", how]] as const) {
    for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/var\(--c\b|var\(--m-(?!owner)/.test(body)) continue;
      for (const sel of selectors.split(",").map((s) => s.trim()))
        assert.match(sel, CHARTS, `${file}: ${sel} paints a company colour outside a chart`);
    }
  }
});

test("no copper or brown is left in the page styles; only the agents' chart colours carry another hue", () => {
  for (const [file, css] of [["src/theme.css", theme], ["src/layout.css", layout], ["src/how.css", how]] as const) {
    for (const line of css.split("\n")) {
      // One colour per family of agent, drawn inside charts and their legends.
      if (/^\s*--m-[a-z]+:/.test(line)) continue;
      for (const [hex] of line.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
        const h = hue(hex);
        assert.ok(!(chroma(hex) >= NEUTRAL && h >= 15 && h <= 50), `${file}: ${hex} is copper or brown: ${line.trim()}`);
        if (file !== "src/theme.css") assert.ok(chroma(hex) < NEUTRAL, `${file}: ${hex} sets a colour outside the theme: ${line.trim()}`);
      }
    }
  }
});
