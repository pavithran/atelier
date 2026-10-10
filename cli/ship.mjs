// atelier ship: the project's ship order, composed from its own files, run in
// the registered checkout one step at a time, with each protected step
// allowed only by the owner's approval at the revision being shipped
// (src/actions.ts), and each step recorded on the ledger as `action.ran`.
// The push is not a protected step: ship is owner-only and runs at one exact
// revision, so --push is the owner's own act and takes no approval.
//
// The order comes from ControlPlane's ship policy when the project has one
// (docs/control-plane/ship-policy.v1.json, with project-adapter.v1.json for
// the commands and the newest canonical-device-set for the device targets),
// and otherwise from Atelier's own docs/atelier/ship.json. docs/ship.md
// describes both and the schema of the second.
//
// cli/atelier.mjs owns the server, git and the process: the ship command
// there passes them in, so this module holds the rules and stays testable.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_KINDS, KIND, approvalStatus } from "../src/actions.ts";
import { runGroup } from "./group.mjs";

export const SHIP_FILE = "docs/atelier/ship.json";
const CP = "docs/control-plane";
const CP_POLICY = `${CP}/ship-policy.v1.json`;
const CP_ADAPTER = `${CP}/project-adapter.v1.json`;
const DEVICE_SETS = [3, 2, 1].map((v) => `${CP}/canonical-device-set.v${v}.json`);

// The order for each application class, as ControlPlane's ship policy gives
// it; `other` has no delivery step.
export const ORDERS = {
  web: ["commit", "deploy", "verify-delivery", "wrap", "push"],
  installable: ["install", "verify-delivery", "commit", "wrap", "push"],
  hybrid: ["install", "verify-delivery", "commit", "deploy", "verify-delivery", "wrap", "push"],
  other: ["commit", "wrap", "push"],
};
const STEPS = new Set(["install", "deploy", "verify-delivery", "commit", "wrap", "push"]);
const RUN_SECONDS = 20 * 60, REQUEST_SECONDS = 30, TAIL = 3500, KEEP = 1024 * 1024;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const short = (sha) => (sha ? sha.slice(0, 8) : "—");
const quote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
const seconds = (v, fallback) => (Number.isInteger(v) && v > 0 && v <= 86400 ? v : fallback);

