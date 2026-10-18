import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIdentity, checkoutIdentity, pinCheckoutIdentity } from "../cli/identity.mjs";

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

test("a registered checkout is pinned to the project's identity once, and left alone when it already matches (t755)", (t) => {
  // Finding: llm-basics, 2026-10-17, a commit in the registered checkout took
  // the global user.email and the baseline push was refused.
  const root = mkdtempSync(join(tmpdir(), "atelier-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "-q", checkout]);
  const identity = { name: "Project Owner", email: "123+owner@users.noreply.github.com" };
  const said = [];
  const say = (line) => said.push(line);

  // Unset: both are written to .git/config, with one line.
  assert.equal(pinCheckoutIdentity(checkout, identity, say), true);
  assert.equal(git(checkout, "config", "--local", "user.name"), identity.name);
  assert.equal(git(checkout, "config", "--local", "user.email"), identity.email);
  assert.equal(said.length, 1);
  assert.match(said[0], /123\+owner@users\.noreply\.github\.com/);

  // Matching: nothing changes and nothing is printed.
  const before = readFileSync(join(checkout, ".git", "config"), "utf8");
  assert.equal(pinCheckoutIdentity(checkout, identity, say), false);
  assert.equal(said.length, 1);
  assert.equal(readFileSync(join(checkout, ".git", "config"), "utf8"), before);

  // Different email (the global one): corrected, with one more line.
  git(checkout, "config", "--local", "user.email", "me@example.com");
  assert.equal(pinCheckoutIdentity(checkout, identity, say), true);
  assert.equal(git(checkout, "config", "--local", "user.email"), identity.email);
  assert.equal(said.length, 2);

  // Only the name missing: still pinned.
  git(checkout, "config", "--local", "--unset", "user.name");
  assert.equal(pinCheckoutIdentity(checkout, identity, say), true);
  assert.equal(git(checkout, "config", "--local", "user.name"), identity.name);

  // No identity in the policy, or no checkout: untouched.
  assert.equal(pinCheckoutIdentity(checkout, null, say), false);
  assert.equal(pinCheckoutIdentity(undefined, identity, say), false);

  // A checkout git cannot write to fails loudly rather than committing under the wrong address.
  assert.throws(() => pinCheckoutIdentity(join(root, "missing"), identity, say));
});
