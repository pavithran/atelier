// The text `atelier situation` prints for a person (G4): the server's
// situation read (src/situation.ts), one section per kind of fact, each line
// a fact and, where a step lifts it, the command. `--json` prints the read
// itself. Pure, so a test reads the text without a server.
import { stripVTControlCharacters } from "node:util";

// An age in milliseconds as a short span: 45s, 12m, 3h 5m, 2d 4h.
export function span(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "?";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
const short = (sha) => (sha ? String(sha).slice(0, 8) : "no head");
const flat = (t) => stripVTControlCharacters(String(t ?? "")).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

export function situationText(s) {
  const out = [`Situation of ${s.project}, observed ${s.observedAt}`];
  const section = (title, lines, none) => { out.push("", `${title}:`, ...(lines.length ? lines : [`  ${none}`])); };

  section("Tasks", s.tasks.map((t) => [
    `  ${t.id.padEnd(5)} ${t.state.padEnd(9)} ${t.stage ? `${t.stage} for ${span(t.stageAgeMs)}` : "no stage recorded"}; ${t.owner ? `held by ${flat(t.owner)}${t.runner ? ` on ${flat(t.runner)}` : ""}` : "unheld"}; head ${short(t.head)}; ${flat(t.title)}`,
    `        scope ${t.scope.length ? t.scope.map(flat).join(", ") : "not specified"}${t.dispatch ? `; dispatched (${t.dispatch.job}) to ${[t.dispatch.agent, t.dispatch.model].filter(Boolean).join("/") || t.dispatch.to || "any"}` : ""}`,
    ...(t.blockedBy?.length ? [`        blocked by ${t.blockedBy.map((b) => `${b.id} (${b.state})`).join(", ")}${t.blockedBy.some((b) => b.state === "abandoned") ? "; an abandoned blocker keeps it waiting: edit --blocked-by to drop it" : ""}`] : []),
    ...(t.lastCheck ? [`        last check: ${flat(t.lastCheck.claim)} ${t.lastCheck.stopped ? `stopped (${t.lastCheck.stopped.kind}, ${t.lastCheck.stopped.minutes} min)` : t.lastCheck.passed ? "passed" : "failed"} at ${short(t.lastCheck.head)}, ${t.lastCheck.at}`] : []),
    ...(t.lastRun ? [`        last run: ${lastRunText(t.lastRun)}`] : []),
    ...(t.progress ? [`        progress: ${progressText(t.progress, t.lastCheck)}${t.progress.stall ? `  STALL: ${flat(t.progress.stall)}` : ""}`] : []),
  ].join("\n")), "no live task");

  section("Holds", s.holds.map((h) => h.kind === "blocked-by"
    ? `  ${h.task} waits on ${h.blockers.map((b) => `${b.id} (${b.state})`).join(", ")} to merge`
    : `  ${h.task} waits on ${h.blockers.map((b) => `${b.id} (${b.state}${b.owner ? ` by ${flat(b.owner)}` : ""}) at core file ${flat(b.file)}`).join("; ")}${h.ageMs !== null ? `, for ${span(h.ageMs)}` : ""}`), "none");

  section("Review requests", s.reviewRequests.map((r) => `  #${r.id} ${r.task} at ${short(r.head)}: ${r.state}, asked of ${flat(r.reviewer ?? "any reviewer")} ${span(r.ageMs)} ago${r.claimedBy ? `, claimed by ${flat(r.claimedBy)}${r.runner ? ` on ${flat(r.runner)}` : ""}` : ""}${r.tier ? " (tier)" : ""}`), "none open");

  section("Runners", s.runners.map((r) => {
    const flags = [r.never ? "NEVER POLLED" : r.silent ? `SILENT ${span(r.silentMs)}` : null, r.otherCommit ? `ON ANOTHER COMMIT (${short(r.commit)}, the server runs ${short(s.server.commit)})` : null].filter(Boolean);
    return [
      `  ${r.runner}: ${r.never ? "never polled" : `last poll ${span(r.silentMs)} ago`}${flags.length ? `  ${flags.join("; ")}` : ""}`,
      `        ${r.currentJobs.length ? `working on ${r.currentJobs.map((j) => `${j.task} (${j.job})`).join(", ")}` : "no current job"}; models ${r.models.length ? r.models.join(", ") : "none offered"}; serves ${r.projects ? r.projects.join(", ") : "every project"}; commit ${r.commit ? short(r.commit) : "not said"}`,
    ].join("\n");
  }), "none serves this project");

  const l = s.landings;
  section("Landings", [
    ...(l.lease ? [`  lease: ${l.lease.task} by ${flat(l.lease.holder)} since ${l.lease.since}`] : []),
    ...l.queued.map((q) => `  queued: ${q.task} by ${flat(q.by)}, ${span(q.ageMs)} ago`),
    ...l.records.map((r) => `  ${r.task}: attempt ${r.attempt}, ${r.failedStep ? `failed at ${flat(r.failedStep)}` : `at ${flat(r.step)}`}, ${r.at}`),
  ], "none");

  section("Blocks", s.blocks.map((b) => `  ${b.task}: ${flat(b.reason)} (by ${flat(b.by)}, ${span(b.ageMs)} ago${b.until ? `, until ${b.until}` : ""}); lifted by ${b.liftedBy}: ${b.next}`), "none");

  const m = s.limits;
  section("Limits", [
    `  check limit ${m.limitMinutes} min (${m.limitFrom}), silence ${m.silenceMinutes} min, startup ${m.startupMinutes === null ? "none" : `${m.startupMinutes} min`}, slot wait ${m.slotWaitMinutes} min`,
    `  checks: ${m.checks.length ? m.checks.map(flat).join(", ") : "none required"}; deploy gate: ${m.deployGate?.length ? m.deployGate.map(flat).join(", ") : "no runs required"}`,
    `  mode: ${flat(m.modeLine)}`,
  ], "none");

  section("Standing decisions", s.standing.map((d) => `  ${d.id}: ${flat(d.text)} (${d.at.slice(0, 10)}, "${flat(d.quote)}")`), "none");
  section("Standing instructions", (s.standingInstructions ?? []).map((d) => `  ${d.id}: ${flat(d.key)} = ${flat(d.value)}${d.acts ? "" : " (not acting: the project is not in fast mode)"} (${d.at.slice(0, 10)}, "${flat(d.quote)}"); withdraw with atelier decisions withdraw ${d.id} --note "why"`), "none");

  const disk = s.server.disk;
  section("Server", [
    `  commit ${s.server.commit ? short(s.server.commit) : "not known"}`,
    disk ? `  free disk ${gib(disk.freeBytes)} of ${gib(disk.totalBytes)} (${disk.freePercent}%) at ${disk.path}${disk.warning ? "  WARNING: under 10 percent free" : ""}` : "  free disk not readable here",
  ], "");

  section("Spend", s.spend.map((x) => `  ${x.task} ${flat(x.model)}: ${x.costUsd === null ? "cost not reported" : `$${x.costUsd.toFixed(2)}`}${x.tokens === null ? "" : `, ${x.tokens} tokens`}`), "none recorded");

  if (s.stalls?.length) section("Stalls", s.stalls.map((x) => `  ${x.task}: ${flat(x.reason)}`), "none");
  if (s.unavailable.length) out.push("", `Not read: ${s.unavailable.join(", ")}`);
  return out.join("\n");
}

// One task's live progress line (G21), as the runner last reported it.
export function progressText(p, lastCheck = null) {
  if (!p) return "none reported";
  const check = lastCheck ? `last check ${flat(lastCheck.claim)} ${lastCheck.stopped ? "stopped" : lastCheck.passed ? "passed" : "failed"} at ${short(lastCheck.head)}` : "no check yet";
  const current = p.telemetry === false ? null : p.current ? `running ${flat(p.current.name)}${p.current.summary ? ` (${flat(p.current.summary)})` : ""} for ${span(p.current.ageMs)}` : "between commands";
  return [
    p.telemetry === false || !p.commands ? `no command telemetry for ${p.harness ?? "this harness"}` : `${p.commands.completed} command${p.commands.completed === 1 ? "" : "s"} run`,
    `${p.commits} commit${p.commits === 1 ? "" : "s"} on t/${String(p.task).slice(1)}`,
    ...(current ? [current] : []),
    p.childAlive === null ? "child processes not readable" : p.childAlive ? "a child process is alive" : "no child process",
    check,
    ...(p.runner ? [`runner ${flat(p.runner)}`] : []),
    // A log is named only when the runner reported the file there to read
    // (t489): a harness that writes no progress log (codex, opencode) is said
    // to have none, never a path that is not there.
    ...(p.log ? [`log at ${flat(p.log)}`] : ["no log named"]),
    ...(p.attempt ? [`attempt ${p.attempt}`] : []),
    `elapsed ${span(p.elapsedMs)}`,
    p.costUsd !== null && p.costUsd !== undefined ? `$${Number(p.costUsd).toFixed(2)}` : p.tokens ? `${p.tokens} tokens` : "cost not reported",
    p.ended ? "run ended" : `reported ${span(p.reportedAgoMs)} ago`,
  ].join("; ");
}

// A run report's facts in a line: what ended, the exit, the output's size and
// where its log is on the runner's host. No text of the output is kept anywhere but that log.
export function lastRunText(r) {
  return [`${flat(r.outcome)} (${flat(r.role)}) by ${flat(r.actor)} on ${flat(r.runner)} at ${r.at}`,
    r.exitCode !== null ? `exit ${r.exitCode}` : r.signal ? `ended by ${flat(r.signal)}` : null,
    r.lines !== null ? `${r.lines} lines, ${r.bytes ?? "?"} bytes of output` : null,
    r.log ? `log on ${flat(r.host ?? "the runner")} at ${flat(r.log)}` : "no log named"].filter(Boolean).join("; ");
}
