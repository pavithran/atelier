import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
