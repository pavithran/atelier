import { TEXT_CONTROLS } from "../text.ts";
import { planErrors } from "./errors.ts";
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

// Limits for the design's small plans. Lengths count UTF-16 code units after
// NFC normalization and cleaning; list limits count entries before deduplication.
export const PLAN_LIMITS = {
  parts: 12,
  goal: 2000, title: 80, key: 80, brief: 2000, actor: 80, reason: 2000,
  scope: { count: 6, entry: 2000 },
  dependsOn: { count: 12, entry: 80 },
  provides: { count: 12, entry: 80 },
  uses: { count: 12, entry: 80 },
  acceptance: { count: 12, entry: 2000 },
  tests: { count: 12, entry: 2000 },
} as const;

const TASK_KINDS = ["mechanical-edit", "feature", "refactor", "tests", "docs", "ui", "research"] as const satisfies readonly TaskKind[];
const PART_FIELDS = ["key", "title", "kind", "taskKind", "scope", "dependsOn", "provides", "uses", "brief", "acceptance", "tests", "size", "prefer"];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const plain = (s: string) => s.normalize("NFC").replace(TEXT_CONTROLS, " ").trim();
const short = (s: string) => s.length > PLAN_LIMITS.key ? `${s.slice(0, PLAN_LIMITS.key - 1)}…` : s;

function fieldName(field: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(field)) return `.${short(field)}`;
  let escaped = "";
  for (const char of field) {
    const next = /^[A-Za-z0-9_-]$/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`;
    if (escaped.length + next.length > PLAN_LIMITS.key - 5) {
      escaped += "…";
      break;
    }
    escaped += next;
  }
  return `["${escaped}"]`;
}

export function parsePlan(value: unknown): PlanResult {
  const errors = planErrors();
  const unknownFields = (v: Record<string, unknown>, allowed: readonly string[], at: string) => {
    for (const field of Object.keys(v)) if (!allowed.includes(field)) errors.push(`${at}${fieldName(field)}: unknown field`);
  };
  const string = (v: unknown, at: string, max: number): string => {
    if (typeof v !== "string" || !plain(v)) {
      errors.push(`${at}: must be a non-empty string`);
      return "";
    }
    const cleaned = plain(v);
    if (cleaned.length > max) errors.push(`${at}: must contain at most ${max} characters`);
    return cleaned;
  };
  const list = (v: unknown, at: string, limit: { count: number; entry: number }, unit = "entries"): string[] => {
    if (!Array.isArray(v)) {
      errors.push(`${at}: must be an array of strings`);
      return [];
    }
    if (v.length > limit.count) errors.push(`${at}: must contain at most ${limit.count} ${unit}`);
    return v.slice(0, limit.count).map((entry, i) => string(entry, `${at}[${i}]`, limit.entry));
  };
  const choice = <T extends string>(v: unknown, choices: readonly T[], at: string): T => {
    const cleaned = typeof v === "string" ? plain(v) : "";
    if (!choices.includes(cleaned as T)) errors.push(`${at}: must be one of ${choices.join(", ")}`);
    return cleaned as T;
  };
  if (!object(value)) return { ok: false, errors: ["plan: must be an object"] };
  unknownFields(value, ["schema", "goal", "parts"], "plan");
  const schema = choice(value.schema, ["atelier.plan.v1"], "plan.schema");
  const goal = string(value.goal, "plan.goal", PLAN_LIMITS.goal);
  if (!Array.isArray(value.parts)) {
    errors.push("plan.parts: must be an array");
    return { ok: false, errors: errors.result() };
  }
  if (!value.parts.length) errors.push("plan.parts: must contain at least one part");
  if (value.parts.length > PLAN_LIMITS.parts) errors.push(`plan.parts: must contain at most ${PLAN_LIMITS.parts} parts`);
  const parts: PlanPart[] = [];
  for (const [i, raw] of value.parts.slice(0, PLAN_LIMITS.parts).entries()) {
    if (!object(raw)) {
      errors.push(`part[${i}]: must be an object`);
      continue;
    }
    const at = typeof raw.key === "string" && plain(raw.key) ? `part ${short(plain(raw.key))}` : `part[${i}]`;
    unknownFields(raw, PART_FIELDS, at);
    const key = string(raw.key, `${at}.key`, PLAN_LIMITS.key);
    if (key && !/^[A-Za-z0-9-]+$/.test(key)) errors.push(`${at}.key: must contain only letters (A-Z, a-z), digits (0-9) and hyphens`);
    const title = string(raw.title, `${at}.title`, PLAN_LIMITS.title);
    const kind = choice(raw.kind, ["interface", "build", "tests", "docs"], `${at}.kind`);
    const taskKind = choice(raw.taskKind, TASK_KINDS, `${at}.taskKind`);
    const scope = list(raw.scope, `${at}.scope`, PLAN_LIMITS.scope, "globs");
    if (!scope.length) errors.push(`${at}.scope: must contain at least one glob`);
    const dependsOn = list(raw.dependsOn, `${at}.dependsOn`, PLAN_LIMITS.dependsOn);
    const provides = list(raw.provides, `${at}.provides`, PLAN_LIMITS.provides);
    const uses = list(raw.uses, `${at}.uses`, PLAN_LIMITS.uses);
    const brief = string(raw.brief, `${at}.brief`, PLAN_LIMITS.brief);
    const acceptance = list(raw.acceptance, `${at}.acceptance`, PLAN_LIMITS.acceptance);
    if (!acceptance.length) errors.push(`${at}.acceptance: must contain at least one criterion`);
    const tests = list(raw.tests, `${at}.tests`, PLAN_LIMITS.tests);
    const size = choice(raw.size, ["S", "M"], `${at}.size`);
    let prefer: PlanPart["prefer"];
    if (Object.hasOwn(raw, "prefer")) {
      if (!object(raw.prefer)) errors.push(`${at}.prefer: must be an object`);
      else {
        unknownFields(raw.prefer, ["actor", "reason"], `${at}.prefer`);
        prefer = { actor: string(raw.prefer.actor, `${at}.prefer.actor`, PLAN_LIMITS.actor), reason: string(raw.prefer.reason, `${at}.prefer.reason`, PLAN_LIMITS.reason) };
      }
    }
    parts.push({ key, title, kind, taskKind, scope, dependsOn, provides, uses, brief, acceptance, tests, size, ...(prefer ? { prefer } : {}) });
  }
  const messages = errors.result();
  return messages.length ? { ok: false, errors: messages } : { ok: true, plan: { schema, goal, parts } };
}

// Object keys are sorted recursively and string values are normalized to NFC,
// so NFC and NFD forms hash alike. Array order remains part of the document.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
}

export async function planHash(plan: Plan): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(plan)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
