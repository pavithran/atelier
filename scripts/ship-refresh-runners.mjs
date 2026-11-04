import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHead, SHIP_GIT } from './ship-studio.mjs';

// Delivery already passed. Refresh failures are warnings.
export function refreshRunners({ cwd = process.cwd(), env = process.env,
  getHead = sourceHead, run = spawnSync, warn = console.warn, log = console.log } = {}) {
  let head;
  try {
    head = getHead({ cwd, env });
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid shipped commit.');
    const invoke = (command, args, options = {}) => {
      const result = run(command, args, { cwd, env: { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
        timeout: 90_000, maxBuffer: 256 * 1024 * 1024, ...options });
      if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}`);
      return result.stdout;
    };
    const ssh = (command, options) => invoke('/usr/bin/ssh', ['-o', 'BatchMode=yes', '--', 'ai-studio', command], options);
    invoke(SHIP_GIT, ['push', 'ai-studio:ai-projects/atelier-runner', `${head}:refs/atelier/ship`], { stdio: 'inherit' });
    ssh(`PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; cd "$HOME/ai-projects/atelier-runner" && git reset --hard ${head} && npm ci`, { stdio: 'inherit' });
    const bundle = invoke(SHIP_GIT, ['bundle', 'create', '-', 'HEAD']);
    // The request appears only after the complete bundle has been published.
    ssh(`umask 002; set -C; cd /Users/atelier-build/flags && cat > runner-refresh.bundle.$$ && mv -f runner-refresh.bundle.$$ runner-refresh.bundle && printf '%s\\n' ${head} > runner-refresh.head.$$ && mv -f runner-refresh.head.$$ runner-refresh.head`, { input: bundle });
    const acknowledged = ssh('cat /Users/atelier-build/flags/runner-refresh.applied 2>/dev/null || true', { encoding: 'utf8' });
    if (String(acknowledged).trim() !== head) {
      warn(`Builder copy has not reached ${head}; refresh queued until the control loop is idle. Delivery remains successful.`);
      return false;
    }
    log(`Builder copy reached ${head} (dependencies installed and runners restarted). Studio runner refresh complete.`);
    return true;
  } catch (error) {
    warn(`Warning: Studio runner refresh failed: ${error.message}; delivery remains successful. Builder copy has not reached the shipped commit through this refresh; inspect the control loop and retry.`);
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) refreshRunners();
