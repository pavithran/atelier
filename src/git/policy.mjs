// What the server and the pre-receive hook pass each other for a push
// (Atelier 2.0, design section 4.4, rules 5 and 6). The hook runs in its own
// process and cannot reach the Ledger, so for each push the server writes
// the project's policy for it to a file, and the hook writes what it found to
// another, both in a directory of the request's own (mode 700, under the data
// directory) that goes when the request ends. The hook's environment names
// the two paths.
//   policy  { clearances: [{ file, fingerprint }], private: [path] }: the
//           secret clearances the owner recorded on the task and the
//           project's private paths.
//   report  { ref, head, hits, unscanned, refused }: the secret scan of the
//           commits the push adds, as file, line, fingerprint, commit and
//           reason, never a value.
// Neither file holds a token or a secret's value.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function openScan(root, policy) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "push-"));
  const paths = { policy: join(dir, "policy.json"), report: join(dir, "report.json") };
  writeFileSync(paths.policy, JSON.stringify(policy), { mode: 0o600 });
  return {
    env: { ATELIER_POLICY: paths.policy, ATELIER_REPORT: paths.report },
    // The hook's report, or null when it wrote none (a push refused before
    // the scan, or one with nothing to scan).
    report() {
      try { return JSON.parse(readFileSync(paths.report, "utf8")); } catch { return null; }
    },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// The hook's side: the policy the server wrote, and the report written for
// it to read, mode 600.
export function readPolicy(path) {
  const p = JSON.parse(readFileSync(path, "utf8"));
  return { clearances: Array.isArray(p.clearances) ? p.clearances : [], private: Array.isArray(p.private) ? p.private : [] };
}
export function writeReport(path, report) {
  if (path) writeFileSync(path, JSON.stringify(report), { mode: 0o600 });
}
