import { readFileSync } from "node:fs";
export const MAIN_SUITE_FILE = "/Users/Shared/atelier-main-suite/result.json";
export function readMainSuite(file) {
  // A host result must not change the CLI fixtures in its own suite.
  if (file === undefined && process.env.ATELIER_TEST_RUNNER) return null;
  file ??= MAIN_SUITE_FILE;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function mainSuiteLines(result = readMainSuite()) {
  if (!result || result.status === "green") return [];
  if (result.status === "incomplete") return ["Main suite: last run did not finish"];
  return [`Main suite RED: ${result.commit}; last green: ${result.lastGreen ?? "none recorded"}`,
    ...result.failures.map(name => `  ${name}`)];
}