// A JSON file in the checkout: undefined when it is absent, an error naming
// it when it cannot be read or parsed.
function readJson(top, path) {
  let text;
  try { text = readFileSync(join(top, path), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw new Error(`${path} could not be read: ${error.message}`); }
  try { return JSON.parse(text); } catch (error) { throw new Error(`${path} is not valid JSON: ${error.message}`); }
}

// ── composing the order ─────────────────────────────────────────────────────

// The steps a ship runs, from the checkout at `top`. Each step is
// { step, verifies?, runs: [{ label, argv | request, status?, timeoutMs, kind }], push? }.
// A run's kind is the approval it needs, or null. `problems` lists what stops
// a ship before it runs anything; `notes` what the owner should know.
export function composeShip(top) {
  const problems = [], notes = [];
  let policy, doc;
  try { policy = readJson(top, CP_POLICY); } catch (error) { return { source: CP_POLICY, steps: [], problems: [error.message], notes }; }
  if (policy !== undefined) return controlPlaneShip(top, policy, problems, notes);
  try { doc = readJson(top, SHIP_FILE); } catch (error) { return { source: SHIP_FILE, steps: [], problems: [error.message], notes }; }
  if (doc !== undefined) return atelierShip(doc, problems, notes);
  return { source: null, steps: [], notes, problems: [`this project has no ship policy: atelier ship reads ${CP_POLICY} with ${CP_ADAPTER}, or ${SHIP_FILE}. Add ${SHIP_FILE}; docs/ship.md in Atelier gives its schema`] };
}

// ControlPlane's rule: the delivery classes the adapter declares (device,
// then deploy) are put before or after commit as the effect order says, so a
// device-only project gets the installable order and a deploy-only one the
// web order. A policy without the rule takes its application_classes row for
// the class the canonical device set names.
export function composeEffectOrder(order, declared) {
  const before = [], after = [];
  for (const name of order.precedence ?? []) {
    if (!declared.has(name)) continue;
    const spec = order.delivery?.[name];
    if (!isObject(spec) || !Array.isArray(spec.steps)) throw new Error(`${CP_POLICY}: effect_order.delivery.${name} must give its steps and position`);
    (spec.position === "before-commit" ? before : after).push(...spec.steps);
  }
  return (order.base ?? []).flatMap((step) => (step === "commit" ? [...before, "commit", ...after] : [step]));
}

function controlPlaneShip(top, policy, problems, notes) {
  if (!isObject(policy) || policy.kind !== "control-plane.ship-policy" || policy.schema_version !== 1) problems.push(`${CP_POLICY} is not a control-plane.ship-policy with schema_version 1`);
  let adapter, devices;
  try { adapter = readJson(top, CP_ADAPTER); } catch (error) { problems.push(error.message); }
  const caps = isObject(adapter?.capabilities) ? adapter.capabilities : {};
  const declared = new Set(Object.values(caps).filter(isObject).map((c) => c.action_class));
  for (const path of DEVICE_SETS) {
    try { devices = readJson(top, path); } catch (error) { problems.push(error.message); break; }
    if (devices !== undefined) { devices = { ...devices, path }; break; }
  }
  let order, cls;
  if (isObject(policy?.effect_order) && policy.effect_order.rule === "compose-from-declared-capabilities") {
    try { order = composeEffectOrder(policy.effect_order, declared); } catch (error) { problems.push(error.message); order = []; }
    cls = declared.has("device") ? (declared.has("deploy") ? "hybrid" : "installable") : declared.has("deploy") ? "web" : "other";
  } else {
    cls = devices?.application_class;
    order = policy?.application_classes?.[cls];
    if (!Array.isArray(order)) { problems.push(`${CP_POLICY} gives no order for this project: it has no effect_order to compose from, and its application_classes has no row for ${cls ? `the class ${cls}` : "a class"} (named by ${CP}/canonical-device-set)`); order = []; }
  }
  // ControlPlane pushes to the branch's tracked upstream, and never forces.
  let push = { upstream: true };
  if (policy?.push?.force === true) {
    problems.push(`${CP_POLICY} asks for a forced push, which atelier ship never does`);
    push = null;
  }
  const delivery = {
    install: () => deviceRuns(caps, devices, "install", problems, notes),
    deploy: () => Object.entries(caps).filter(([, c]) => isObject(c) && c.action_class === "deploy").sort(([a], [b]) => a.localeCompare(b))
      .map(([name]) => capabilityRun(caps, name, null, problems)).filter(Boolean),
    "verify-install": () => deviceRuns(caps, devices, "verify", problems, notes),
    "verify-deploy": () => Object.entries(caps).filter(([name, c]) => isObject(c) && c.action_class !== "device" && name.startsWith("verify")).sort(([a], [b]) => a.localeCompare(b))
      .map(([name]) => capabilityRun(caps, name, null, problems)).filter(Boolean),
  };
  const hint = {
    install: `declare a capability with "action_class": "device" whose name starts with install in ${CP_ADAPTER}, or bind one to each target of the canonical device set`,
    deploy: `declare a capability with "action_class": "deploy" in ${CP_ADAPTER}`,
    "verify-install": `declare a capability with "action_class": "device" whose name starts with verify in ${CP_ADAPTER}, or bind one to each target of the canonical device set`,
    "verify-deploy": `declare a capability whose name starts with verify and whose action_class is not device, such as "verify-deploy" running curl -fsS against the live site, in ${CP_ADAPTER}`,
  };
  return { source: CP_POLICY, class: cls, ...buildSteps(order, (field) => delivery[field](), hint, push, problems), problems, notes };
}

// The device targets ship delivers to: each required target of the newest
// canonical device set, through the capability it binds. An optional target
// (v3's "requirement": "optional") is left out and named in the notes.
// Without a device set, every device capability whose name starts with the
// step's word runs.
function deviceRuns(caps, devices, which, problems, notes) {
  const targets = Array.isArray(devices?.targets) ? devices.targets.filter(isObject) : [];
  if (!targets.length) {
    return Object.entries(caps).filter(([name, c]) => isObject(c) && c.action_class === "device" && name.startsWith(which))
      .sort(([a], [b]) => a.localeCompare(b)).map(([name]) => capabilityRun(caps, name, null, problems)).filter(Boolean);
  }
  const required = targets.filter((t) => t.requirement !== "optional");
  const optional = targets.filter((t) => t.requirement === "optional").map((t) => t.id);
  if (which === "install" && optional.length) notes.push(`optional device targets are left out, since ship delivers to required targets only: ${optional.join(", ")}`);
  return required.map((t) => {
    const name = t[`${which}_capability`];
    if (typeof name !== "string") { problems.push(`${devices.path}: target ${t.id ?? "?"} names no ${which}_capability`); return null; }
    return capabilityRun(caps, name, typeof t.selector === "string" ? t.selector : null, problems, t.id);
  }).filter(Boolean);
}

// One adapter capability as a run. A command that ends with an option takes
// the target's selector as that option's value, as MicahApp's
// `ios/bin/to-phone-adhoc.sh --device` takes the device's UDID.
function capabilityRun(caps, name, selector, problems, target) {
  const cap = caps[name];
  if (!isObject(cap) || !Array.isArray(cap.command) || !cap.command.length || cap.command.some((w) => typeof w !== "string" || !w)) {
    problems.push(`${CP_ADAPTER}: capability ${name} has no command to run`);
    return null;
  }
  const argv = [...cap.command];
  if (selector && argv.at(-1).startsWith("--")) argv.push(selector);
  return { label: `${name}${target ? ` for ${target}` : ""}`, argv, timeoutMs: seconds(cap.timeout_seconds, RUN_SECONDS) * 1000, kind: null };
}

// The steps for an order. `runsFor(field)` gives the runs for install, deploy,
// verify-install and verify-deploy; a verify-delivery step verifies the
// delivery step before it. Install and deploy runs need the approval of their
// kind, or the kind a run names.
function buildSteps(order, runsFor, hint, push, problems) {
  const steps = [];
  let delivered = null;
  for (const step of order) {
    if (!STEPS.has(step)) { problems.push(`the ship order names ${step}, a step atelier ship does not run`); continue; }
    if (step === "install" || step === "deploy") {
      delivered = step;
      const runs = runsFor(step).map((r) => ({ ...r, kind: r.kind ?? step }));
      if (!runs.length) problems.push(`the ship order has ${step} and nothing to run for it: ${hint[step]}`);
      steps.push({ step, runs });
    } else if (step === "verify-delivery") {
      if (!delivered) { problems.push("the ship order has verify-delivery with no install or deploy before it"); continue; }
      const field = `verify-${delivered}`;
      const runs = runsFor(field);
      if (!runs.length) problems.push(`the ship order verifies the ${delivered} and has nothing to run for it: ${hint[field]}`);
      steps.push({ step, verifies: delivered, runs });
    } else if (step === "push") {
      if (push) steps.push({ step, runs: [], push });
    } else steps.push({ step, runs: [] });
  }
  return { steps };
}

// Atelier's own ship file. Its schema is in docs/ship.md.
const SHIP_KEYS = new Set(["schema_version", "kind", "class", "description", "install", "verify-install", "deploy", "verify-deploy", "push"]);
const RUN_KEYS = new Set(["run", "request", "status", "timeout_seconds", "approval", "description"]);
const DELIVERY_FIELDS = { install: ["installable", "hybrid"], "verify-install": ["installable", "hybrid"], deploy: ["web", "hybrid"], "verify-deploy": ["web", "hybrid"] };

function atelierShip(doc, problems, notes) {
  if (!isObject(doc) || doc.kind !== "atelier.ship" || doc.schema_version !== 1) {
    problems.push(`${SHIP_FILE} must be an object with "kind": "atelier.ship" and "schema_version": 1`);
    return { source: SHIP_FILE, steps: [], problems, notes };
  }
  for (const key of Object.keys(doc)) if (!SHIP_KEYS.has(key)) problems.push(`${SHIP_FILE} has a field atelier ship does not read: ${key}`);
  const order = ORDERS[doc.class];
  if (!order) problems.push(`${SHIP_FILE} needs "class": web, installable, hybrid or other`);
  for (const [field, classes] of Object.entries(DELIVERY_FIELDS)) {
    if (order && doc[field] !== undefined && !classes.includes(doc.class)) problems.push(`${SHIP_FILE} gives ${field}, which a ${doc.class} project's order has no step for`);
  }
  let push = { upstream: true };
  if (doc.push !== undefined) {
    const named = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(v) && !v.includes("..");
    if (isObject(doc.push) && named(doc.push.remote) && named(doc.push.branch) && Object.keys(doc.push).every((k) => k === "remote" || k === "branch")) push = { remote: doc.push.remote, branch: doc.push.branch };
    else { problems.push(`${SHIP_FILE} "push" must be {"remote": NAME, "branch": NAME}, or left out to push to the branch's tracked upstream`); push = null; }
  }
  const hint = Object.fromEntries(["install", "deploy", "verify-install", "verify-deploy"].map((f) => [f, `give "${f}" in ${SHIP_FILE}`]));
  return { source: SHIP_FILE, class: doc.class, ...buildSteps(order ?? [], (field) => parseRuns(doc[field], field, problems), hint, push, problems), problems, notes };
}

// One run, or a list of them: {"run": [argv...]} or {"request": URL, "status": 200},
// each with an optional timeout_seconds and approval kind.
function parseRuns(value, field, problems) {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list.map((r, i) => {
    const where = `${SHIP_FILE} ${field}${list.length > 1 ? `[${i}]` : ""}`;
    if (!isObject(r)) { problems.push(`${where} must be an object`); return null; }
    for (const key of Object.keys(r)) if (!RUN_KEYS.has(key)) { problems.push(`${where} has a field atelier ship does not read: ${key}`); return null; }
    if (r.approval !== undefined && (typeof r.approval !== "string" || !KIND.test(r.approval))) { problems.push(`${where} "approval" must be a kind such as deploy or photos-writeback`); return null; }
    const kind = r.approval ?? null;
    if (r.run !== undefined && r.request === undefined) {
      if (!Array.isArray(r.run) || !r.run.length || r.run.some((w) => typeof w !== "string" || !w)) { problems.push(`${where} "run" must be the command and its arguments, as a list of strings`); return null; }
      return { label: r.run.map(quote).join(" "), argv: [...r.run], timeoutMs: seconds(r.timeout_seconds, RUN_SECONDS) * 1000, kind };
    }
    if (r.request !== undefined && r.run === undefined) {
      let url;
      try { url = new URL(r.request); } catch { /* refused below */ }
      if (!url || !["https:", "http:"].includes(url.protocol)) { problems.push(`${where} "request" must be an http or https URL`); return null; }
      const status = r.status ?? 200;
      if (!Number.isInteger(status) || status < 100 || status > 599) { problems.push(`${where} "status" must be an HTTP status, such as 200`); return null; }
      return { label: `GET ${r.request}, expecting ${status}`, request: r.request, status, timeoutMs: seconds(r.timeout_seconds, REQUEST_SECONDS) * 1000, kind };
    }
    problems.push(`${where} needs "run" or "request", not both`);
    return null;
  }).filter(Boolean);
}

// The kinds a project's own files name, beside the five Atelier knows: each
// approval kind its ship order needs, and its adapter's capability names and
// action classes. `atelier approve` refuses any other kind, which would match
// nothing ship runs.
export function knownKinds(top) {
  const kinds = new Set(ACTION_KINDS);
  if (!top) return kinds;
  const plan = composeShip(top);
  for (const s of plan.steps) for (const r of s.runs) if (r.kind) kinds.add(r.kind);
  try {
    const caps = readJson(top, CP_ADAPTER)?.capabilities;
    if (isObject(caps)) for (const [name, c] of Object.entries(caps)) {
      if (KIND.test(name)) kinds.add(name);
      if (isObject(c) && typeof c.action_class === "string" && KIND.test(c.action_class)) kinds.add(c.action_class);
    }
  } catch { /* an unreadable adapter names nothing */ }
  return kinds;
}

// What the project's policy records of its ship order, read from the checkout
// at init and sync: the commands its runs execute, as one line each, so the
// gate can guard the files they run like a check's (checkFiles in
// src/rules.ts), and the approval kinds the order needs unconditionally
// (install, deploy and the kinds runs name; push needs one only with --push),
// which the inbox reads to say a merged revision is not delivered
// (unrunKinds in src/actions.ts).
export function shipPolicy(top) {
  const plan = composeShip(top);
  return {
    runs: plan.steps.flatMap((s) => s.runs).filter((r) => r.argv).map((r) => r.argv.join(" ")),
    kinds: neededKinds(plan.steps, false),
  };
}

// ── approvals ───────────────────────────────────────────────────────────────

// The approval kinds a ship needs, in order: each install or deploy step's,
// and any a run names. Push needs none: ship is run by the owner alone, at one
// exact revision of the main line, and --push is the owner's own act there
// (PAVI's decision of 2026-10-06).
export function neededKinds(steps) {
  const kinds = [];
  for (const s of steps) {
    if (s.step === "push") continue;
    for (const k of s.runs.map((r) => r.kind).filter(Boolean)) if (!kinds.includes(k)) kinds.push(k);
  }
  return kinds;
}

// The approval a run would use: the oldest active one for the kind at the revision.
export function approvalFor(approvals, kind, commit, now = new Date().toISOString()) {
  return approvals.filter((a) => a.kind === kind && a.commit === commit && approvalStatus(a, now) === "active").at(-1) ?? null;
}

const at = (iso) => `${String(iso).slice(0, 16).replace("T", " ")} UTC`;

// What `atelier approvals` prints: one line per approval.
export function formatApprovals(approvals) {
  return approvals.map((a) => {
    const when = a.status === "active" ? `active until ${at(a.expiresAt)}`
      : a.status === "consumed" ? `used ${at(a.consumed.at)}`
        : a.status === "withdrawn" ? `withdrawn ${at(a.withdrawn.at)}${a.withdrawn.note ? ` (${a.withdrawn.note})` : ""}`
          : `expired ${at(a.expiresAt)}`;
    return `${a.id.padEnd(4)} ${a.kind.padEnd(16)} ${short(a.commit)}  ${when}  approved ${at(a.at)}${a.note ? `  note: ${a.note}` : ""}`;
  }).join("\n");
}

// ── the plan, as text ───────────────────────────────────────────────────────

const pushLabel = (t, branch) => `git push --no-force ${quote(t.remote)} refs/heads/${branch}:refs/heads/${t.branch}`;

// What `atelier ship --dry-run` prints, and what ship prints before it runs:
// each step, what it runs, and each approval it needs, present or missing.
export function formatPlan({ name, plan, branch, head, commit, approvals, push, target, refusals = [] }) {
  const lines = [`Ship ${name} at ${branch} @ ${short(head)}${commit !== head ? ` (on the baseline as ${short(commit)})` : ""}, from ${plan.source ?? "no ship file"}${plan.class ? `, class ${plan.class}` : ""}:`];
  plan.steps.forEach((s, i) => {
    const n = `  ${i + 1}. ${s.step.padEnd(17)}`;
    if (s.step === "commit") lines.push(`${n}nothing to run: the checkout is clean at the revision being shipped; wrap commits what later steps change`);
    else if (s.step === "wrap") lines.push(`${n}atelier wrap, committing what the steps changed and recording the session`);
    else if (s.step === "push") {
      const what = target ? pushLabel(target, branch) : "git push to the branch's tracked upstream";
      lines.push(push ? `${n}${what}  (no approval: the owner's own act at this revision)` : `${n}not run without --push (${what})`);
    } else {
      s.runs.forEach((r, j) => lines.push(`${j ? " ".repeat(n.length) : n}${r.argv ? r.argv.map(quote).join(" ") : r.label}${r.kind ? `  ${approvalText(approvals, r.kind, commit)}` : ""}`));
      if (!s.runs.length) lines.push(`${n}nothing to run`);
    }
  });
  for (const note of plan.notes) lines.push(`Note: ${note}`);
  for (const problem of [...plan.problems, ...refusals]) lines.push(`Refused: ${problem}`);
  return lines.join("\n");
}

function approvalText(approvals, kind, commit) {
  const a = approvalFor(approvals, kind, commit);
  return a ? `[${kind}: approved as ${a.id} until ${at(a.expiresAt)}]` : `[${kind}: no approval at this revision]`;
}

// The commands that approve what is missing, one per kind. Push is never
// among them: --push takes no approval.
export function missingApprovals({ name, plan, approvals, commit }) {
  return neededKinds(plan.steps).filter((k) => !approvalFor(approvals, k, commit))
    .map((k) => `atelier approve ${k} --head ${commit} --project ${quote(name)}`);
}

// ── running ─────────────────────────────────────────────────────────────────

// Values that must not reach the record: the ones given, and every variable in
// the environment whose name says it holds a token, a key, a secret, a password
// or a credential (as checkEnv in cli/atelier.mjs reads names), when it is long
// enough to be one.
const SECRET_NAME = /token|secret|passw|credential|auth|key|otp/i;
export function shipSecrets(env, given = []) {
  return [...given, ...Object.entries(env).filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= 8).map(([, v]) => v)].filter(Boolean);
}

