// How long the CLI waits on the server and on Git before it gives up and says
// what it was waiting for (t763). The limits are generous: a slow but healthy
// call finishes inside them, and only a call that has stopped answering is cut.

// A server request, in milliseconds. A body of UPLOAD_BYTES or more is a bulk
// upload and gets the longer limit.
export const SERVER_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;
export const UPLOAD_BYTES = 1_000_000;

// A transfer slower than LOW_SPEED_BYTES a second for LOW_SPEED_SECONDS in a
// row is cut by Git itself. It is a floor on speed, not a cap on time, so a
// large fetch or push that keeps moving is never stopped.
export const LOW_SPEED_BYTES = 1000;
export const LOW_SPEED_SECONDS = 120;

// The Git subcommands that talk to a remote.
const NETWORK = new Set(["fetch", "push", "clone", "pull", "ls-remote"]);
export const talksToRemote = (args) => args.some((arg) => NETWORK.has(arg));

// The limit a request with `body` runs under. ATELIER_SERVER_TIMEOUT_MS sets
// it outright (a test's short one, or a slow link's longer one); a value that
// is not a positive number is ignored.
export function serverTimeoutMs(body, env = process.env) {
  const set = Number(env.ATELIER_SERVER_TIMEOUT_MS);
  if (Number.isFinite(set) && set > 0) return set;
  return body !== undefined && JSON.stringify(body).length >= UPLOAD_BYTES ? UPLOAD_TIMEOUT_MS : SERVER_TIMEOUT_MS;
}

// The limit in seconds, as an error names it.
export const secondsOf = (ms) => `${Math.round(ms / 100) / 10} s`;

// `signal` (the caller's, or none) together with the timeout.
export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Whether a fetch failed on the timeout rather than on the caller's abort.
export const timedOut = (error) => error?.name === "TimeoutError";

// `env` with Git's low-speed settings added at the next free config index, so
// any configuration it already passes this way (a token's header) still holds.
export function lowSpeedEnv(env = process.env) {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10) || 0;
  return {
    ...env, GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: "http.lowSpeedLimit", [`GIT_CONFIG_VALUE_${n}`]: String(LOW_SPEED_BYTES),
    [`GIT_CONFIG_KEY_${n + 1}`]: "http.lowSpeedTime", [`GIT_CONFIG_VALUE_${n + 1}`]: String(LOW_SPEED_SECONDS),
  };
}

// Git's own words when the low-speed floor cut a transfer.
export const tooSlow = (text) => /too slow|lowspeed|timed out|timeout was reached/i.test(text ?? "");
