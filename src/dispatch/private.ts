import { actorFamily, RuleError } from "../rules.ts";
import type { PoolFamily } from "../models/pool.ts";

// The projects whose work stays with the companies PAVI trusts with it
// (t522): their tasks, criteria and code are never dispatched to, claimed by
// or reviewed by a model of any other company, free or not.
export const PRIVATE_PROJECTS: readonly string[] = ["tapestries", "walters-coach", "personal"];
export const PRIVATE_FAMILIES: readonly PoolFamily[] = ["anthropic", "openai", "google"];

export const isPrivateProject = (project: string): boolean => PRIVATE_PROJECTS.includes(project.trim().toLowerCase());

// Why a model may not work on a project, or null when it may. Only a named
// harness/model is judged; an actor with no model is the owner or a reserved
// actor, and a dispatch that names no model is judged when one claims it.
export function privateRefusal(project: string, actor: string): string | null {
  if (!isPrivateProject(project) || !actor.includes("/") || actor.startsWith("atelier/")) return null;
  const family = actorFamily(actor);
  return PRIVATE_FAMILIES.includes(family) ? null : `${project} is a private project, which only ${PRIVATE_FAMILIES.join(", ")} models work on, and ${actor} is ${family === "other" ? "of no known company" : `a ${family} model`}`;
}

export function assertPrivateModel(project: string, actor: string): void {
  const refusal = privateRefusal(project, actor);
  if (refusal) throw new RuleError("private_project", refusal, 409, `use a ${PRIVATE_FAMILIES.join(", ")} model`);
}
