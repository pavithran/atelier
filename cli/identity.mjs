// An agent's workspace commits under the identity the project's own checkout
// sets for itself. Without this, a fresh clone falls back to the machine's
// global git identity, which may be a personal address the project has chosen
// not to publish.
import { spawnSync } from "node:child_process";

function localConfig(dir, key) {
  const r = spawnSync("git", ["config", "--local", "--get", key], { cwd: dir, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// The checkout's own user.name and user.email, or null for any it does not set.
export function checkoutIdentity(checkout) {
  if (!checkout) return { name: null, email: null };
  return { name: localConfig(checkout, "user.name"), email: localConfig(checkout, "user.email") };
}

// Copy what the checkout sets into the workspace; returns what was applied.
export function applyIdentity(checkout, workspace) {
  const id = checkoutIdentity(checkout);
  for (const [key, value] of [["user.name", id.name], ["user.email", id.email]]) {
    if (value) spawnSync("git", ["config", "--local", key, value], { cwd: workspace });
  }
  return id;
}

// A registered checkout commits under the project's identity too (t755). In
// llm-basics a commit there took the machine's global address and the
// baseline push was refused. When the checkout's own user.name or user.email
// is unset or differs from the policy's, set both in .git/config and say so
// in one line; when both match, change and print nothing. A project with no
// identity yet is left alone. Returns true when it changed the checkout.
export function pinCheckoutIdentity(checkout, identity, say = console.log) {
  if (!checkout || !identity?.name || !identity?.email) return false;
  const have = checkoutIdentity(checkout);
  if (have.name === identity.name && have.email === identity.email) return false;
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email]]) {
    const r = spawnSync("git", ["config", "--local", key, value], { cwd: checkout, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`could not set ${key} in ${checkout}/.git/config: ${(r.stderr || "").trim()}`);
  }
  say(`Set this checkout's git identity to ${identity.name} <${identity.email}>, the project's commit identity.`);
  return true;
}
