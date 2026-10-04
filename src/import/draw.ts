// Imported history drawn as swimlanes: one lane per agent the commits name,
// time across, and how many commits fell in each slice of time as the
// density of the lane's colour. Server-drawn SVG, no script; every label
// is escaped. Commit messages never appear, only names and counts.

import { vendorOf } from "../graph.ts";
import { NO_AGENT, type ImportedHistory } from "./history.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const BINS = 96;
// A name longer than the lane label column is cut, and shown whole on hover.
const shortName = (s: string) => (s.length > 26 ? s.slice(0, 25).trimEnd() + "…" : s);

// The colour a lane takes: its agent's family, or none for "no agent named".
export function laneColour(label: string, owner: string): string {
  if (label === NO_AGENT) return "var(--text-dim)";
  return `var(--m-${vendorOf(`imported/${label.toLowerCase().replace(/\s+/g, "-")}`, owner)})`;
}

export function drawImported(h: ImportedHistory, owner: string, title: string): string {
  if (!h.total) return "";
  const W = 1200, X0 = 230, X1 = W - 20, TOP = 34, LANE = 26;
  const H = TOP + h.lanes.length * LANE + 26;
  const span = Math.max(1, h.last - h.first);
  const bin = (t: number) => Math.min(BINS - 1, Math.floor(((t - h.first) / span) * BINS));
  const bw = (X1 - X0) / BINS;
  const rows = h.lanes.map((lane, i) => {
    const y = TOP + i * LANE;
    const counts = new Array(BINS).fill(0);
    for (const t of lane.times) counts[bin(t)]++;
    const peak = Math.max(...counts);
    const cells = counts.map((n, b) => n ? `<rect x="${(X0 + b * bw).toFixed(1)}" y="${y - 8}" width="${Math.max(1, bw - 1).toFixed(1)}" height="16" rx="2" style="fill:${laneColour(lane.label, owner)};opacity:${(0.25 + 0.75 * n / peak).toFixed(2)}"><title>${esc(`${lane.label}: ${n} commit${n === 1 ? "" : "s"} around ${day(h.first + (b + 0.5) * span / BINS)}`)}</title></rect>` : "").join("");
    return `<g class="imp-lane"><text class="imp-name" x="${X0 - 12}" y="${y + 4}" text-anchor="end">${esc(shortName(lane.label))}<title>${esc(lane.label)}</title></text><text class="imp-count" x="${X0 - 12}" y="${y + 16}" text-anchor="end">${lane.count.toLocaleString("en")}</text>${cells}</g>`;
  }).join("");
  const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const x = X0 + f * (X1 - X0);
    return `<text class="g-clock" x="${x.toFixed(1)}" y="14" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${day(h.first + f * span)}</text>`;
  }).join("");
  return `<svg class="graph imported" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${title} before Atelier: ${h.total.toLocaleString("en")} commit${h.total === 1 ? "" : "s"}, ${h.attributed.toLocaleString("en")} naming an agent`)}">${axis}${rows}</svg>`;
}
