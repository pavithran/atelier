// atelier check-log. Its forms, flags and help are declared in src/usage/commands/check-log.ts.
import { attemptHeader, checkAttemptsAt, headsWithChecks, plainLines, readCheckLog } from "../../src/check-failure.ts";
import { I, OWNER, actor, args, call, count, die, itemArg, logReader, project, short } from "../atelier.mjs";

// The retained logs of every check attempt at a head (t436): the ledger
// head unless --head names one the task stood at earlier, each attempt
// labelled by check, number among the runs of that check (the number
// `show` and the landings print for the same run), outcome, where and when
// it ran and its evidence id (and container run id), and, under
// sandboxOnly, that the gate does not count a run on a machine, with the
// stored whole log read by reference where the run kept one and the
// inline tail, labelled as such, where it did not. Terminal control
// sequences are dropped from the log; its lines are otherwise printed as
// the check wrote them, redacted as they were when recorded.
export default async function checkLogCommand() {
  const name = project(), id = itemArg(), as = await actor(OWNER);
  if (args.head !== undefined && (typeof args.head !== "string" || !/^[a-f0-9]{7,64}$/i.test(args.head))) die(`--head needs a revision, 7 to 64 hex digits: atelier check-log ${id} --head SHA`);
  const d = await call("GET", I(name, id), undefined, as);
  const evidence = d.evidence ?? [];
  const asked = typeof args.head === "string" ? args.head.toLowerCase() : null;
  const head = asked ? headsWithChecks(evidence).find((h) => h.head.startsWith(asked))?.head ?? asked : d.item.head;
  if (!head) die(`${id} records no head: nothing has been pushed, so no check has run`);
  const attempts = checkAttemptsAt(evidence, head, d.policy);
  if (!attempts.length) {
    const others = headsWithChecks(evidence).filter((h) => h.head !== head);
    die(`no check is recorded at ${short(head)} for ${id}${others.length ? `. Heads with recorded checks, newest first: ${others.map((h) => `${short(h.head)} (${count(h.runs, "attempt")})`).join(", ")}; name one with --head SHA` : ""}`);
  }
  console.log(`${name}/${id} at ${head}${head === d.item.head ? " (the ledger head)" : " (an earlier head)"}: ${count(attempts.length, "check attempt")} recorded for ${count(new Set(attempts.map((a) => a.claim)).size, "check")}.`);
  for (const a of attempts) {
    const log = await readCheckLog(a.evidence, logReader(name, id, as));
    console.log(`\n${attemptHeader(a)}`);
    // The lines naming the failure, read from the whole output, come first
    // where the run kept them beside a tail (t569).
    if (log.failureLines) console.log(`   failure lines, read from the whole output:\n${log.failureLines.join("\n")}`);
    console.log(`   log: ${log.label}`);
    const text = plainLines(log.text).join("\n").replace(/\n+$/, "");
    console.log(text || "   (no output retained)");
  }
}
