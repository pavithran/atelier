// Which policy requires a review of a change, said before its checks run
// (t422), and where a project's recorded policy and its written instructions
// disagree about reviews. Pure: the CLI reads the files and Git.
// controllingRule follows changeClass in src/rules.ts, which decides the
// class; this names the rule that decided it.

import { checkFiles, classRequirement, matchesFolded, matchesAny, SHIP_FILES, type ChangeClass, type ProjectPolicy } from "./rules.ts";

export interface ControllingRule {
  kind: ChangeClass;
  path: string | null;   // the changed path that decided the class
  glob: string | null;   // the protected glob it matched; null for a coordinated change
  origin: string;        // which part of the policy holds the glob
  requirement: string;   // classRequirement of the class
}

// A policy file as the checkout holds it, for the notice to name.
export interface PolicySource {
  file: string;
  version?: string | null;
}

export function controllingRule(paths: readonly string[], policy: ProjectPolicy): ControllingRule | null {
  if (!paths.length) return null;
  const groups: [string, string[]][] = [
    ["the project's protected paths", policy.protected],
    ["the files its required checks run", checkFiles(policy.checks)],
    ["the execution policy's protected_path_patterns", policy.execution?.protected_path_patterns ?? []],
    ["the ship files", SHIP_FILES],
    ["the files its ship order runs", checkFiles(policy.shipRuns ?? [])],
  ];
  for (const [origin, globs] of groups) {
    for (const path of paths) {
      const glob = globs.find((g) => matchesFolded(path, [g]));
      if (glob !== undefined) return { kind: "protected", path, glob, origin, requirement: classRequirement("protected") };
    }
  }
  const direct = policy.execution?.direct;
  if (direct?.enabled && paths.every((p) => matchesAny(p, direct.allowed_path_patterns))) {
    return { kind: "direct", path: null, glob: null, origin: "the execution policy's direct paths", requirement: classRequirement("direct") };
  }
  const outside = direct?.enabled ? paths.find((p) => !matchesAny(p, direct.allowed_path_patterns)) ?? null : paths[0] ?? null;
  return { kind: "coordinated", path: outside, glob: null, origin: "the execution policy", requirement: classRequirement("coordinated") };
}

// The lines `atelier done` and `atelier land` print before the checks run,
// or null where the change needs no review: a direct change, and a
// coordinated one in a project without an execution policy, need none.
export function reviewNotice(paths: readonly string[], policy: ProjectPolicy, source?: PolicySource | null): string[] | null {
  const rule = controllingRule(paths, policy);
  if (!rule || rule.kind === "direct") return null;
  if (rule.kind === "coordinated" && !policy.execution) return null;
  const named = source ? `${source.file}${source.version ? ` (version ${source.version})` : ""}` : "the project's recorded policy, as stored on the server";
  const why = rule.glob !== null
    ? `${rule.path} matches the protected glob ${rule.glob}, from ${rule.origin}`
    : `${rule.path ?? "this change"} is not within the execution policy's direct paths`;
  return [
    `A review will be needed before this lands: ${rule.requirement}.`,
    `  Controlling policy: ${named}`,
    `  Rule: ${why}; class ${rule.kind}`,
  ];
}

// An instruction file as the checkout holds it.
export interface Instructions { file: string; text: string }

// Where the written instructions call review optional while the recorded
// policy requires one: each such line, with the requirement it disagrees
// with. A heuristic on wording, so it names the line for a person to settle.
export function reviewDisagreements(policy: ProjectPolicy, instructions: readonly Instructions[]): string[] {
  const requires: string[] = [];
  if (policy.protected.length) requires.push(`a protected change (${policy.protected.slice(0, 4).join(", ")}${policy.protected.length > 4 ? ", …" : ""}) needs a review from another model family`);
  if (policy.execution?.allowed_classes.includes("coordinated")) requires.push("a coordinated change needs another agent's review");
  if (!requires.length) return [];
  const out: string[] = [];
  for (const { file, text } of instructions) {
    text.split("\n").forEach((line, i) => {
      if (/\breview/i.test(line) && /\boptional\b/i.test(line)) {
        out.push(`${file}:${i + 1} calls review optional ("${line.trim().slice(0, 120)}"), but the recorded policy says ${requires.join("; ")}`);
      }
    });
  }
  return out;
}
