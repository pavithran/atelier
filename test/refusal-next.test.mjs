// G8 (lessons-to-2.0, Fable assessment section 4): a refusal names the next
// command. Every RuleError code in src has a raise site that says what to run,
// unless the code is on the short exempt list below, each group with its reason.
// The claim, push, submit, land and record-merge codes are never exempt, and
// every one of their raise sites carries a next.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const EXEMPT = {
  "input validation: the detail already says what to send": [
    "acting_owner_only", "ambiguous_acting", "bad_acting", "bad_actor", "bad_agent", "bad_allow_paid",
    "bad_bookmark", "bad_branch", "bad_card", "bad_check_paths", "bad_checks", "bad_choices", "bad_claim",
    "bad_commit", "bad_contradicts", "bad_decision", "bad_declaration", "bad_delivered_by", "bad_dispatch",
    "bad_dump", "bad_event", "bad_evidence", "bad_expiry", "bad_failures", "bad_field", "bad_finding",
    "bad_findings", "bad_goal", "bad_hash", "bad_head", "bad_host", "bad_identity", "bad_item", "bad_kind",
    "bad_label", "bad_limit", "bad_list", "bad_main", "bad_mode", "bad_model", "bad_ms", "bad_name",
    "bad_note", "bad_outcome", "bad_post_merge", "bad_prepare", "bad_private", "bad_projects",
    "bad_prose_standard", "bad_quote", "bad_reason", "bad_receipt", "bad_record", "bad_ref", "bad_regenerate",
    "bad_release", "bad_replaces", "bad_report", "bad_request", "bad_request_id", "bad_reset", "bad_resolve",
    "bad_resolver", "bad_review_bar", "bad_review_tier", "bad_revision", "bad_risk_reviews", "bad_role",
    "bad_run", "bad_runner", "bad_runner_token", "bad_scope", "bad_served", "bad_session", "bad_single_family",
    "bad_status", "bad_step", "bad_summary", "bad_time", "bad_title", "bad_to", "bad_triage", "bad_usage",
    "bad_verdict", "block_reason", "block_until", "confirm_server", "defect_found_in", "defect_note",
    "override_reason", "project_mismatch", "release_current_name", "release_name_too_long", "repo_reserved",
    "too_large", "too_long", "too_many_events", "unregistered_acting",
  ],
  "an internal state, a dump or restore step, or a wrong route: the detail names the one fix and no command applies": [
    "artifacts_unavailable", "assignment_changed", "branches_repo_mismatch", "check_applies",
    "deployment_unverified", "empty", "import_in_progress", "ledger_not_empty", "no_import", "no_item",
    "no_such_payload", "no_table", "not_found", "not_rolled_back", "owner_assignment", "read_only",
    "repo_foreign", "repo_taken", "request_reused", "restore_partial", "restore_unavailable", "revert_part",
    "revoke_failed", "runner_token_required", "sandbox_removed", "schema_mismatch", "server_updating",
    "stale_attempt", "standard_project", "token_revoked", "undeclared_check", "unknown_bookmark",
    "unknown_family", "workflow_not_listening", "workflow_not_terminated", "workflow_unreadable",
    "wrong_server",
  ],
};

// The claim, push, submit, land and record-merge paths: none is exempt and no
// raise site may lack a next.
const STRICT = [
  "owned", "not_owner", "not_holder", "held", "dispatched", "not_dispatched", "post_merge_blocked", "post_merge_uncertain",
  "stale_head", "closed", "claim_in_flight", "claim_superseded", "claim_failed", "model_held", "ineligible", "single_family",
  "wrong_agent", "wrong_model", "wrong_runner", "not_submitted", "not_accepted", "accepted", "not_landable", "not_integrable",
  "integrated", "landing", "landing_lease", "landing_replaced", "landing_starting", "stale_landing", "lease_lost", "no_lease",
  "main_moved", "main_unread", "merge_open", "merge_not_on_main", "merge_unconfirmed", "not_a_merge", "no_merge_commit",
  "not_merged", "unverified_merge", "conflicts_with_main", "history_rewritten", "nothing_pushed", "no_head", "no_fork",
  "fork_changed", "workspace_changed", "branch_not_pushed", "branch_busy", "not_ready", "blocked", "stale_default_branch",
  "second_parent_differs", "ancestry_unverified", "landed", "stale_run", "stale_criteria", "stale_request", "not_independent",
  "self_review", "no_criteria", "not_open", "overlap", "no_approval", "not_approved", "acceptance_changed", "secret",
  "secret_pending", "override_unconfirmed", "override_unneeded", "not_project_owner", "not_integrator", "conflict_predicted",
  "criteria_unreviewed", "criteria_rejected", "criteria_unbound", "runner_forbidden", "task_terminal",
];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// The number of top-level arguments of the call whose "(" ends just before s[i].
function argCount(s, i) {
  const skipString = (j, quote) => {
    for (j++; s[j] !== quote; j++) {
      if (s[j] === "\\") j++;
      else if (quote === "`" && s[j] === "$" && s[j + 1] === "{") j = skipBraces(j + 2);
    }
    return j;
  };
  const skipBraces = (j) => {
    for (let d = 1; d > 0; j++) {
      if (s[j] === "{") d++;
      else if (s[j] === "}") d--;
      else if (s[j] === '"' || s[j] === "'" || s[j] === "`") j = skipString(j, s[j]);
      if (d === 0) return j;
    }
    return j;
  };
  let depth = 1, n = 1;
  for (let j = i; depth > 0 && j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") j = skipString(j, c);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 1) n++;
  }
  return n;
}

const sites = new Map(); // code -> [{ where, next }]
for (const file of files("src")) {
  const s = readFileSync(file, "utf8");
  for (const m of s.matchAll(/new RuleError\("([a-z_0-9]+)"/g)) {
    const list = sites.get(m[1]) ?? [];
    list.push({ where: `${file}:${s.slice(0, m.index).split("\n").length}`, next: argCount(s, m.index + "new RuleError(".length) >= 4 });
    sites.set(m[1], list);
  }
}
const exempt = new Map(Object.entries(EXEMPT).flatMap(([reason, codes]) => codes.map((c) => [c, reason])));

test("every RuleError code has a raise site with a next, or is exempt", () => {
  const missing = [...sites].filter(([code, list]) => !list.some((x) => x.next) && !exempt.has(code)).map(([code]) => code);
  assert.deepEqual(missing, [], `these refusals name no next command; give a raise site a next or exempt the code with a reason: ${missing.join(", ")}`);
});

test("the exempt list is honest: each entry is raised, has no next, and the list stays short", () => {
  for (const [code] of exempt) {
    assert.ok(sites.has(code), `${code} is exempt but no longer raised: remove it`);
    assert.ok(!sites.get(code).some((x) => x.next), `${code} has a next now: remove it from the exempt list`);
  }
  assert.ok(exempt.size <= 140, "the exempt list grew; give the new refusal a next");
});

test("no claim, push, submit, land or record-merge code is exempt, and each raise site names its next", () => {
  for (const code of STRICT) {
    assert.ok(sites.has(code), `${code} is not raised`);
    assert.ok(!exempt.has(code), `${code} is on the claim or landing path and cannot be exempt`);
    const bare = sites.get(code).filter((x) => !x.next).map((x) => x.where);
    assert.deepEqual(bare, [], `${code} has raise sites without a next`);
  }
});
