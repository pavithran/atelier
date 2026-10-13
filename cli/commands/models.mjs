// atelier models. Its forms, flags and help are declared in src/usage/commands/models.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_USAGE } from "../help.mjs";
import { OWNER, args, at, call, die, project, serverVersion } from "../atelier.mjs";
import { cleanCard, cleanCardModel, cleanWithdrawal, conditionText } from "../../src/models/cards.ts";
import { modelKey } from "../../src/rules.ts";

// The model pool. With no subcommand, lists it. `models add ID --harness H
// --where home|cloud [--provider P] [--endpoint URL] [--keychain NAME]
// [--alias A]... [--note TEXT]` adds or replaces an entry; `models remove ID`
// removes one; `models note ID 'text' [--item tN]` keeps a dated note under
// it, and `models show ID` prints it with its notes and its vendor cards;
// `models card [ID] [--file FILE]` records vendor cards, read as JSON from the
// file or standard input (t625). Keys stay in the Keychain; only the entry's
// name is sent.
export default async function modelsCommand() {
  const [sub, id, text] = args._.slice(1);
  const modelLine = (m) => {
    const s = m.status ? `${m.status.state} ${m.status.at.slice(0, 16)}Z${m.status.served && m.status.served !== m.id ? ` as ${m.status.served}` : ""}` : "not checked";
    const held = m.state && m.state !== "available" ? `  ${m.state} since ${(m.stateAt ?? m.addedAt).slice(0, 16)}Z` : "";
    const roles = m.roles?.length ? `  roles: ${m.roles.join(",")}` : "";
    const tier = m.tier ? `  tier: ${m.tier}` : "";
    return `${m.where.padEnd(5)} ${m.harness}/${m.id}  ${m.family}  ${s}${m.keychain ? `  key: ${m.keychain}` : ""}${held}${roles}${tier}`;
  };
  const taskOf = (n) => (n.project ? `${n.projectName ?? n.project}/${n.item}` : n.item);
  const noteLines = (m) => (m.notes ?? []).map((n) => `  ${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${taskOf(n)}` : ""}: ${n.text}`);
  const entryNotes = (m) => { const lines = noteLines(m); return lines.length ? lines : ["  No notes yet. Add one: atelier models note ID 'text'"]; };
  if (sub === "admit" || sub === "withdraw") {
    if (!id || !args.reason) die(`atelier models ${sub} ID --project NAME --reason TEXT`);
    const name = project();
    const record = await call(sub === "admit" ? "PUT" : "DELETE", `/projects/${encodeURIComponent(name)}/reviewers/${encodeURIComponent(id)}`, { reason: args.reason }, OWNER);
    return console.log(`${record.id}: reviewer ${record.active ? "admitted" : "withdrawn"} in ${name} by ${record.by} at ${record.at}: ${record.reason}`);
  }
  if (sub === "reviewers") {
    const name = project();
    const records = await call("GET", `/projects/${encodeURIComponent(name)}/reviewers`, undefined, OWNER);
    for (const record of records) console.log(`${record.id}: ${record.active ? "admitted" : "withdrawn"} by ${record.by} at ${record.at}: ${record.reason}`);
    if (!records.length) console.log(`No reviewer admissions in ${name}.`);
    return;
  }
  if (sub === "add") {
    if (!id) die("atelier models add ID --harness H --where home|cloud");
    for (const k of ["key", "api-key", "token"]) if (args[k] !== undefined) die("Atelier never stores keys; put the key in your Keychain and give its entry's name with --keychain");
    const entry = await call("PUT", `/models/${encodeURIComponent(id)}`, {
      harness: args.harness, where: args.where, provider: args.provider, endpoint: args.endpoint,
      keychain: args.keychain, aliases: args.multi.alias ?? [], note: args.note,
      state: args.state, roles: args.roles, tier: args.tier,
    }, OWNER);
    const unreached = entry.unreached?.length ? `\nWarning: could not reach projects ${entry.unreached.join(", ")}` : "";
    return console.log(`${entry.id} is in the pool: ${entry.harness}, ${entry.where}, ${entry.provider}${entry.keychain ? `, key in Keychain ${entry.keychain}` : ""}; family ${entry.family}.${unreached}`);
  }
  if (sub === "set") {
    if (!id) die("atelier models set ID --state paused|reserved|available [--note TEXT] [--roles build,review,plan] [--tier frontier|execution|budget]");
    if (args.state === undefined && args.note === undefined && args.roles === undefined && args.tier === undefined) {
      die("atelier models set ID changes one of --state, --note, --roles or --tier; name at least one");
    }
    const entry = await call("POST", `/models/${encodeURIComponent(id)}/set`, {
      state: args.state, note: args.note, roles: args.roles, tier: args.tier,
    }, OWNER);
    const state = entry.state && entry.state !== "available" ? ` ${entry.state}${entry.stateAt ? ` since ${entry.stateAt.slice(0, 16)}Z` : ""}` : "";
    const roles = entry.roles?.length ? ` roles ${entry.roles.join(",")}` : "";
    const tier = entry.tier ? ` tier ${entry.tier}` : "";
    const unreached = entry.unreached?.length ? `\nWarning: could not reach projects ${entry.unreached.join(", ")}` : "";
    return console.log(`${entry.id}:${state}${roles}${tier}${entry.note ? ` (${entry.note})` : ""}.${unreached}`);
  }
  if (sub === "remove") {
    if (!id) die("atelier models remove ID");
    const { removed, unreached: ur } = await call("DELETE", `/models/${encodeURIComponent(id)}`, undefined, OWNER);
    const unreached = ur?.length ? `\nWarning: could not reach projects ${ur.join(", ")}` : "";
    return console.log((removed ? `${id} is no longer in the pool.` : `${id} was not in the pool.`) + unreached);
  }
  if (sub === "note") {
    if (!id || args._.length !== 4) die("atelier models note ID 'text' [--item tN]");
    const body = args.item === undefined ? { text } : { text, item: args.item, project: project() };
    const note = await call("POST", `/models/${encodeURIComponent(id)}/notes`, body, OWNER);
    return console.log(`${id} has a new note, ${note.at.slice(0, 10)} by ${note.by}${note.item ? ` on ${taskOf(note)}` : ""}: ${note.text}`);
  }
  if (sub === "card") return cardCommand(id);
  if (sub === "show") {
    if (!id) die("atelier models show ID");
    // A model the pool does not have may still have vendor cards.
    const viewOf = (name) => call("GET", `/models/${encodeURIComponent(name)}/cards`, undefined, OWNER);
    let cards = (await serverVersion())?.capabilities?.includes("models.card.v1") ? await viewOf(id) : null;
    const pool = await call("GET", "/models", undefined, OWNER);
    const entryName = (e) => `${e.harness}/${e.id}`;
    if (!cards) {
      // No cards to attribute: the entry by its id, an alias or harness/id.
      const m = pool.find((e) => e.id === id) ?? pool.find((e) => [e.id, ...(e.aliases ?? []), entryName(e)].includes(id));
      if (!m) die(`${id} is not in the pool`);
      for (const line of [modelLine(m), ...entryNotes(m)]) console.log(line);
      return console.log("  Vendor cards: this server does not have models.card.v1 yet; deploy it to record and show them.");
    }
    // Cards belong to the key the server gives the name (modelKey), and the
    // entries shown beside them are the ones the server says are that model
    // (view.pool), never an entry found here by a pool alias: an alias moved
    // to another model would print one model's cards under another's entry
    // (Astra's fifth review of t625, 2026-10-13, finding 2). A name that is
    // only a pool alias is followed to its entry's own name, and the answer
    // says so and which key it shows.
    const aliasOf = (view) => pool.filter((e) => (e.aliases ?? []).some((a) => modelKey(a) === modelKey(id)) && !view.pool.includes(entryName(e)));
    let others = aliasOf(cards);
    if (!cards.cards.length && !cards.pool.length && others.length === 1) {
      const [e] = others;
      cards = await viewOf(entryName(e));
      console.log(`${id} is a pool alias of ${entryName(e)}; cards are kept under a model's own name, so these are the cards kept under ${cards.model}.`);
      others = [];
    }
    const entries = pool.filter((e) => cards.pool.includes(entryName(e)));
    if (!entries.length && !cards.cards.length && !others.length) die(`${id} is not in the pool and has no vendor cards`);
    if (!entries.length && !cards.cards.length) {
      return console.log(`${id} is a pool alias of ${others.map(entryName).join(" and ")}; cards are kept under each model's own name: atelier models show ${entryName(others[0])}`);
    }
    for (const m of entries) for (const line of [modelLine(m), ...entryNotes(m)]) console.log(line);
    if (!entries.length) console.log(`${id} is not in the pool; its vendor cards are kept under ${cards.model}.`);
    for (const line of cardLines(cards)) console.log(line);
    for (const e of others) console.log(`  ${id} is also a pool alias of ${entryName(e)}, whose cards are kept under its own name: atelier models show ${entryName(e)}`);
    return;
  }
  if (sub) die(`${COMMAND_USAGE.models}
unknown models command "${sub}"; use add, set, remove, note, card, show, admit, withdraw, reviewers, or nothing to list`);
  const pool = await call("GET", "/models", undefined, OWNER);
  if (args.json) return console.log(JSON.stringify(pool, null, 2));
  if (!pool.length) return console.log("The pool is empty. Add a model: atelier models add ID --harness H --where home|cloud");
  for (const m of pool) console.log([modelLine(m), ...noteLines(m)].join("\n"));
}

