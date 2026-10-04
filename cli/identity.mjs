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
