import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHead, SHIP_GIT } from './ship-studio.mjs';

// Delivery already passed. A runner refresh must not turn it into a failure.
export function refreshRunners({ cwd = process.cwd(), env = process.env,
  getHead = sourceHead, run = spawnSync, warn = console.warn, log = console.log } = {}) {
  try {
    const head = getHead({ cwd, env });
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid shipped commit.');
    const commands = [
      [SHIP_GIT, ['push', 'ai-studio:ai-projects/atelier-runner', `${head}:refs/atelier/ship`]],
      ['/usr/bin/ssh', ['-o', 'BatchMode=yes', '--', 'ai-studio',
        `PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; cd "$HOME/ai-projects/atelier-runner" && git reset --hard ${head} && npm ci`]],
    ];
    for (const [command, args] of commands) {
      const result = run(command, args, { cwd, env: { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, stdio: 'inherit', timeout: 240_000 });
      if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}`);
    }
    log(`Refreshed Studio runners to ${head}.`);
    return true;
  } catch (error) {
    warn(`Warning: Studio runner refresh failed: ${error.message}; delivery remains successful. Refresh ~/ai-projects/atelier-runner on ai-studio manually.`);
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshRunners();
}
