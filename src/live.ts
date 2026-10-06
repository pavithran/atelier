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

// What the script does, in two parts.
//
// Refresh: on a page whose <main> carries data-live-refresh, the same page
// is fetched again every so many seconds and <main>'s content swapped for
// the new copy, unless the owner is in the middle of something: a form
// field is focused or changed from its default, text is selected, or a
// scrubber is away from its end. Open disclosures stay open and the scroll
// position stays. Marks that were not on the page before arrive with the
// pop animation; everything else is drawn at rest, so the graph never
// redraws itself whole on a refresh. A response that lands on another page
// (the session ended) reloads the page instead of swapping.
//
// Scrubber: under every graph that carries positions (data-pos on its marks,
// data-from and data-to on its thread segments), a range input with Previous,
// Next and Play steps through the recorded events in order, drawing the
// picture as it stood after each one and saying which event that was.
export const LIVE_SCRIPT = `(() => {
  "use strict";
  var main = document.getElementById("main");
  if (!main) return;
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

  var note = function () { var n = main.querySelector(".live-note"); if (n) n.hidden = false; };

  // ── refresh ──
  var every = Number(main.getAttribute("data-live-refresh") || 0);
  if (every > 0) {
    var busy = false;
    function dirty() {
      var a = document.activeElement;
      if (a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(a.tagName) && !a.closest(".scrubber")) return true;
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
      if (busy || document.hidden || dirty()) return;
      busy = true;
      fetch(window.location.href, { credentials: "same-origin", cache: "no-store", headers: { accept: "text/html" } }).then(function (res) {
        if (!res.ok) return null;
        if (new URL(res.url).pathname !== window.location.pathname) { window.location.reload(); return null; }
        return res.text();
      }).then(function (html) {
        if (html === null) return;
        var doc = new DOMParser().parseFromString(html, "text/html");
        var fresh = doc.getElementById("main");
        if (fresh && fresh.innerHTML !== main.innerHTML) swap(fresh);
      }).catch(function () { /* the next tick tries again */ }).then(function () { busy = false; });
    }
    setInterval(tick, every * 1000);
  }

  note();
  scrubbers();
})();
`;
