import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIdentity, checkoutIdentity } from "../cli/identity.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("a workspace takes the checkout's own identity, and only what the checkout sets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"), workspace = join(root, "ws"), bare = join(root, "plain");
  for (const d of [checkout, workspace, bare]) execFileSync("git", ["init", "-q", d]);
  git(checkout, "config", "--local", "user.name", "Project Owner");
  git(checkout, "config", "--local", "user.email", "123+owner@users.noreply.github.com");

  assert.deepEqual(applyIdentity(checkout, workspace), { name: "Project Owner", email: "123+owner@users.noreply.github.com" });
  assert.equal(git(workspace, "config", "--local", "user.email"), "123+owner@users.noreply.github.com");
  assert.equal(git(workspace, "config", "--local", "user.name"), "Project Owner");

  // A checkout with no identity of its own changes nothing; git's usual lookup applies.
  const fresh = join(root, "ws2");
  execFileSync("git", ["init", "-q", fresh]);
  assert.deepEqual(applyIdentity(bare, fresh), { name: null, email: null });
  assert.throws(() => git(fresh, "config", "--local", "--get", "user.email"));
  assert.deepEqual(checkoutIdentity(undefined), { name: null, email: null });
});
