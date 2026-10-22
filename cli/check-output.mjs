import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// t176: keep failed attempts outside the clone before a retry can hide them.
// The caller supplies only output already redacted at the capture boundary.
export function saveFailedOutput(cache, output) {
  const root = resolve(cache, "check-logs");
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const directory = mkdtempSync(join(root, "attempt-"));
    chmodSync(directory, 0o700);
    const path = join(directory, "output.log");
    writeFileSync(path, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    throw new Error(`Could not retain failed check output under ${root}: ${error.code ?? "write failed"}`);
  }
}