// A model's vendor cards as `models show` prints them, oldest first: each
// card's source, dates and state, its claims with their conditions, its
// limitations, then the claims that disagree, and the registry's priors,
// which are not cards. None of it is an Atelier measurement.
const scoreText = (score, unit) => `${score}${unit === "%" ? "%" : ` ${unit}`}`;
const benchText = (c) => `${c.benchmark}${c.version ? ` ${c.version}` : ""}`;
const underText = (conditions) => (conditionText(conditions) ? ` (${conditionText(conditions)})` : "");
export function cardLines(view) {
  const out = [];
  if (!view.cards.length) out.push("  No vendor cards yet. Record one: atelier models card ID --file card.json");
  for (const card of view.cards) {
    const state = card.state === "active" ? "" : ` [${card.state} by ${card.endedBy} ${card.endedAt.slice(0, 10)}${card.endReason ? `: ${card.endReason}` : ""}]`;
    const replaces = card.corrects ? `, corrects ${card.corrects}` : card.supersedes ? `, supersedes ${card.supersedes}` : "";
    out.push(`  Vendor card ${card.id}${state}: ${card.vendor ? `${card.vendor}, ` : ""}${card.title ?? card.source}, published ${card.published ?? "(no date given)"}, read ${card.read} by ${card.by}${replaces}${card.reason ? ` (${card.reason})` : ""}`);
    if (card.title) out.push(`    ${card.source}`);
    for (const c of card.claims) out.push(`    ${benchText(c)}: ${scoreText(c.score, c.unit)}${underText(c.conditions)}`);
    for (const l of card.limitations) out.push(`    Limitation: ${l}`);
  }
  for (const d of view.disagreements) {
    const each = d.claims.map((c) => `${c.card} ${scoreText(c.score, d.unit)}${underText(c.conditions)}`).join(", ");
    out.push(d.kind === "conflict"
      ? `  Conflict, ${benchText(d)} under the same conditions: ${each}`
      : `  ${benchText(d)} differs under different conditions, not a conflict: ${each}`);
  }
  for (const p of view.priors) out.push(`  Prior (the registry's, not a card): ${p.claim}; ${p.source}`);
  return out;
}

