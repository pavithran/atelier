import { userInfo } from "node:os";
import { dirname, isAbsolute } from "node:path";

// The daemon is identified by its effective uid or account name, never HOME
// or another caller-controlled environment value.
export function gitCommand({ env = process.env, uid = process.geteuid?.(), username = userInfo().username } = {}) {
  if (env.ATELIER_GIT !== undefined) {
    if (!isAbsolute(env.ATELIER_GIT)) throw new Error("ATELIER_GIT must be an absolute path");
    return env.ATELIER_GIT;
  }
  if (uid === 0 || username === "atelierd") throw new Error("ATELIER_GIT is required for root and atelierd");
  return "git";
}

// The hooks' PATH: the folder of the node this server runs on (the hooks start
// with `env node`; in the daemon that is the verified, root-owned copy), then
// root's own folders. Never /opt/homebrew/bin or /usr/local/bin.
export const SYSTEM_PATH = "/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const HOOK_PATH = `${dirname(process.execPath)}:${SYSTEM_PATH}`;
