// The live script and the policy that admits it. Every page reads fully
// without script; this one only refreshes and animates. It is served at
// /live.js, first party, and a page that carries it names a nonce made for
// that request in its policy and on the script tag, so no other script, inline
// or from elsewhere, runs. A page without a nonce keeps the policy that
// forbids script altogether.

// Eighteen random bytes as base64: 24 characters, new for every request.
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
}

// The content security policy of a page: with a nonce, only the script that
// carries it, and connections back to this origin for the refresh.
export function csp(nonce?: string): string {
  const script = nonce ? `script-src 'nonce-${nonce}'; connect-src 'self'; ` : "";
  return `default-src 'none'; ${script}style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'`;
}

export const LIVE_SCRIPT_TYPE = "text/javascript; charset=utf-8";

// ── the revision rule ──────────────────────────────────────────────────────
// Every action is a form post bound to the revision on screen (DESIGN.md).
// A refresh must keep that true: a push while a task is in review moves its
// head and leaves it submitted, and a copy fetched after that binds its
// forms to the new head, which the owner has not read. So a fetched copy
// may replace the page only while the revisions its forms bind to are the
// ones the page already shows, none moved, none new, none gone; anything
// else is stale. These functions decide that from the HTML, and they are
// written in plain JavaScript because their source is also part of the
// script the browser runs, and the tests call them as they are.