// `models card [ID] [--file FILE]`: one card or a list, as JSON, from the
// file or standard input. A card names its model with "model" or takes ID.
// Each is checked here before any is sent, so a mistake in the tenth sends
// none; one sent again is answered with the card already recorded, so a
// list can be sent again after a failure. `--withdraw cN --reason TEXT`
// withdraws a card instead.
const CARD_USAGE = "atelier models card [ID] [--file FILE], or atelier models card ID --withdraw cN --reason TEXT";
const withdrawnLine = (record, retried, view) =>
  `${record.withdraws} ${retried ? "was already withdrawn" : "is withdrawn"} from ${view.model}'s cards by ${record.id}: ${record.reason}`;
async function cardCommand(id) {
  if (args._.length > 3) die(CARD_USAGE);
  if (args.withdraw !== undefined) {
    if (!id || args.reason === undefined || args.file !== undefined) die(CARD_USAGE);
    const body = { withdraws: args.withdraw, reason: args.reason };
    try { cleanCardModel(id); cleanWithdrawal(body); } catch (e) { die(e.detail ?? e.message); }
    const { record, retried, view } = await call("POST", `/models/${encodeURIComponent(id)}/cards`, body, OWNER);
    return console.log(withdrawnLine(record, retried, view));
  }
  if (args.reason !== undefined) die(`--reason goes with --withdraw; a correction gives its reason in the card's "reason". ${CARD_USAGE}`);
  if (args.file === undefined && process.stdin.isTTY) die(`${CARD_USAGE}\ngive the card as JSON with --file FILE or on standard input`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(args.file ?? 0, "utf8")); } catch (e) { die(`the card is not JSON: ${e.message}`); }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) die("the list holds no cards");
  const today = new Date().toISOString().slice(0, 10);
  const sends = list.map((card, i) => {
    const where = list.length > 1 ? `card ${i + 1}: ` : "";
    if (typeof card !== "object" || card === null || Array.isArray(card)) die(`${where}a card is a JSON object`);
    const { model, ...body } = card;
    if (id && model !== undefined && model !== id) die(`${where}names ${model}, not ${id}`);
    const named = id ?? model;
    if (typeof named !== "string" || !named) die(`${where}names no model; give "model" in the card or ID on the command line`);
    try {
      cleanCardModel(named);
      if ("withdraws" in body) cleanWithdrawal(body); else cleanCard(body, today);
    } catch (e) { die(`${where}${e.detail ?? e.message}`); }
    return { named, body };
  });
  for (const { named, body } of sends) {
    const { record, retried, view } = await call("POST", `/models/${encodeURIComponent(named)}/cards`, body, OWNER);
    if (record.kind === "withdrawal") { console.log(withdrawnLine(record, retried, view)); continue; }
    // A name neither the registry nor the pool knows is kept under its normalised key, said here.
    const pool = view.pool.length ? ` (${view.pool.join(", ")})` : view.known === false ? ", a name neither the registry nor the pool knows, kept as it is" : ", which is not in the pool";
    const replaces = record.corrects ? `, correcting ${record.corrects}` : record.supersedes ? `, superseding ${record.supersedes}` : "";
    const claims = `${record.claims.length} claim${record.claims.length === 1 ? "" : "s"}`;
    console.log(retried
      ? `${record.id} was already recorded for ${view.model}${pool}; nothing added.`
      : `${record.id} recorded for ${view.model}${pool}: ${claims} from ${record.source}, read ${record.read}${replaces}.`);
    for (const d of view.disagreements.filter((d) => d.kind === "conflict" && d.claims.some((c) => c.card === record.id))) {
      console.log(`  Conflict, ${benchText(d)} under the same conditions: ${d.claims.map((c) => `${c.card} ${scoreText(c.score, d.unit)}`).join(", ")}; both stay on show.`);
    }
  }
}