// A step's command runs with the owner's environment, which a deploy needs for
// its own credentials, less Atelier's own variables: no step needs the owner's
// Atelier token.
export function stepEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("ATELIER_")));
}

// Runs argv with no shell, in `cwd`, showing its output as it comes and
// keeping the last megabyte of it. It leads a process group of its own
// (runGroup in cli/group.mjs), which is SIGKILLed whole when it exits and
// when `timeoutMs` passes, so a smoke check's server or test process does
// not outlive it (t419).
export async function runCommand(argv, { cwd, env, timeoutMs, out = process.stdout, err = process.stderr }) {
  const started = Date.now();
  let output = "";
  const onData = (key, s) => { (key === "stdout" ? out : err).write(s); output = (output + s).slice(-KEEP); };
  const r = await runGroup(argv, { cwd, env, timeoutMs, onData });
  const durationMs = Date.now() - started;
  const why = r.timedOut ? `ended by SIGKILL with its process group after its ${Math.round(timeoutMs / 1000)}s timeout`
    : r.signal ? `ended by ${r.signal}`
    : r.error ? `could not run ${argv[0]}: ${r.error.message}` : null;
  const status = r.error && !r.signal && !r.timedOut ? null : r.status;
  return { status, signal: r.signal ?? null, output: why ? `${output}\n[atelier] ${why}` : output, durationMs, passed: !r.error && r.status === 0 };
}

