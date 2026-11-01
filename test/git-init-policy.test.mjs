import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHost } from "../src/git/host.mjs";
import { backendEnv } from "../src/git/http.mjs";

// Exercise the policy producer without an HTTP listener. Free-text clearance
// fields may quote credentials and must never be passed to the hook.
test("initial scan policy keeps only clearance bindings and no plaintext token", async () => {
  const token = "dummy-owner-credential";
  const binding = { file: "config.env", fingerprint: "f".repeat(64) };
  let recorded = [];
  const ledger = {
    privatePaths: async () => ["private"],
    item: async () => ({ secretClearances: [{ ...binding, reason: token, quote: token }] }),
    hostMoveScan: async () => ({ clearances: recorded }),
  };
  const host = { ledger: () => ledger };
  const grant = { id: "owner", key: "demo", project: "demo", actor: "owner", kind: "owner", branch: "main" };
  const policy = () => GitHost.prototype.scanPolicy.call(host, grant);
  assert.deepEqual(await policy(), { clearances: [], private: ["private"] });
  recorded = [{ ...binding, reason: token, quote: token, acting: "model", by: "owner", at: "now" }];
  const initial = await policy();
  assert.deepEqual(initial, { clearances: [], initialClearances: [binding], private: ["private"] });
  assert.equal(JSON.stringify(initial).includes(token), false);
  const env = backendEnv({ reposDir: "/r", key: "demo", rest: "git-receive-pack", method: "POST", query: "", grant: { ...grant, token } });
  assert.equal(JSON.stringify(env).includes(token), false);
  assert.equal(Object.keys(env).some((k) => /TOKEN|SECRET/.test(k)), false);
  // Initial-history clearances cannot authorize an ordinary task push.
  const task = await GitHost.prototype.scanPolicy.call(host, { ...grant, kind: "task", task: "t1" });
  assert.deepEqual(task, { clearances: [binding], private: ["private"] });
});
