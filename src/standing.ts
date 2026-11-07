// The models key is a session plan in either mode. dispatch-on-criteria
// also acts in either mode, on the developer's instruction: it names the
// project's builders, and a task filed with criteria goes to the first free one. The other standing
// instructions (Atelier 2.0, G6) are the only automatic actions left
// to the server and the tick. Each is a standing decision the developer
// records with `atelier decide --standing KEY VALUE --quote "…"`, with their
// own words, for a project in fast mode; it is withdrawn as any decision is
// (`atelier decisions withdraw dN --note "…"`), by the developer or a session
// acting on the developer's token (G18). `atelier decisions` lists them. A
// project that leaves fast mode keeps the records, and none of them acts
// until it is in fast mode again.
//
// Without an instruction, most of these do not happen by themselves: a review
// request the head moved past is withdrawn and asked again by `atelier
// review-request`, a fast landing's post-merge review stays owed until it is
// asked, and a stuck episode is noticed after LIMITS.noticeAfterMs. The
// landing is the exception (t520): the stage tick queues the land job of a
// task whose checks passed and whose head a reviewer of another company
// approved, with no instruction. queue-landable off stops it.

import { TEXT_CONTROLS } from "./text.ts";
import { POOL_FAMILIES } from "./models/pool.ts";
import { RuleError, validActor } from "./rules.ts";

export interface StandingKey {
  value: string;   // what VALUE is, as the refusal and the help say it
  says: (value: string) => string;
  parse: (value: string) => string | null;   // the value as stored, or null when it is not one
}

// The builders a dispatch-on-criteria value lists, in the order of preference,
// each a harness/model; none for off, for a malformed entry or a repeat.
export function buildersOf(value: string): string[] {
  if (value === "off") return [];
  const list = value.split(",").map((b) => b.trim());
  const seen = new Set<string>();
  for (const b of list) {
    if (!validActor(b) || !b.includes("/") || b.endsWith("/") || b.split("/").length !== 2 || seen.has(b.toLowerCase())) return [];
    seen.add(b.toLowerCase());
  }
  return list;
}

const onOff = (v: string) => (v === "on" || v === "off" ? v : null);

export const STANDING: Record<string, StandingKey> = {
  "dispatch-on-criteria": {
    value: "harness/model[,harness/model...] or off",
    says: (v) => v === "off" ? "a task filed with criteria is dispatched by no standing instruction" : `a task filed with criteria is dispatched at once to the first free builder of ${v.split(",").join(", ")} (the criteria review runs beside the build), in either mode`,
    parse: (v) => v === "off" ? v : buildersOf(v).join(",") || null,
  },
  models: {
    value: "non-empty text describing the models, roles and effort levels",
    says: () => "unwrap prints this model plan at the start of a session",
    parse: (v) => v.replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim() || null,
  },
  "queue-landable": {
    value: "on or off",
    says: (v) => v === "on" ? "the stage tick queues the land job of a landable task a reviewer of another company approved, for a live lander runner (which it does with no instruction since t520)" : "the stage tick queues no landing",
    parse: onOff,
  },
  "reask-on-resubmit": {
    value: "on or off",
    says: (v) => v === "on" ? "a review request withdrawn because the task's head moved is asked again of the same reviewer at the new head, once the gate needs it" : "a review request the head moved past stays withdrawn until it is asked again",
    parse: onOff,
  },
  "review-on-checked": {
    value: "company=harness/model pairs separated by commas, or off",
    says: (v) => v === "off" ? "no review is asked when checks pass" : `the stage tick asks the reviewer mapped to the builder's company when checks pass: ${v}`,
    parse: (v) => {
      if (v === "off") return v;
      const seen = new Set<string>();
      for (const pair of v.split(",")) {
        const parts = pair.split("=");
        if (parts.length !== 2) return null;
        const [company, reviewer] = parts;
        if (!POOL_FAMILIES.includes(company as typeof POOL_FAMILIES[number]) || seen.has(company) || !reviewer.includes("/") || !validActor(reviewer)) return null;
        seen.add(company);
      }
      return v;
    },
  },
  "post-merge-reviewer": {
    value: "a reviewer as harness/model, or off",
    says: (v) => v === "off" ? "no post-merge review is asked by itself" : `the post-merge review of a task landed in fast mode is asked of ${v} as its merge is recorded`,
    parse: (v) => (v === "off" || validActor(v) ? v : null),
  },
  "notice-delay": {
    value: "a number of minutes from 1 to 1440",
    says: (v) => `a stuck episode is sent to the developer's channel once it has been open ${v} minute${v === "1" ? "" : "s"}`,
    parse: (v) => (/^[1-9][0-9]{0,3}$/.test(v) && Number(v) <= 1440 ? String(Number(v)) : null),
  },
};

export interface Standing { key: string; value: string }

// The instruction a request names, checked: a known key and a value it takes.
export function parseStanding(raw: unknown): Standing {
  const s = (raw ?? {}) as { key?: unknown; value?: unknown };
  const key = typeof s.key === "string" ? s.key.trim() : "";
  const known = Object.keys(STANDING);
  if (!Object.hasOwn(STANDING, key)) throw new RuleError("bad_standing", `a standing instruction is one of ${known.join(", ")}, not "${key.slice(0, 40)}"`, 400);
  const value = STANDING[key].parse(typeof s.value === "string" ? s.value.trim() : "");
  if (value === null) throw new RuleError("bad_standing", `${key} takes ${STANDING[key].value}`, 400);
  return { key, value };
}

// The decision's text for an instruction: the key, the value, what it does.
export function standingText(s: Standing): string {
  return `Standing instruction ${s.key} = ${s.value}: ${STANDING[s.key].says(s.value)}.`;
}

// The instructions that stand, by key, from the standing decisions.
export function standingOf(decisions: readonly { standing?: Standing; withdrawn?: unknown }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of decisions) if (d.standing && !d.withdrawn) out.set(d.standing.key, d.standing.value);
  return out;
}
