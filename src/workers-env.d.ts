// The Workers types the server's sources name, for the Node server (Atelier
// 2.0, task 7). They were generated into worker-configuration.d.ts by
// wrangler's types command; wrangler is gone, and this declares only what
// the code uses, as the Node runtime provides it: the bindings (Env), the Durable
// Object state and stubs (src/runtime/namespace.mjs), SQL storage
// (src/runtime/sql.mjs), the repository readers (src/git/local-repos.mjs), the
// LARGE store (src/runtime/large.mjs), and the handler types of
// src/index.ts's default export (src/runtime/server.mjs calls its fetch).

interface Env {
  LARGE: R2Bucket;
  REPOS: Repos;
  AI_GATEWAY_ID: string;
  PUBLIC_ORIGIN: string;
  LEDGER: DurableObjectNamespace<import("./index").Ledger>;
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<E = unknown> {
    protected ctx: DurableObjectState;
    protected env: E;
    constructor(ctx: DurableObjectState, env: E);
  }
  export const env: Env;
}

// ── Durable Objects ───────────────────────────────────────────────────────
interface DurableObjectId { readonly name?: string; toString(): string; equals(other: DurableObjectId): boolean }
// A call through a stub crosses as a structured clone and always answers a promise.
type DurableObjectStub<T = unknown> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
} & { readonly id: DurableObjectId; readonly name?: string };
interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}
interface DurableObjectStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(time: number | Date): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
  sync(): Promise<void>;
}
interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  abort(reason?: string): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

// ── SQL storage ───────────────────────────────────────────────────────────
type SqlStorageValue = ArrayBuffer | string | number | null;
interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> extends Iterable<T> {
  toArray(): T[];
  one(): T;
  raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
  next(): IteratorResult<T>;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}
interface SqlStorage {
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: any[]): SqlStorageCursor<T>;
  readonly databaseSize: number;
}

// ── LARGE ─────────────────────────────────────────────────────────────────
interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { customMetadata?: Record<string, string> }): Promise<{ key: string; size: number } | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

// ── REPOS, the readers over the server's bare repositories ──────────────
interface GitCommit {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number;
  committedAt: number;
}
interface GitTreeEntry { name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" | "gitlink" | "exec" }
interface GitRepoInfo {
  id: string; name: string; description: string | null; defaultBranch: string; createdAt: string; updatedAt: string;
  lastPushAt: string | null; source: string | null; readOnly: boolean; remote: string;
}
interface GitRepo extends Disposable {
  verifyRegeneration?(oldHead: string, main: string, newHead: string): Promise<string[]>;
  info(): Promise<GitRepoInfo>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<GitTreeEntry[] | null>;
  readCommit(hash: string): Promise<GitCommit | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<GitCommit[]>;
}
interface Repos {
  get(name: string): Promise<GitRepo>;
}

// ── The handler ───────────────────────────────────────────────────────────
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: unknown;
}
interface ScheduledController { readonly scheduledTime: number; readonly cron: string; noRetry(): void }
interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly { readonly id: string; readonly timestamp: Date; readonly body: Body; readonly attempts: number; ack(): void; retry(): void }[];
  ackAll(): void;
  retryAll(): void;
}
interface ExportedHandler<E = unknown> {
  fetch?(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(controller: ScheduledController, env: E, ctx: ExecutionContext): void | Promise<void>;
  queue?(batch: MessageBatch<unknown>, env: E, ctx: ExecutionContext): void | Promise<void>;
}
// The cache the imported history is kept in; the Node server's answers nothing.
declare var caches: { default: { match(key: Request): Promise<Response | undefined>; put(key: Request, value: Response): Promise<void>; delete(key: Request): Promise<boolean> } };

// The landing Workflow's instance status, kept on records written before task 6 removed it.
type InstanceStatus = { status: "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "rollingBack" | "unknown"; error?: { name: string; message: string }; output?: unknown };
