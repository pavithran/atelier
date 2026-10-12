import { refusalOf, refusalText } from "./checks.ts";
import { redactKeys } from "./models/pool.ts";
import type { ProjectPolicy } from "./rules.ts";

export const PREPARATION_TAIL = 4000;
export interface PreparationResult {
  passed: boolean;
  status: number | null;
  signal?: string | null;
  timedOut?: boolean;
  output: string;
}

// Clean trees deliberately have no preparation cache: every attempt prepares
// its own tree, including a merged tree, before publishing any check evidence.
export async function prepareChecks(
  spec: ProjectPolicy["prepare"],
  execute: (command: string) => Promise<PreparationResult>,
  secrets: string[] = [],
): Promise<void> {
  if (!spec) return;
  const clean = (text: string) => {
    for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
    return redactKeys(text);
  };
  const why = refusalOf(spec.command);
  if (why) throw new Error(clean(refusalText(spec.command, why)));
  let result: PreparationResult;
  try { result = await execute(spec.command); }
  catch (error) {
    result = { passed: false, status: null, output: String(error) };
  }
  if (result.passed) return;
  const status = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unavailable"}`;
  throw new Error(`Preparation \`${clean(spec.command)}\` failed: ${status}${result.timedOut ? " (timed out)" : ""}. Output tail (last ${PREPARATION_TAIL} characters, redacted):\n${clean(result.output).slice(-PREPARATION_TAIL)}`);
}