// The revisions a page's forms bind to: the value of every hidden input
// named head, in order. A page with no decision forms has none.
export function headsIn(html: string): string[] {
  const out: string[] = [];
  const re = /<input[^>]*\bname="head"[^>]*\bvalue="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// What a refresh does with a fetched copy: the forms bind to the same
// revisions and the owner is free to see it (swap); the revisions are the
// same but the owner is mid-something (hold: the copy waits and the page
// keeps refreshing); or the copy binds a form to a revision the page does
// not show, or drops a form it had (stale: what is on screen is no longer
// what the owner read). The values matter, not their order: a page may
// reorder its forms without moving a revision. Stale wins over hold, so the
// owner hears about a new revision even while typing.
export type Refresh = "swap" | "hold" | "stale";
export function decideRefresh(current: string[], fetched: string[], dirty: boolean): Refresh {
  const shown = [...current].sort();
  const wanted = [...fetched].sort();
  if (shown.length !== wanted.length) return "stale";
  for (let i = 0; i < shown.length; i++) if (shown[i] !== wanted[i]) return "stale";
  return dirty ? "hold" : "swap";
}

// What the script does, in two parts.
//
// Refresh: on a page whose <main> carries data-live-refresh, the same page
// is fetched again every so many seconds, whatever the owner is doing, so a
// new revision is heard about even mid-form. The fetched copy is compared
// with the last copy the server sent, never with what this script has
// drawn on top of the page, so its own additions (a revealed note, a
// scrubber) never read as a change. A copy that differs goes to
// decideRefresh (above): it replaces <main> when the forms still bind to
// the revisions shown and the owner is not mid-something (a control
// focused, a field changed, text selected, a scrubber away from its end);
// it waits when the owner is; and when the copy binds a form to a revision
// the page does not show, or drops one it had, it is never swapped in: the
// page says a new revision arrived, with a link that reloads, and stops
// refreshing. Swaps keep open disclosures open and the scroll position, and
// marks that were not on the page before arrive with the pop animation, so
// the graph never redraws itself whole. A response that lands on another
// page (the session ended) reloads the page.
//
// Scrubber: under every graph that carries positions (data-pos on its marks,
// data-from and data-to on its thread segments), a range input with Previous,
// Next and Play steps through the recorded events in order, drawing the
// picture as it stood after each one and saying which event that was.
export const LIVE_SCRIPT = `${headsIn.toString()}
${decideRefresh.toString()}
(() => {
  "use strict";
  var main = document.getElementById("main");
  if (!main) return;
  // The copy as the server sent it, before this script touches the page:
  // what a fetched copy is compared with, so the script's own additions
  // never count as a change.
  var last = main.innerHTML;
  var num = function (el, name) { return Number(el.getAttribute(name)); };
  var text = function (s) { return (s || "").replace(/\\s+/g, " ").trim(); };

  function button(label) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    return b;
  }

  // The caption of a step: what the marks at that position say about themselves.
  function caption(marks, pos) {
    var said = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (num(m, "data-pos") !== pos) continue;
      var s = m.getAttribute("data-say") || m.getAttribute("aria-label");
      if (!s) { var t = m.querySelector("title"); s = t ? t.textContent : ""; }
      if (s && said.indexOf(text(s)) === -1) said.push(text(s));
    }
    return said.join("; ");
  }

  function scrubber(graph) {
    if (graph.dataset.scrubbed || graph.closest(".login-backdrop")) return;
    var marks = Array.prototype.slice.call(graph.querySelectorAll("[data-pos]"));
    var segs = Array.prototype.slice.call(graph.querySelectorAll("[data-from]"));
    if (!marks.length) return;
    graph.dataset.scrubbed = "1";
    var steps = [];
    for (var i = 0; i < marks.length; i++) { var p = num(marks[i], "data-pos"); if (steps.indexOf(p) === -1) steps.push(p); }
    steps.sort(function (a, b) { return a - b; });
    var last = steps.length - 1;
    var box = document.createElement("div");
    box.className = "scrubber";
    var prev = button("Previous"), next = button("Next"), play = button("Play");
    var range = document.createElement("input");
    range.type = "range"; range.min = "0"; range.max = String(last); range.value = String(last); range.step = "1";
    range.setAttribute("aria-label", "Step through the recorded events");
    var out = document.createElement("output");
    out.setAttribute("aria-live", "polite");
    box.appendChild(prev); box.appendChild(range); box.appendChild(next); box.appendChild(play); box.appendChild(out);
    var holder = graph.closest(".stage-scroll") || graph;
    holder.parentNode.insertBefore(box, holder.nextSibling);
    var timer = null;
    var at = last;

    function show(i) {
      at = Math.max(0, Math.min(last, i));
      range.value = String(at);
      var pos = steps[at];
      graph.classList.add("scrub");
      graph.classList.toggle("scrub-end", at === last);
      for (var k = 0; k < marks.length; k++) marks[k].style.visibility = num(marks[k], "data-pos") <= pos + 1e-9 ? "" : "hidden";
      for (var j = 0; j < segs.length; j++) {
        var s = segs[j], a = num(s, "data-from"), b = num(s, "data-to");
        if (pos < a - 1e-9) { s.style.visibility = "hidden"; continue; }
        s.style.visibility = "";
        if (s.classList.contains("draw")) {
          var f = b <= a ? 1 : Math.min(1, (pos - a) / (b - a));
          s.style.strokeDashoffset = String(1 - f);
        }
      }
      prev.disabled = at === 0;
      next.disabled = at === last;
      out.textContent = "Step " + (at + 1) + " of " + steps.length + ": " + caption(marks, pos);
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } play.textContent = "Play"; }
    range.addEventListener("input", function () { stop(); show(Number(range.value)); });
    prev.addEventListener("click", function () { stop(); show(at - 1); });
    next.addEventListener("click", function () { stop(); show(at + 1); });
    play.addEventListener("click", function () {
      if (timer) { stop(); return; }
      if (at === last) show(0);
      play.textContent = "Pause";
      timer = setInterval(function () { if (at >= last) { stop(); return; } show(at + 1); }, 700);
    });
    out.textContent = "All " + steps.length + " steps drawn; step back to replay them.";
  }

  function scrubbers() {
    var graphs = main.querySelectorAll(".graph:not(.mini)");
    for (var i = 0; i < graphs.length; i++) scrubber(graphs[i]);
  }

  // The live note sits in the rail's foot, outside <main>, so nothing sits
  // between the page's header and its H1 (finding 11); it is looked for
  // anywhere in the document.
  var note = function () { var n = document.querySelector(".live-note:not(.stale)"); if (n) n.hidden = false; };

  // ── refresh ──
  var every = Number(main.getAttribute("data-live-refresh") || 0);
  if (every > 0) {
    var busy = false;
    var ticker = null;
    function dirty() {
      var a = document.activeElement;
      if (a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(a.tagName)) return true;
      var fields = main.querySelectorAll("input, textarea, select");
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.closest(".scrubber") || f.type === "hidden") continue;
        if (f.tagName === "SELECT") { var d = 0; for (var k = 0; k < f.options.length; k++) if (f.options[k].defaultSelected) d = k; if (f.selectedIndex !== d) return true; }
        else if (f.value !== f.defaultValue) return true;
      }
      if (main.querySelector(".graph.scrub:not(.scrub-end)")) return true;
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.anchorNode && main.contains(sel.anchorNode)) return true;
      return false;
    }
    // The fetched copy binds a form to a revision this page does not show,
    // or drops a form it had: the page keeps what it shows, says so with a
    // link that reloads it, and stops refreshing.
    function stale() {
      if (ticker) { clearInterval(ticker); ticker = null; }
      var n = document.querySelector(".live-note:not(.stale)");
      if (n) n.hidden = true;
      var p = document.createElement("p");
      p.className = "meta live-note stale";
      p.setAttribute("role", "status");
      p.appendChild(document.createTextNode("A new revision arrived. "));
      var a = document.createElement("a");
      a.href = window.location.href;
      a.textContent = "Reload to review it";
      p.appendChild(a);
      p.appendChild(document.createTextNode("."));
      main.insertBefore(p, main.firstChild);
    }
    function swap(fresh) {
      var had = {};
      var keys = main.querySelectorAll("[data-ev]");
      for (var i = 0; i < keys.length; i++) had[keys[i].getAttribute("data-ev")] = true;
      var open = {};
      var sums = main.querySelectorAll("details[open] > summary");
      for (var j = 0; j < sums.length; j++) open[text(sums[j].textContent)] = true;
      var y = window.scrollY;
      while (main.firstChild) main.removeChild(main.firstChild);
      while (fresh.firstChild) main.appendChild(fresh.firstChild);
      var details = main.querySelectorAll("details");
      for (var k = 0; k < details.length; k++) {
        var s = details[k].querySelector(":scope > summary");
        if (s && open[text(s.textContent)]) details[k].open = true;
      }
      var graphs = main.querySelectorAll(".graph");
      for (var g = 0; g < graphs.length; g++) {
        graphs[g].classList.add("settled");
        var marks = graphs[g].querySelectorAll("[data-ev]");
        for (var m = 0; m < marks.length; m++) if (!had[marks[m].getAttribute("data-ev")]) marks[m].classList.add("fresh");
      }
      window.scrollTo(0, y);
      note();
      scrubbers();
    }
    function tick() {
      if (busy || document.hidden) return;
      busy = true;
      fetch(window.location.href, { credentials: "same-origin", cache: "no-store", headers: { accept: "text/html" } }).then(function (res) {
        if (!res.ok) return null;
        if (new URL(res.url).pathname !== window.location.pathname) { window.location.reload(); return null; }
        return res.text();
      }).then(function (html) {
        if (html === null) return;
        var doc = new DOMParser().parseFromString(html, "text/html");
        var fresh = doc.getElementById("main");
        if (!fresh) return;
        var copy = fresh.innerHTML;
        if (copy === last) return;
        var what = decideRefresh(headsIn(last), headsIn(copy), dirty());
        if (what === "stale") { stale(); return; }
        if (what === "hold") return;
        last = copy;
        swap(fresh);
      }).catch(function () { /* the next tick tries again */ }).then(function () { busy = false; });
    }
    ticker = setInterval(tick, every * 1000);
  }

  note();
  scrubbers();
})();
`;
