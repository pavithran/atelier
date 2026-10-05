import type { TaskKind } from "../models/registry.ts";

export interface PlanPart {
  key: string;
  title: string;
  kind: "interface" | "build" | "tests" | "docs";
  taskKind: TaskKind;
  scope: string[];
  dependsOn: string[];
  provides: string[];
  uses: string[];
  brief: string;
  acceptance: string[];
  tests: string[];
  size: "S" | "M";
  prefer?: { actor: string; reason: string };
}

export interface Plan {
  schema: "atelier.plan.v1";
  goal: string;
  parts: PlanPart[];
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

const TASK_KINDS = ["mechanical-edit", "feature", "refactor", "tests", "docs", "ui", "research"] as const satisfies readonly TaskKind[];
const PART_FIELDS = ["key", "title", "kind", "taskKind", "scope", "dependsOn", "provides", "uses", "brief", "acceptance", "tests", "size", "prefer"];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();

export function parsePlan(value: unknown): PlanResult {
  const errors: string[] = [];
  const unknownFields = (v: Record<string, unknown>, allowed: readonly string[], at: string) => {
    for (const field of Object.keys(v)) if (!allowed.includes(field)) errors.push(`${at}.${plain(field)}: unknown field`);
  };
  const string = (v: unknown, at: string): string => {
    if (typeof v !== "string" || !plain(v)) {
      errors.push(`${at}: must be a non-empty string`);
      return "";
    }
    return plain(v);
  };
  const list = (v: unknown, at: string): string[] => {
    if (!Array.isArray(v)) {
      errors.push(`${at}: must be an array of strings`);
      return [];
    }
    return v.map((entry, i) => string(entry, `${at}[${i}]`));
  };
  const choice = <T extends string>(v: unknown, choices: readonly T[], at: string): T => {
    const cleaned = typeof v === "string" ? plain(v) : "";
    if (!choices.includes(cleaned as T)) errors.push(`${at}: must be one of ${choices.join(", ")}`);
    return cleaned as T;
  };
  if (!object(value)) return { ok: false, errors: ["plan: must be an object"] };
  unknownFields(value, ["schema", "goal", "parts"], "plan");
  const schema = choice(value.schema, ["atelier.plan.v1"], "plan.schema");
  const goal = string(value.goal, "plan.goal");
  if (!Array.isArray(value.parts)) return { ok: false, errors: [...errors, "plan.parts: must be an array"] };
  if (value.parts.length > 12) errors.push("plan.parts: must contain at most 12 parts");
  const parts: PlanPart[] = [];
  for (const [i, raw] of value.parts.entries()) {
    if (!object(raw)) {
      errors.push(`part[${i}]: must be an object`);
      continue;
    }
    const at = typeof raw.key === "string" && plain(raw.key) ? `part ${plain(raw.key)}` : `part[${i}]`;
    unknownFields(raw, PART_FIELDS, at);
    const key = string(raw.key, `${at}.key`);
    const title = string(raw.title, `${at}.title`);
    const kind = choice(raw.kind, ["interface", "build", "tests", "docs"], `${at}.kind`);
    const taskKind = choice(raw.taskKind, TASK_KINDS, `${at}.taskKind`);
    const scope = list(raw.scope, `${at}.scope`);
    if (!scope.length) errors.push(`${at}.scope: must contain at least one glob`);
    if (scope.length > 6) errors.push(`${at}.scope: must contain at most 6 globs`);
    const dependsOn = list(raw.dependsOn, `${at}.dependsOn`);
    const provides = list(raw.provides, `${at}.provides`);
    const uses = list(raw.uses, `${at}.uses`);
    const brief = string(raw.brief, `${at}.brief`);
    if (brief.length > 2000) errors.push(`${at}.brief: must contain at most 2000 characters`);
    const acceptance = list(raw.acceptance, `${at}.acceptance`);
    const tests = list(raw.tests, `${at}.tests`);
    const size = choice(raw.size, ["S", "M"], `${at}.size`);
    let prefer: PlanPart["prefer"];
    if (Object.hasOwn(raw, "prefer")) {
      if (!object(raw.prefer)) errors.push(`${at}.prefer: must be an object`);
      else {
        unknownFields(raw.prefer, ["actor", "reason"], `${at}.prefer`);
        prefer = { actor: string(raw.prefer.actor, `${at}.prefer.actor`), reason: string(raw.prefer.reason, `${at}.prefer.reason`) };
      }
    }
    parts.push({ key, title, kind, taskKind, scope, dependsOn, provides, uses, brief, acceptance, tests, size, ...(prefer ? { prefer } : {}) });
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan: { schema, goal, parts } };
}

// Object keys are sorted recursively. Array order remains part of the document.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function planHash(plan: Plan): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(plan)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
