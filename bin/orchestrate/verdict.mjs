// verdict.mjs ANSWERFILE: reads a reviewer's answer with Atelier's own parser
// (src/review/verdict.ts, the one the runner uses) and prints one JSON line:
// { ok, verdict, summary, findings } or { ok: false, error }. land.sh records
// the verdict and its findings from it.
import { readFileSync } from "node:fs";
import { parseVerdict } from "../../src/review/verdict.ts";

let text = "";
try { text = readFileSync(process.argv[2], "utf8"); } catch { /* an unreadable answer parses as no verdict */ }
process.stdout.write(JSON.stringify(parseVerdict(text)) + "\n");
