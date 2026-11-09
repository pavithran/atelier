import { failingTests } from "../src/check-failure.ts";
import { redactedText } from "../src/post-merge.ts";

// The most names a record carries; the server holds to the same number.
export const FAILED_NAMES_SENT = 200;

// The failing tests a required check's output names (t536), read from the
// whole of it before any cut, with credentials redacted first. At most 200
// go to the server beside the total, which the record says as "and N more".
export function failedTestNames(output, secrets = []) {
  const names = failingTests(redactedText(output, secrets))?.names ?? [];
  return names.length ? { failingTests: names.slice(0, FAILED_NAMES_SENT), failedTotal: names.length } : {};
}
