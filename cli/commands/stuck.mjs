// atelier stuck. Forms, flags and help live in src/usage/commands/stuck.ts.
import { OWNER, P, actor, args, call, die, project } from "../atelier.mjs";

export default async function stuckCommand() {
  const name = project(), as = await actor(OWNER), query = new URLSearchParams();
  for (const [flag, key] of Object.entries({ "no-push-hours": "noPushHours", "unanswered-hours": "unansweredHours", "lease-wait-minutes": "leaseWaitMinutes", "conflict-wait-minutes": "conflictWaitMinutes", "core-hold-minutes": "coreHoldMinutes", "runner-poll-minutes": "runnerPollMinutes", "review-answer-hours": "reviewAnswerHours" })) {
    if (args[flag] !== undefined) {
      if (!Number.isFinite(Number(args[flag])) || Number(args[flag]) <= 0) die(`--${flag} must be a positive finite number`);
      query.set(key, args[flag]);
    }
  }
  const report = await call("GET", `${P(name)}/stuck?${query}`, undefined, as);
  if (args.json) return console.log(JSON.stringify(report, null, 2));
  console.log(`Stuck in ${report.project} — observed ${report.observedAt}`);
  console.log(`Limits (age > limit): ${Object.entries(report.limits).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  for (const source of report.unavailable) console.log(`UNAVAILABLE: ${source}`);
  for (const entry of report.entries) console.log(`${entry.subject}: ${entry.reason}\n  Since ${entry.since}; evidence age ${Math.floor(entry.ageMs / 1000)}s\n  Evidence: ${entry.evidence}\n  Recovery: ${entry.recovery}`);
  if (!report.entries.length) console.log(!report.complete ? "No findings in available evidence; report incomplete." : "No stuck work observed.");
  console.log(`Failed observed check commands in the preceding rolling day: ${report.failedChecksLastDay?.length ?? "unavailable"}`);
  for (const entry of report.failedChecksLastDay ?? []) console.log(`${entry.subject}: ${entry.reason}\n  ${entry.since}; evidence age ${Math.floor(entry.ageMs / 1000)}s\n  Evidence: ${entry.evidence}\n  Recovery: ${entry.recovery}`);
}
