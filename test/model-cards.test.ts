import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  admitCardRecord, cardDisagreements, cardEvidence, cardFiling, cardView, modelCardView, newCardRecord, cleanCard, cleanCardModel, cleanWithdrawal,
  type CardInput, type CardRecord, type ModelCard, type ShownCard,
} from "../src/models/cards.ts";
import { MODEL_PROFILES } from "../src/models/registry.ts";

// Vendor model cards (t625): what a card must carry, how it is checked, how
// corrections, supersessions and withdrawals end a card without losing it,
// what a retry does, and which claims conflict.

const TODAY = "2026-10-13";
const CARD = {
  vendor: "Example Labs",
  title: "Example 5 system card",
  source: "https://vendor.example/example-5-card",
  published: "2026-09-30",
  read: "2026-10-13",
  claims: [
    { benchmark: "SWE-bench Pro", version: "public", score: 61.2, unit: "%", taskKind: "repository", conditions: { harness: "vendor scaffold", effort: "max", details: ["averaged over 5 trials"] } },
    { benchmark: "Terminal-Bench", version: "2.1", score: 70, unit: "%" },
  ],
  limitations: ["Over-eager on long agentic tasks."],
};

test("a card keeps its source, dates, claims with their conditions, and limitations", () => {
  const card = cleanCard(structuredClone(CARD), TODAY);
  assert.deepEqual(card, {
    kind: "card", vendor: "Example Labs", title: "Example 5 system card", source: "https://vendor.example/example-5-card",
    published: "2026-09-30", read: "2026-10-13",
    claims: [
      { benchmark: "SWE-bench Pro", version: "public", score: 61.2, unit: "%", taskKind: "repository", conditions: { harness: "vendor scaffold", effort: "max", details: ["averaged over 5 trials"] } },
      { benchmark: "Terminal-Bench", version: "2.1", score: 70, unit: "%", taskKind: "general", conditions: {} },
    ],
    limitations: ["Over-eager on long agentic tasks."],
  });
  // The publication date is optional: a source may give none.
  const { published: _p, ...undated } = structuredClone(CARD);
  assert.equal(cleanCard(undated, TODAY).published, null);
});

test("a card without its source, its read date or a finite score, or with an unsafe URL or unknown field, is refused", () => {
  const claim = CARD.claims[1];
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ source: undefined }, /source is required/],
    [{ source: "not a url" }, /source must be a URL/],
    [{ source: "http://vendor.example/card" }, /https URL/],
    [{ source: "javascript:alert(1)" }, /https URL/],
    [{ source: "https://user:pw@vendor.example/card" }, /user name or password/],
    [{ source: "https://localhost/card" }, /public host/],
    [{ source: "https://10.0.0.1/card" }, /public host/],
    [{ source: "https://intranet/card" }, /public host/],
    [{ source: `https://vendor.example/card?key=${["sk-proj-", "AbC123xyzQrS456"].join("")}` }, /carries a key/],
    [{ read: undefined }, /read is a date/],
    [{ read: "13/10/2026" }, /read is a date/],
    [{ read: "2026-02-30" }, /not a calendar date/],
    [{ read: "2026-10-14" }, /after today/],
    [{ published: "2026-10-14", read: "2026-10-13" }, /published 2026-10-14 is after read/],
    [{ published: "September 2026" }, /published is a date/],
    [{ claims: [] }, /at least one claim/],
    [{ claims: "SWE-bench 80" }, /at least one claim/],
    [{ claims: [{ ...claim, score: "80.9" }] }, /finite number/],
    [{ claims: [{ ...claim, score: Number.NaN }] }, /finite number/],
    [{ claims: [{ ...claim, score: Number.POSITIVE_INFINITY }] }, /finite number/],
    [{ claims: [{ ...claim, unit: "" }] }, /unit is required/],
    [{ claims: [{ ...claim, benchmark: " " }] }, /benchmark is required/],
    [{ claims: [{ ...claim, taskKind: "vibes" }] }, /taskKind must be one of/],
    [{ claims: [{ ...claim, conditions: "max effort" }] }, /conditions must be an object/],
    [{ claims: [{ ...claim, conditions: { reasoning: "max" } }] }, /fields Atelier does not keep: reasoning/],
    [{ claims: [{ ...claim, measuredBy: "atelier" }] }, /fields Atelier does not keep: measuredBy/],
    [{ limitation: "typo" }, /fields Atelier does not keep: limitation/],
    [{ limitations: "one" }, /list of text/],
    [{ corrects: "c1", supersedes: "c2" }, /not both/],
    [{ corrects: "1" }, /such as c12/],
    [{ reason: "fixed a typo" }, /goes with corrects or supersedes/],
  ];
  for (const [change, why] of cases) assert.throws(() => cleanCard({ ...structuredClone(CARD), ...change }, TODAY), why, JSON.stringify(change));
});

