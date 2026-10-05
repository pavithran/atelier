interface Surface {
  path: string;
  baseline_lines: number;
  required: boolean;
  ceiling_lines?: number;
}
export interface ContextBudget {
  schema_version: 1;
  kind: "control-plane.context-budget";
  advisory: boolean;
  drift_multiple: number;
  surfaces: Surface[];
}

export function contextBudget(value: unknown): ContextBudget {
  const p = value as ContextBudget;
  if (!p || p.schema_version !== 1 || p.kind !== "control-plane.context-budget" || typeof p.advisory !== "boolean" ||
      !Number.isFinite(p.drift_multiple) || p.drift_multiple < 1 || !Array.isArray(p.surfaces) || !p.surfaces.length) throw new Error("invalid context budget policy");
  if (Object.keys(p).some((key) => !["schema_version", "kind", "advisory", "drift_multiple", "surfaces"].includes(key))) throw new Error("unknown context budget field");
  const paths = new Set<string>();
  for (const s of p.surfaces) {
    if (!s || typeof s.path !== "string" || !s.path || s.path.startsWith("/") || s.path.includes("\\") || s.path.split("/").includes("..") ||
        paths.has(s.path) || !Number.isInteger(s.baseline_lines) || s.baseline_lines <= 0 || typeof s.required !== "boolean" ||
        (s.ceiling_lines !== undefined && (!Number.isInteger(s.ceiling_lines) || s.ceiling_lines < s.baseline_lines))) throw new Error("invalid context budget surface");
    if (Object.keys(s).some((key) => !["path", "baseline_lines", "required", "ceiling_lines"].includes(key))) throw new Error("unknown context surface field");
    paths.add(s.path);
  }
  return p;
}

export function evaluateCeilings(policy: ContextBudget | undefined, contents: Record<string, string | undefined>): { refused: boolean; messages: string[] } {
  if (!policy) return { refused: false, messages: [] };
  contextBudget(policy);
  let refused = false;
  const messages: string[] = [];
  for (const surface of policy.surfaces) {
    const text = contents[surface.path];
    if (text === undefined) {
      if (surface.required) messages.push(`Advisory: ${surface.path} is missing.`);
      continue;
    }
    const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    if (surface.ceiling_lines !== undefined && lines > surface.ceiling_lines) {
      refused = true;
      messages.push(`${surface.path}: ${lines} lines, ceiling ${surface.ceiling_lines}. Move history to docs/history/ rather than raise the ceiling.`);
    } else if (Math.round(lines / surface.baseline_lines * 1000) / 1000 > policy.drift_multiple) {
      messages.push(`Advisory drift: ${surface.path}: ${lines} lines, baseline ${surface.baseline_lines}.`);
    }
  }
  return { refused, messages };
}