// A GET of the URL, following redirects, that must end with the status.
export async function runRequest(run) {
  const started = Date.now();
  try {
    const res = await fetch(run.request, { redirect: "follow", signal: AbortSignal.timeout(run.timeoutMs) });
    await res.body?.cancel();
    const moved = res.url && res.url !== run.request ? ` at ${res.url}` : "";
    return { status: null, signal: null, durationMs: Date.now() - started, passed: res.status === run.status, output: `${run.request} answered ${res.status}${moved}; expected ${run.status}` };
  } catch (error) {
    return { status: null, signal: null, durationMs: Date.now() - started, passed: false, output: `${run.request} could not be reached: ${error.message}` };
  }
}

// Ship itself. `ctx` holds what cli/atelier.mjs owns:
//   name, cwd, branch          the project and its registered checkout and branch
//   baselineHead               the baseline's head, read from the server
//   paired(baselineHead)       the checkout commit the baseline's head stands for
//   inProgress()               operations under way in the checkout, in words
//   git(args, opts)            git in the checkout; opts.allowFail returns the result
//   request(method, path, body) the server, as the owner; a refusal ends the command
//   stage(text)                names the step a refusal ends, or clears it with null
//   fail(message)              ends the command with the message
//   print(line)                standard output
//   wrap(summary)              runs atelier wrap in the checkout: { status, output, durationMs }
//   env, secrets, redact       the environment, the values to cut and the cutter
//   dryRun, push               the flags
export async function ship(ctx) {
  const { name, cwd, branch, git, request, print, fail } = ctx;
  const P = `/projects/${encodeURIComponent(name)}`;
  const refusals = [];
  const current = git(["branch", "--show-current"], { cwd });
  if (current !== branch) refusals.push(`${current ? `${current} is checked out` : "HEAD is detached"}; ship runs on ${branch}, the registered branch: git checkout ${branch}`);
  for (const what of ctx.inProgress()) refusals.push(`${what} is in progress; finish or abort it first`);
  const dirty = git(["status", "--porcelain", "--untracked-files=all"], { cwd });
  if (dirty) refusals.push("the checkout has uncommitted changes, and ship runs only on a clean checkout; commit them with atelier wrap, or set them aside, then ship again");
  const head = git(["rev-parse", "HEAD"], { cwd });
  const commit = ctx.baselineHead;
  if (!commit) refusals.push("the baseline has no commits yet; run atelier init in the checkout first");
  else if (ctx.paired(commit) !== head) refusals.push(`HEAD ${short(head)} is not the baseline's head ${short(commit)}; ship runs only the revision Atelier holds. Merge with atelier merge, publish with atelier wrap, or check out the baseline's head, then ship again`);
  const plan = composeShip(cwd);
  let target = null;
  const pushStep = plan.steps.find((s) => s.step === "push");
  if (pushStep) {
    try { target = resolvePush(pushStep.push, { git, cwd, branch }); }
    catch (error) { if (ctx.push) refusals.push(error.message); }
  }
  const { approvals } = commit ? await request("GET", `${P}/actions`) : { approvals: [] };
  // A dry run lists what would refuse beside the steps; a ship stops on it.
  print(formatPlan({ name, plan, branch, head, commit: commit ?? head, approvals, push: ctx.push, target, refusals: ctx.dryRun ? refusals : [] }));
  const missing = commit ? missingApprovals({ name, plan, approvals, commit }) : [];
  if (ctx.dryRun) {
    if (missing.length) print(`Missing approvals; ${name}'s owner gives them at this revision with:\n${missing.map((c) => `  ${c}`).join("\n")}`);
    print("Dry run: nothing was run, approved or recorded.");
    return;
  }
  const stops = [...plan.problems, ...refusals];
  if (stops.length) fail(`ship refused before running anything:\n${stops.map((p) => `  ${p}`).join("\n")}`);
  if (missing.length) fail(`ship refused before running anything: ${missing.length === 1 ? "an approval is" : "approvals are"} missing at ${short(commit)}. The project owner approves with:\n${missing.map((c) => `  ${c}`).join("\n")}\nthen runs atelier ship again.`);

  const id = `s-${Date.now().toString(36)}`;
  const ran = [];
  const record = (step, r, extra) => request("POST", `${P}/actions/runs`, {
    step, kind: r.kind ?? null, approval: r.approval ?? null, command: r.command ?? null, commit,
    exitStatus: r.status ?? null, signal: r.signal ?? null, durationMs: r.durationMs ?? 0, passed: r.passed,
    outputTail: ctx.redact(r.output ?? "", ctx.secrets).slice(-TAIL), ship: id, note: extra ?? "",
  });
  const rest = (from) => plan.steps.slice(from).map((s) => s.step).filter((s) => s !== "push" || ctx.push);
  for (const [i, s] of plan.steps.entries()) {
    if (s.step === "push" && !ctx.push) continue;
    ctx.stage(`ship at ${s.step}`);
    // Each kind this step needs takes its approval now, before anything of
    // the step runs: one approval, one run. The push needs none: it is the
    // owner's own act at the exact revision being shipped.
    const used = {};
    for (const kind of [...new Set(s.runs.map((r) => r.kind).filter(Boolean))]) {
      used[kind] = (await request("POST", `${P}/actions/consume`, { kind, commit })).id;
      print(`${s.step}: using approval ${used[kind]} for ${kind} at ${short(commit)}.`);
    }
    const results = [];
    if (s.step === "commit") {
      const left = git(["status", "--porcelain", "--untracked-files=all"], { cwd });
      results.push({ passed: true, durationMs: 0, note: left ? "the steps before changed the checkout; wrap commits what they changed" : `nothing to commit: the checkout is clean at ${short(head)}` });
    } else if (s.step === "wrap") {
      const summary = `Ship ${short(commit)}: ${ran.length ? ran.join(", ") : "nothing delivered"}`;
      // What wrap prints next speaks for the wrap alone: its "not pushed" and
      // "nothing deployed" lines are about what wrap itself did.
      print(`wrap: running atelier wrap ${quote(summary)}; its own output follows`);
      const r = await ctx.wrap(summary);
      results.push({ ...r, command: `atelier wrap ${quote(summary)}`, passed: r.status === 0 });
    } else if (s.step === "push") {
      const started = Date.now();
      const label = pushLabel(target, branch);
      const r = git(["-c", `remote.${target.remote}.mirror=false`, "push", "--no-force", "--no-follow-tags", target.remote, `refs/heads/${branch}:refs/heads/${target.branch}`], { cwd, allowFail: true, ownerRemote: true });
      const now = git(["rev-parse", "HEAD"], { cwd });
      const listed = r.status === 0 ? git(["ls-remote", target.remote, `refs/heads/${target.branch}`], { cwd, allowFail: true, ownerRemote: true }) : null;
      const holds = listed?.status === 0 && listed.stdout.split(/\s/)[0] === now;
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.status === 0 && !holds ? `\n[atelier] ${target.remote} does not show ${short(now)} on ${target.branch} after the push` : ""}`;
      results.push({ command: label, status: r.status, signal: r.signal ?? null, durationMs: Date.now() - started, passed: r.status === 0 && holds, output, kind: null, approval: null, note: `pushed ${short(now)}` });
    } else {
      for (const run of s.runs) {
        print(`${s.step}: ${run.argv ? `running ${run.argv.map(quote).join(" ")}` : run.label}`);
        const r = run.argv ? await runCommand(run.argv, { cwd, env: stepEnv(ctx.env), timeoutMs: run.timeoutMs }) : await runRequest(run);
        const result = { ...r, command: run.argv ? run.argv.map(quote).join(" ") : run.label, kind: run.kind, approval: run.kind ? used[run.kind] : null, note: s.verifies ? `verifies the ${s.verifies}` : "" };
        results.push(result);
        if (!run.argv) print(`${s.step}: ${r.output}`);
        if (!r.passed) break;
      }
    }
    for (const r of results) {
      await record(s.step, r, r.note);
      print(`${s.step}: ${r.passed ? "passed" : "FAILED"}${r.command ? `: ${r.command}` : ""}${r.status !== null && r.status !== undefined ? `, exit ${r.status}` : ""}${r.durationMs ? ` in ${(r.durationMs / 1000).toFixed(1)}s` : ""}${r.note ? ` (${r.note})` : ""}. Recorded.`);
    }
    ctx.stage(null);
    const failed = results.find((r) => !r.passed);
    if (failed) {
      const usedText = Object.entries(used).map(([k, a]) => `${a} for ${k}`).join(", ");
      fail([
        `ship stopped at ${s.step}: ${failed.command ?? s.step} ${failed.signal ? `ended by ${failed.signal}` : failed.status !== null && failed.status !== undefined ? `exited ${failed.status}` : "failed"}.`,
        `Ran before it: ${ran.join(", ") || "nothing"}. Not run: ${rest(i + 1).join(", ") || "nothing"}. Each step that ran is recorded on the ledger.`,
        usedText ? `The approval used here (${usedText}) is spent; after fixing the cause, the owner approves again: ${Object.keys(used).map((k) => `atelier approve ${k} --head ${commit} --project ${quote(name)}`).join(" and ")}` : "",
      ].filter(Boolean).join("\n"));
    }
    ran.push(s.step);
  }
  print(`Shipped ${name} at ${short(commit)}: ${ran.join(", ")} ran, each recorded on the ledger.`);
  if (pushStep && !ctx.push) {
    print(target
      ? `Not pushed (no --push). To push this revision, run atelier ship --push, or push by hand: git -C ${quote(cwd)} ${pushLabel(target, branch)}`
      : "Not pushed (no --push), and the branch has no push target ship can use.");
  }
}

// Where push goes: the remote and branch the ship file names, or the
// branch's tracked upstream. Nothing is created or repaired: a missing remote
// or upstream is refused, naming what to set.
export function resolvePush(target, { git, cwd, branch }) {
  const remotes = git(["remote"], { cwd }).split("\n").filter(Boolean);
  if (target.remote) {
    if (!remotes.includes(target.remote)) throw new Error(`the checkout has no remote called ${target.remote}, which ${SHIP_FILE} names to push to; ship never adds one`);
    return { remote: target.remote, branch: target.branch };
  }
  const remote = git(["config", "--get", `branch.${branch}.remote`], { cwd, allowFail: true }).stdout?.trim();
  const merge = git(["config", "--get", `branch.${branch}.merge`], { cwd, allowFail: true }).stdout?.trim();
  if (!remote || remote === "." || !merge?.startsWith("refs/heads/") || !remotes.includes(remote)) {
    throw new Error(`${branch} has no tracked upstream on a remote to push to; set one with git branch --set-upstream-to=REMOTE/BRANCH ${branch}, or name "push" in ${SHIP_FILE}`);
  }
  return { remote, branch: merge.slice("refs/heads/".length) };
}
