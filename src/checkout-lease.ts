// The checkout lease (Atelier 2.0, G9): one lease on a project's registered
// checkout, held by a landing's merge step (atelier merge, which atelier land
// runs there) and by atelier ship, so the two never use the checkout at the
// same time. A deploy once raced the lander in the same checkout (lessons
// audit, row 21). The server keeps it beside the landing lease, which guards
// the baseline rather than the checkout: holder, kind and since, the lease's
// own id (the CLI process's), and where the holder runs. A holder renews it
// while it holds it; one that stops renewing for the liveness limit died, and
// the next taker takes it over and is told whose lease lapsed.
//
// The server also keeps the checkout's head as the last holder left it, so a
// change made outside the lease (a deploy by hand, which cannot be prevented)
// is reported to the next taker as a fact, never as an error to retry. And
// it keeps the deploys atelier ship records, failed ones included.
import { RuleError } from "./rules.ts";
import { LANDING_LEASE_EXPIRY_MS } from "./landing-lease.ts";

export type CheckoutKind = "landing" | "ship";
export interface CheckoutLease {
  id: string; kind: CheckoutKind; holder: string; since: string; renewedAt: string;
  item?: string; host?: string; pid?: number;
}
// The checkout's head as the last holder released it.
export interface CheckoutHead { head: string; at: string; kind: CheckoutKind; holder: string; item?: string }
// A change to the checkout made outside the lease, as the next taker is told.
export interface CheckoutFact { code: "checkout_moved"; was: string; now: string; since: string; detail: string; next: string }
// One run of atelier ship, as it recorded itself: the head shipped, who, and
// how it ended (shipped, or failed at a step or before finishing).
export interface DeployRecord {
  ship: string; head: string; by: string; result: "shipped" | "failed"; at: string;
  step?: string; ran?: string[]; note?: string;
  // A step after the deploy failed; the deploy itself shipped.
  warning?: string;
}

// The liveness limit: the landing lease's, so both leases lapse alike.
export const CHECKOUT_LEASE_EXPIRY_MS = LANDING_LEASE_EXPIRY_MS;

export function checkoutLeaseLapsed(lease: CheckoutLease, now: number): boolean {
  return now - Date.parse(lease.renewedAt ?? lease.since) >= CHECKOUT_LEASE_EXPIRY_MS;
}

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const short = (sha: string) => sha.slice(0, 8);

// Who holds the lease, in words: "t3's landing (its merge step), owner on
// studio (pid 4242), since 2026-10-28 14:02 UTC".
export function describeCheckoutLease(lease: CheckoutLease): string {
  const what = lease.kind === "ship" ? "atelier ship" : `${lease.item ? `${lease.item}'s landing` : "a landing"} (its merge step)`;
  const where = lease.host ? ` on ${lease.host}${lease.pid ? ` (pid ${lease.pid})` : ""}` : lease.pid ? ` (pid ${lease.pid})` : "";
  return `${what}, ${lease.holder}${where}, since ${utc(lease.since)}`;
}

// The refusal a take gets while another live holder has the checkout. The
// CLI waits on it and says who holds it.
export function checkoutHeld(lease: CheckoutLease, project: string): RuleError {
  const minutes = Math.round(CHECKOUT_LEASE_EXPIRY_MS / 60_000);
  return new RuleError("checkout_lease", `${project}'s registered checkout is held by ${describeCheckoutLease(lease)}; landing and shipping never use it at the same time`, 409,
    `wait for it: atelier merge and atelier ship wait for the checkout themselves, and a holder that died frees it ${minutes} minutes after its last heartbeat`);
}

