// What the design capture measures in the browser on each page (t499), as
// functions Playwright runs in the page. Each returns plain data; capture.ts
// writes it to docs/design/audit.json, and docs/design/critique.md reads it.
// These are measurements toward WCAG 2.2 AA, not a conformance claim: they
// find text below its contrast ratio, focus stops with no visible indicator,
// targets under 24 px and content that overflows 320 CSS px, and no more.

// Text contrast (1.4.3): every visible element that holds text of its own,
// its colour against the backgrounds behind it composited to an opaque one.
// A background image or gradient on the way up is reported as unknown.
export function contrastInPage() {
  type RGBA = { r: number; g: number; b: number; a: number };
  const parse = (c: string): RGBA | null => {
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = c.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top.a + under.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t: number, u: number) => (t * top.a + u * under.a * (1 - top.a)) / a;
    return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
  };
  const lum = (c: RGBA) => {
    const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c: RGBA) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const canvas: RGBA = dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const backdrop = (el: Element): RGBA | "image" => {
    const layers: RGBA[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return "image";
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let out = canvas;
    for (const l of layers.reverse()) out = over(l, out);
    return out;
  };
  const describe = (el: Element) => {
    const parts: string[] = [];
    for (let n: Element | null = el; n && parts.length < 4 && n !== document.body; n = n.parentElement) {
      parts.unshift(n.tagName.toLowerCase() + (n.id ? `#${n.id}` : "") + (n.classList.length ? `.${[...n.classList].slice(0, 2).join(".")}` : ""));
    }
    return parts.join(" > ");
  };
  let checked = 0, unknown = 0;
  const failures = new Map<string, { selector: string; text: string; ratio: number; need: number; fg: string; bg: string; size: number; count: number }>();
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim().length > 0);
    if (!own) continue;
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (s.visibility === "hidden" || s.display === "none" || rect.width === 0 || rect.height === 0) continue;
    if (el.closest("[aria-hidden=true]") || el.closest(".skip")) continue;
    let alpha = 1;
    for (let n: Element | null = el; n; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity);
    const svg = el instanceof SVGElement;
    const fg0 = parse(svg ? s.fill : s.color);
    if (!fg0) { unknown++; continue; }
    const bg = backdrop(el);
    if (bg === "image") { unknown++; continue; }
    const fg = over({ ...fg0, a: fg0.a * alpha }, bg);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    checked++;
    if (r + 0.005 < need) {
      const key = `${hex(fg)} ${hex(bg)} ${need}`;
      const prior = failures.get(key);
      if (prior) prior.count++;
      else failures.set(key, { selector: describe(el), text: (el.textContent ?? "").trim().slice(0, 60), ratio: Math.round(r * 100) / 100, need, fg: hex(fg), bg: hex(bg), size, count: 1 });
    }
  }
  return { scheme: dark ? "dark" : "light", checked, unknown, failures: [...failures.values()].sort((a, b) => a.ratio - b.ratio) };
}

// One focus stop: what holds focus after a Tab, whether it draws an
// indicator (2.4.7), whether it is on screen (2.4.11, roughly), its size.
export function focusStopInPage() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1;
  const ring = s.boxShadow !== "none";
  return {
    tag: el.tagName.toLowerCase(),
    label: ((el as HTMLElement).innerText || el.getAttribute("aria-label") || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 50),
    href: el.getAttribute("href"),
    indicator: outline ? `outline ${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}` : ring ? `box-shadow ${s.boxShadow}` : null,
    onScreen: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    width: Math.round(r.width), height: Math.round(r.height),
  };
}

// Target size (2.5.8): interactive elements under 24 by 24 CSS px, leaving
// out links inside a run of text, which the criterion excepts.
export function targetsInPage() {
  const small: { tag: string; label: string; width: number; height: number }[] = [];
  let total = 0;
  for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary")) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === "hidden") continue;
    total++;
    const inline = s.display === "inline" && [...(el.parentElement?.childNodes ?? [])].some((n) => n.nodeType === 3 && n.textContent!.trim().length > 0);
    if (!inline && (r.width < 24 || r.height < 24)) small.push({ tag: el.tagName.toLowerCase(), label: ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40), width: Math.round(r.width), height: Math.round(r.height) });
  }
  return { total, small: small.slice(0, 30), smallCount: small.length };
}

// Reflow (1.4.10): at 320 CSS px, the page's width, and the elements that
// reach past it outside any box that scrolls sideways on purpose.
export function reflowInPage() {
  const width = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  const offenders: { selector: string; right: number }[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.right <= width + 1 || r.width === 0) continue;
    let scrolls = false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") { scrolls = true; break; }
    }
    if (scrolls) continue;
    // Only the outermost offender of a branch.
    if (offenders.some((o) => el.parentElement && document.querySelector(o.selector)?.contains(el))) continue;
    const sel = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.classList.length ? `.${[...el.classList].join(".")}` : "");
    offenders.push({ selector: sel, right: Math.round(r.right) });
    if (offenders.length >= 15) break;
  }
  return { width, scrollWidth, overflows: scrollWidth > width + 1, offenders };
}

// The page's structure: its height, its landmarks and headings, how many
// navigations it carries and what they hold.
export function structureInPage() {
  const navs = [...document.querySelectorAll("nav")].map((n) => ({ label: n.getAttribute("aria-label"), links: [...n.querySelectorAll("a")].map((a) => a.textContent!.trim()).filter(Boolean) }));
  const headings = [...document.querySelectorAll("h1, h2")].map((h) => `${h.tagName.toLowerCase()} ${h.textContent!.trim().replace(/\s+/g, " ").slice(0, 60)}`);
  const words = (document.querySelector("main")?.textContent ?? "").split(/\s+/).filter(Boolean).length;
  return { height: document.documentElement.scrollHeight, navs, h1: document.querySelectorAll("h1").length, headings: headings.slice(0, 25), words };
}