test("a withdrawal names a card and gives a reason; a card is filed under a model's name or harness/model", () => {
  assert.deepEqual(cleanWithdrawal({ withdraws: "c3", reason: "The vendor took the page down." }), { kind: "withdrawal", withdraws: "c3", reason: "The vendor took the page down." });
  assert.throws(() => cleanWithdrawal({ withdraws: "c3" }), /reason is required/);
  assert.throws(() => cleanWithdrawal({ withdraws: "3", reason: "x" }), /such as c12/);
  assert.equal(cleanCardModel("antigravity/claude-opus-5-5"), "antigravity/claude-opus-5-5");
  assert.equal(cleanCardModel("gpt-6.1-sol"), "gpt-6.1-sol");
  for (const bad of ["", "nobody/opus-5.5", "../etc", "a b"]) assert.throws(() => cleanCardModel(bad), /not a model's name/);
});

test("a key pasted into the model's name or any text a card keeps is refused", () => {
  // Astra's second review of t625, 2026-10-13, finding 3: sk-… was stored as a model's name.
  const key = ["sk-", "AbC123xyzQrS456"].join("");
  for (const name of [key, `codex/${key}`, "a1b2c3d4e5f6g7h8i9j0k1l2m3"]) assert.throws(() => cleanCardModel(name), /carries a key/, name);
  const claim = CARD.claims[0];
  for (const change of [
    { vendor: key }, { title: `Card ${key}` }, { limitations: [`Leaks ${key}`] }, { reason: key, corrects: "c1" },
    { claims: [{ ...claim, benchmark: key }] }, { claims: [{ ...claim, version: key }] }, { claims: [{ ...claim, unit: key }] },
    { claims: [{ ...claim, conditions: { harness: key } }] }, { claims: [{ ...claim, conditions: { effort: key } }] },
    { claims: [{ ...claim, conditions: { details: [key] } }] },
  ]) assert.throws(() => cleanCard({ ...structuredClone(CARD), ...change }, TODAY), /carries a key/, JSON.stringify(change));
  assert.throws(() => cleanWithdrawal({ withdraws: "c1", reason: key }), /carries a key/);
});

// The stored record a new one repeats, or null for one to store.
const admit = (all: CardRecord[], input: Parameters<typeof admitCardRecord>[1], model: string) => {
  const r = admitCardRecord(all, input, cardFiling(all, [], model));
  return "existing" in r ? r.existing : null;
};
let next = 1;
const stored = (input: CardInput | ReturnType<typeof cleanWithdrawal>): CardRecord =>
  ({ ...input, id: `c${next++}`, model: "example-5", named: "example-5", at: `2026-10-13T10:00:0${next % 10}.000Z`, by: "owner" }) as CardRecord;

test("a card sent again is the card already stored, and a withdrawal sent again is the withdrawal", () => {
  const first = stored(cleanCard(structuredClone(CARD), TODAY));
  assert.equal(admit([first], cleanCard(structuredClone(CARD), TODAY), "example-5"), first);
  const gone = stored(cleanWithdrawal({ withdraws: first.id, reason: "Wrong model." }));
  assert.equal(admit([first, gone], cleanWithdrawal({ withdraws: first.id, reason: "Wrong model." }), "example-5"), gone);
  // Replaying an import after the withdrawal is still the stored card, never
  // a new active copy (Astra's review of t625, 2026-10-13, finding 2).
  assert.equal(admit([first, gone], cleanCard(structuredClone(CARD), TODAY), "example-5"), first);
});

test("a correction replayed after it was itself withdrawn is the stored correction, not a refusal", () => {
  // Astra's review of t625, 2026-10-13, finding 2: the replay answered 409 card_ended.
  const a = stored(cleanCard(structuredClone(CARD), TODAY));
  const fix = { ...structuredClone(CARD), claims: [{ ...CARD.claims[1], score: 71 }], corrects: a.id, reason: "Misread 71 as 70." };
  const b = stored(cleanCard(fix, TODAY));
  const gone = stored(cleanWithdrawal({ withdraws: b.id, reason: "Wrong table." }));
  assert.equal(admit([a, b, gone], cleanCard(structuredClone(fix), TODAY), "example-5"), b);
  assert.equal(admit([a, b, gone], cleanWithdrawal({ withdraws: b.id, reason: "Wrong table." }), "example-5"), gone);
});

test("a source hiding a key behind percent-encoding, or a local host behind a trailing dot or another spelling, is refused", () => {
  // Astra's review of t625, 2026-10-13, finding 3: the first two were accepted.
  const key = ["sk-", "AbC123xyzQrS456"].join("");
  for (const [source, why] of [
    ["https://localhost./card", /public host/],
    ["https://vendor.example/card?key=%73%6b%2dAbC123xyzQrS456", /carries a key/],
    [`https://vendor.example/${encodeURIComponent(key)}/card`, /carries a key/],
    [`https://vendor.example/card#${encodeURIComponent(key)}`, /carries a key/],
    ["https://LOCALHOST/card", /public host/],
    ["https://api.localhost./card", /public host/],
    ["https://127.1/card", /public host/],
    ["https://0x7f000001/card", /public host/],
    ["https://[::1]/card", /public host/],
    ["https://printer.local/card", /public host/],
    ["https://wiki.internal./card", /public host/],
    ["https://vendor.example/card?q=%E0%A4%A", /percent-encoding/],
    // Astra's second review of t625, 2026-10-13, finding 2: an encoded key in the host passed.
    ["https://%73%6b%2dAbC123xyzQrS456.example/card", /carries a key/],
    [`https://${key.toLowerCase()}.example/card`, /carries a key/],
    // Astra's third review of t625, 2026-10-13, finding 2: the parser lowercased AKIA away.
    ["https://AKIAA1B2C3D4E5F6G7H8.example/card", /carries a key/],
    ["https://%41%4b%49%41A1B2C3D4E5F6G7H8.example/card", /carries a key/],
    ["https://%41%4B%49%41%41%31%42%32%43%33%44%34%45%35%46%36%47%37%48%38.example/card", /carries a key/],
    ["https://ＡＫＩＡA1B2C3D4E5F6G7H8.example/card", /carries a key/],
    ["https://user@AKIAA1B2C3D4E5F6G7H8.example/card", /carries a key|user name/],
  ] as const) assert.throws(() => cleanCard({ ...structuredClone(CARD), source }, TODAY), why, source);
  // A public host with a trailing dot or capitals is kept in its plain form.
  assert.equal(cleanCard({ ...structuredClone(CARD), source: "https://Vendor.Example./card?x=1" }, TODAY).source, "https://vendor.example/card?x=1");
});

test("a correction, supersession or withdrawal names an active card of the same model, and history is kept", () => {
  const a = stored(cleanCard(structuredClone(CARD), TODAY));
  const fix = { ...structuredClone(CARD), claims: [{ ...CARD.claims[1], score: 71 }], corrects: a.id, reason: "Misread 71 as 70." };
  assert.throws(() => admit([a], cleanCard({ ...fix, corrects: "c999" }, TODAY), "example-5"), /c999 is not a card of example-5/);
  assert.equal(admit([a], cleanCard(fix, TODAY), "example-5"), null);
  const b = stored(cleanCard(fix, TODAY));
  assert.throws(() => admit([a, b], cleanCard({ ...fix, reason: "again" }, TODAY), "example-5"), /already corrected by c\d+; name c\d+ instead/);
  const c = stored(cleanCard({ ...structuredClone(CARD), read: "2026-10-13", title: "Example 5.1 card", supersedes: b.id }, TODAY));
  const w = stored(cleanWithdrawal({ withdraws: c.id, reason: "Pulled by the vendor." }));
  assert.throws(() => admit([a, b, c, w], cleanWithdrawal({ withdraws: b.id, reason: "x" }), "example-5"), /already superseded/);

  const view = cardView(cardFiling([a, b, c, w], [], "example-5"), [a, b, c, w], [], []);
  assert.deepEqual(view.cards.map((x) => [x.id, x.state, x.endedBy]), [[a.id, "corrected", b.id], [b.id, "superseded", c.id], [c.id, "withdrawn", w.id]]);
  assert.equal(view.cards[0].endReason, "Misread 71 as 70.");
  assert.deepEqual(view.withdrawals.map((x) => x.id), [w.id]);
});

const shown = (id: string, claims: ModelCard["claims"], source = `https://vendor.example/${id}`): ShownCard =>
  ({ id, kind: "card", model: "m", named: "m", at: "", by: "owner", source, published: null, read: TODAY, claims, limitations: [], state: "active" });
const claim = (score: number, conditions = {}, benchmark = "SWE-bench Pro"): ModelCard["claims"][number] => ({ benchmark, score, unit: "%", taskKind: "general", conditions });

test("two active cards that give one benchmark different scores under the same conditions conflict; under other conditions they only differ", () => {
  const max = { harness: "Claude Code", effort: "max" };
  const conflict = cardDisagreements([shown("c1", [claim(80.9, max)]), shown("c2", [claim(78.2, { effort: "MAX", harness: "claude  code" })])]);
  assert.deepEqual(conflict.map((d) => [d.kind, d.claims.map((c) => [c.card, c.score])]), [["conflict", [["c1", 80.9], ["c2", 78.2]]]]);
  assert.equal(conflict[0].claims[0].source, "https://vendor.example/c1");

  const differ = cardDisagreements([shown("c1", [claim(80.9, max)]), shown("c2", [claim(72.0, { harness: "vendor scaffold" })])]);
  assert.deepEqual(differ.map((d) => d.kind), ["conditions-differ"]);
  // The same score, an ended card, another benchmark or one card alone is no disagreement.
  assert.deepEqual(cardDisagreements([shown("c1", [claim(80, max)]), shown("c2", [claim(80, max)])]), []);
  assert.deepEqual(cardDisagreements([shown("c1", [claim(80, max)]), { ...shown("c2", [claim(70, max)]), state: "superseded" }]), []);
  assert.deepEqual(cardDisagreements([shown("c1", [claim(80, max)]), shown("c2", [claim(70, max, "Terminal-Bench")])]), []);
  assert.deepEqual(cardDisagreements([shown("c1", [claim(80, max), claim(70)])]), []);
  // Stable order: the groups in the order their first claim was recorded.
  const order = cardDisagreements([shown("c1", [claim(1, {}, "B"), claim(1, {}, "A")]), shown("c2", [claim(2, {}, "A"), claim(2, {}, "B")])]);
  assert.deepEqual(order.map((d) => d.benchmark), ["B", "A"]);
});

test("a card's claims are model-card evidence, never an Atelier record, and the registry's priors stay labelled as priors", () => {
  const card = { ...cleanCard(structuredClone(CARD), TODAY), id: "c1", model: "m", named: "m", at: "", by: "owner" } as ModelCard;
  assert.deepEqual(cardEvidence(card), [
    { kind: "model-card", taskKind: "repository", claim: "SWE-bench Pro public 61.2% (vendor scaffold; max effort; averaged over 5 trials)", source: CARD.source, date: "2026-09-30" },
    { kind: "model-card", taskKind: "general", claim: "Terminal-Bench 2.1 70%", source: CARD.source, date: "2026-09-30" },
  ]);
  const cloud = MODEL_PROFILES.filter((p) => p.where === "cloud");
  assert.ok(cloud.length > 0 && cloud.every((p) => p.evidence.every((e) => e.prior === true && e.kind === "model-card")));
  assert.ok(MODEL_PROFILES.filter((p) => p.where === "home").every((p) => p.evidence.every((e) => !e.prior)));
});

// A ledger in memory over the same pure functions the index ledger calls.
type Entry = { id: string; harness: string; aliases: string[] };
function ledger() {
  const all: CardRecord[] = [];
  const add = (pool: Entry[], named: string, input: Parameters<typeof newCardRecord>[3]) => {
    const made = newCardRecord(all, pool, named, input, "owner", "2026-10-16T09:00:00.000Z");
    if ("existing" in made) return made.existing;
    const record = { ...made.store, id: `c${all.length + 1}` } as CardRecord;
    all.push(record);
    return record;
  };
  return { all, add, view: (pool: Entry[], named: string) => modelCardView(all, pool, named) };
}
const card = (score: number) => cleanCard({ ...structuredClone(CARD), claims: [{ ...CARD.claims[1], score }] }, TODAY);

test("pool removals and alias changes move where a card is listed, never its state", () => {
  // Astra's third review of t625, 2026-10-13, finding 1: removing B showed A's withdrawn c1 as active.
  const l = ledger();
  const b: Entry = { id: "model-b", harness: "codex", aliases: ["model-a"] };
  const c1 = l.add([], "model-a", card(1));
  l.add([b], "model-b", cleanWithdrawal({ withdraws: c1.id, reason: "Wrong model." }));
  for (const pool of [[b], [], [{ id: "model-c", harness: "codex", aliases: ["model-a"] }]]) {
    const models = new Set(["model-a", "model-b", "model-c"].map((m) => l.view(pool, m).model));
    const listed = [...models].flatMap((m) => l.view(pool, m).cards.map((c) => [m, c.id, c.state]));
    assert.deepEqual(listed.filter(([, id]) => id === c1.id).map(([, , state]) => state), ["withdrawn"], JSON.stringify(pool));
  }
  // gemini-4-argon's third review, finding 2: a replay after the pool lost
  // the model returns the card instead of storing an active duplicate.
  const sol: Entry = { id: "gpt-6.1-sol", harness: "codex", aliases: ["sol-preview"] };
  const s1 = l.add([sol], "sol-preview", card(2));
  assert.equal(l.add([], "sol-preview", card(2)), s1);
  assert.deepEqual(l.view([sol], "gpt-6.1-sol").cards.map((c) => c.id), [s1.id]);
});

test("one model under several harnesses, linked by a pool alias, has one set of cards", () => {
  // gemini-4-argon's third review of t625, 2026-10-13, finding 1: the two harnesses split the cards.
  const l = ledger();
  const pool: Entry[] = [{ id: "gemini-4-argon", harness: "gemini-cli", aliases: [] }, { id: "gemini-4-argon-ag", harness: "antigravity", aliases: ["gemini-4-argon"] }];
  const a = l.add(pool, "antigravity/gemini-4-argon-ag", card(3));
  const g = l.add(pool, "gemini-cli/gemini-4-argon", card(4));
  for (const name of ["gemini-4-argon", "gemini-4-argon-ag", "antigravity/gemini-4-argon", "gemini-cli/gemini-4-argon", "antigravity/gemini-4-argon-ag"]) {
    const view = l.view(pool, name);
    assert.equal(view.model, "gemini-4-argon", name);
    assert.deepEqual(view.cards.map((c) => c.id), [a.id, g.id], name);
    assert.deepEqual(view.pool, ["gemini-cli/gemini-4-argon", "antigravity/gemini-4-argon-ag"], name);
  }
});

test("random sequences of records, withdrawals, corrections and pool changes never show a withdrawn card active, and list each card under one model", () => {
  let seed = 625;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = ["m1", "m2", "m3"];
  const names = ["m1", "m2", "m3", "p1", "p2", "codex/m1", "opencode/p1"];
  for (let run = 0; run < 60; run++) {
    const l = ledger();
    const pool = new Map<string, Entry>();
    const withdrawn = new Set<string>();
    for (let step = 0; step < 40; step++) {
      const current = [...pool.values()];
      const op = rand(7);
      const name = names[rand(names.length)];
      const cards = l.all.filter((r) => r.kind === "card");
      const pick = cards[rand(Math.max(cards.length, 1))];
      try {
        if (op === 0) l.add(current, name, card(rand(5)));
        if (op === 1 && pick) { const w = l.add(current, name, cleanWithdrawal({ withdraws: pick.id, reason: "Gone." })); if (w.kind === "withdrawal") withdrawn.add(w.withdraws); }
        if (op === 2 && pick) l.add(current, name, cleanCard({ ...structuredClone(CARD), corrects: pick.id, claims: [{ ...CARD.claims[1], score: rand(5) }] }, TODAY));
        if (op === 3) { const id = ids[rand(3)]; pool.set(id, { id, harness: rand(2) ? "codex" : "opencode", aliases: [...(pool.get(id)?.aliases ?? []), ["p1", "p2"][rand(2)]] }); }
        if (op === 4) { const alias = ["p1", "p2"][rand(2)]; for (const e of pool.values()) e.aliases = e.aliases.filter((a) => a !== alias); const id = ids[rand(3)]; const e = pool.get(id); if (e) e.aliases = [...e.aliases, alias]; }
        if (op === 5) pool.delete(ids[rand(3)]);
        if (op === 6) { const id = ids[rand(3)]; if (!pool.has(id)) pool.set(id, { id, harness: "codex", aliases: [] }); }
      } catch (e) { assert.match(String(e), /is not a card of|already (withdrawn|corrected|superseded)/); }
      const now = [...pool.values()].map((e) => ({ ...e, aliases: [...e.aliases] }));
      const models = new Set([...names, ...now.map((e) => e.id)].map((n) => l.view(now, n).model));
      const listing = [...models].flatMap((m) => l.view(now, m).cards);
      const at = `run ${run} step ${step}`;
      for (const c of listing) if (withdrawn.has(c.id)) assert.equal(c.state, "withdrawn", `${at}: ${c.id}`);
      assert.deepEqual(listing.map((c) => c.id).sort(), l.all.filter((r) => r.kind === "card").map((r) => r.id).sort(), `${at}: each card listed once`);
    }
  }
});

test("the seed of 2026-10-13 is a list of valid cards, each naming its model and an https source", () => {
  const seed = JSON.parse(readFileSync(new URL("../docs/model-cards/2026-10-13.json", import.meta.url), "utf8")) as Record<string, unknown>[];
  assert.ok(Array.isArray(seed) && seed.length > 0);
  for (const { model, ...card } of seed) {
    assert.equal(cleanCardModel(model as string), model);
    const clean = cleanCard(card, "2026-10-16");
    assert.equal(clean.read, "2026-10-13");
    assert.ok(clean.source.startsWith("https://"));
  }
});
