import { userInfo } from "node:os";
import { isAbsolute } from "node:path";

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

export const HOOK_PATH = "/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin";