// What a take reports when the checkout's head is not the one the last
// holder left: a fact about the checkout, with what to do about it.
export function checkoutMoved(last: CheckoutHead, now: string, project: string): CheckoutFact {
  const by = last.kind === "ship" ? "atelier ship" : `${last.item ? `${last.item}'s` : "a"} merge`;
  return {
    code: "checkout_moved", was: last.head, now, since: last.at,
    detail: `${project}'s registered checkout is at ${short(now)}, not at ${short(last.head)} where ${by} left it at ${utc(last.at)}: something changed it outside atelier merge and atelier ship, such as a commit, a pull or a deploy by hand. Nothing was refused; the landing goes on from ${short(now)}`,
    next: `see what changed with git log ${short(last.head)}..${short(now)} in the checkout; deploy through atelier ship --project ${project}, which records the deploy`,
  };
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const SHA = /^[a-f0-9]{40,64}$/;

// A take's input, checked: the lease's id (the holder's own), its kind, the
// task a landing merges, where the holder runs, and the checkout's head now.
export function takeInput(body: Record<string, unknown>): { id: string; kind: CheckoutKind; item?: string; host?: string; pid?: number; head?: string } {
  const id = leaseId(body);
  if (body.kind !== "landing" && body.kind !== "ship") throw new RuleError("bad_kind", "kind is landing or ship", 400);
  if (body.item !== undefined && (typeof body.item !== "string" || !/^t[1-9][0-9]*$/.test(body.item))) throw new RuleError("bad_item", "item names a task such as t3", 400);
  if (body.host !== undefined && (typeof body.host !== "string" || body.host.length > 200)) throw new RuleError("bad_host", "host is a machine name of at most 200 characters", 400);
  if (body.pid !== undefined && (!Number.isSafeInteger(body.pid) || (body.pid as number) <= 0)) throw new RuleError("bad_host", "pid is the holder's process id", 400);
  const head = headInput(body);
  return { id, kind: body.kind, ...(body.item ? { item: body.item as string } : {}), ...(body.host ? { host: body.host as string } : {}), ...(body.pid ? { pid: body.pid as number } : {}), ...(head ? { head } : {}) };
}

export function leaseId(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || !ID.test(body.id)) throw new RuleError("bad_lease", "a checkout lease call names its lease id: 8 to 64 letters, digits, - or _", 400);
  return body.id;
}

export function headInput(body: Record<string, unknown>): string | undefined {
  if (body.head === undefined || body.head === null) return undefined;
  if (typeof body.head !== "string" || !SHA.test(body.head)) throw new RuleError("bad_head", "head is the checkout's full commit hash", 400);
  return body.head;
}

// A deploy record's input, checked; `by` and `at` are the server's.
export function deployInput(body: Record<string, unknown>, by: string, at: string): DeployRecord {
  if (typeof body.ship !== "string" || !ID.test(body.ship)) throw new RuleError("bad_record", "ship names the run's id", 400);
  if (typeof body.head !== "string" || !SHA.test(body.head)) throw new RuleError("bad_head", "head is the full commit hash shipped", 400);
  if (body.result !== "shipped" && body.result !== "failed") throw new RuleError("bad_record", "result is shipped or failed", 400);
  if (body.step !== undefined && (typeof body.step !== "string" || body.step.length > 40)) throw new RuleError("bad_step", "step names the ship step it stopped at", 400);
  if (body.ran !== undefined && (!Array.isArray(body.ran) || body.ran.length > 20 || body.ran.some((s) => typeof s !== "string" || s.length > 60))) throw new RuleError("bad_record", "ran lists the steps that ran", 400);
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) throw new RuleError("bad_note", "note is at most 1,000 characters", 400);
  if (body.warning !== undefined && (typeof body.warning !== "string" || body.warning.length > 1000)) throw new RuleError("bad_note", "warning is at most 1,000 characters", 400);
  return {
    ship: body.ship, head: body.head, by, result: body.result, at,
    ...(body.warning ? { warning: body.warning as string } : {}),
    ...(body.step ? { step: body.step as string } : {}), ...(body.ran ? { ran: body.ran as string[] } : {}), ...(body.note ? { note: body.note as string } : {}),
  };
}

// A deploy in one line, as show prints it.
export function deployText(d: DeployRecord): string {
  const how = d.result === "shipped" ? "shipped" : `FAILED${d.step ? ` at ${d.step}` : ""}`;
  return `${d.ship} at ${short(d.head)} by ${d.by}, ${how}, ${utc(d.at)}${d.ran?.length ? `; ran ${d.ran.join(", ")}` : ""}${d.note ? ` (${d.note})` : ""}${d.warning ? ` Warning: ${d.warning}` : ""}`;
}
