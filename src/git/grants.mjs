// Git credentials on the Node server (Atelier 2.0, task 2; design section
// 4.3). Every Git credential is a bearer token the server mints and keeps by
// SHA-256 alone, bound to { project, kind, task, actor, generation,
// accepted }:
//   task     writes refs/heads/t/N for its task; live only while the task's
//            Ledger records it as the item's write token (`git:HASH` in
//            items.token_id), so the Ledger's own changes of holder (release,
//            handoff, abandon, merge, a new claim) revoke it, and minting a
//            new one for the task rotates it: one live write token per task.
//   read     reads every branch of one project.
//   landing  writes the project's branch once, with a merge of `accepted`
//            (rule 4), and refs/notes/atelier, for its task (whose
//            clearances the hook's scan applies); minted only to the holder
//            of the project's landing lease for a task accepted at
//            `accepted`, bound to that holding of the lease (`lease`), live
//            only while all of that stands, for five minutes, and revoked
//            once the landing's merge is recorded (task 6). Its one update of
//            the project's branch is recorded in `branch_sha` as the hook
//            lets it through; a second is refused.
// The plaintext leaves this module once, in mint's answer, and is never
// stored, logged or put in a hook's environment (the hook gets the grant id).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const KINDS = ["task", "read", "landing", "plan"];
export const TTL_MS = { task: 7 * 24 * 3600e3, read: 8 * 3600e3, landing: 5 * 60e3, plan: 7 * 24 * 3600e3 };

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export class GrantStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL,
        task TEXT, actor TEXT NOT NULL, generation INTEGER, accepted TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`);
    // Columns added by task 6, for a store made before it.
    for (const column of ["lease TEXT", "branch_sha TEXT"]) {
      try { this.db.exec(`ALTER TABLE grants ADD COLUMN ${column}`); } catch { /* there already */ }
    }
  }
  // Mints a grant; answers { id, token, hash, expiresAt } (the one place the
  // plaintext appears).
  mint({ project, kind, task = null, actor, generation = null, accepted = null, lease = null, ttlMs, now = Date.now() }) {
    if (!KINDS.includes(kind)) throw new Error(`a Git grant is one of ${KINDS.join(", ")}, not ${kind}`);
    if ((kind === "task" || kind === "plan") && !/^t\d+$/.test(task ?? "")) throw new Error(`a ${kind} grant names its task as tN`);
    if (kind === "landing" && !/^[0-9a-f]{40}$/.test(accepted ?? "")) throw new Error("a landing grant names the accepted head");
    if (kind === "landing" && !/^t\d+$/.test(task ?? "")) throw new Error("a landing grant names its task as tN");
    if (kind === "landing" && !lease) throw new Error("a landing grant names the holding of the landing lease it was minted under");
    const token = `atl_${randomBytes(32).toString("hex")}`;
    const hash = hashToken(token);
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    const expires = now + (ttlMs ?? TTL_MS[kind]);
    this.db.prepare(`INSERT INTO grants (id, hash, project, kind, task, actor, generation, accepted, lease, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, hash, project, kind, task, actor, generation, accepted, lease, now, expires);
    return { id, token, hash, expiresAt: new Date(expires).toISOString() };
  }
  // The live grant a token is, or null: unknown, revoked and expired tokens
  // are all null.
  find(token, now = Date.now()) {
    if (typeof token !== "string" || !token.startsWith("atl_")) return null;
    const row = this.db.prepare(`SELECT * FROM grants WHERE hash = ?`).get(hashToken(token));
    if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
    return { ...row };
  }
  // The live grant under an id, or null, as find answers for a token.
  findById(id, now = Date.now()) {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return null;
    const row = this.db.prepare(`SELECT * FROM grants WHERE id = ?`).get(id);
    if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
    return { ...row };
  }
  // The ids of the live grants of one kind for one task of a project.
  liveIds({ project, kind, task }, now = Date.now()) {
    return this.db.prepare(`SELECT id FROM grants WHERE project = ? AND kind = ? AND task = ? AND revoked_at IS NULL AND expires_at > ?`)
      .all(project, kind, task, now).map((row) => row.id);
  }
  // A landing grant's one update of the project's branch, taken in one
  // statement: true for the first, false once one is recorded (or the grant
  // is no longer live).
  consumeBranch(id, sha, now = Date.now()) {
    return this.db.prepare(`UPDATE grants SET branch_sha = ? WHERE id = ? AND kind = 'landing' AND branch_sha IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(sha, id, now).changes > 0;
  }
  revoke(id, now = Date.now()) {
    return this.db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id).changes > 0;
  }
  // Drops grants expired or revoked more than a day ago.
  prune(now = Date.now()) {
    this.db.prepare(`DELETE FROM grants WHERE COALESCE(revoked_at, expires_at) < ?`).run(now - 24 * 3600e3);
  }
  close() { this.db.close(); }
}
