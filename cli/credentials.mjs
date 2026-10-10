// Where Atelier's CLI keeps its secrets, the same way on every system. A
// secret is named by a short key such as API_TOKEN. The stores, in the order
// they are chosen:
//
//   macOS    the Keychain, through `security` (item atelier.API_TOKEN, its
//            access list naming /usr/bin/security alone)
//   Linux    the Secret Service, through `secret-tool`, when it is installed
//            and a session bus is available (service atelier, account NAME)
//   other    a file under the user's config directory, mode 0600
//
// ATELIER_SECRET_STORE=file|keychain|secret-service picks a store outright.
//
// Windows uses the file. Credential Manager is reachable from PowerShell only
// by compiling a P/Invoke wrapper with Add-Type, which this project has no way
// to test, so it is not used. A file's mode is not checked there: Windows
// reports POSIX modes that mean nothing, and %APPDATA% belongs to the user.
//
// The environment variable for a secret (ATELIER_TOKEN for API_TOKEN) wins
// over every store. A value goes to a store on its stdin, never in an
// argument list, which other users can read. No message here carries a value.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const ENV_NAMES = { API_TOKEN: "ATELIER_TOKEN" };
export const envNameFor = (name) => ENV_NAMES[name] ?? `ATELIER_${name}`;

// The owner's credential, by every name this store reads it under: API_TOKEN
// (the entry `atelier login` writes), and any name whose environment variable
// is the owner's ATELIER_TOKEN. A runner's reviewer token (runner.mjs,
// t346) may never be one of these, so the names are refused in its config
// and at read time, case-insensitively.
export const OWNER_SECRET = "API_TOKEN";
export function isOwnerSecretName(name) {
  const upper = String(name).toUpperCase();
  return upper === OWNER_SECRET || envNameFor(upper) === envNameFor(OWNER_SECRET);
}

// What a store may be handed: one line of printable text.
function assertValue(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("a secret must be one line of text with no control characters");
  }
}

function defaults() {
  return { platform: process.platform, env: process.env, spawn: spawnSync, home: homedir(), user: () => userInfo().username };
}

export function secretsFile(d = defaults()) {
  if (d.env.ATELIER_CONFIG_DIR) return join(d.env.ATELIER_CONFIG_DIR, "secrets.json");
  if (d.platform === "win32" && d.env.APPDATA) return join(d.env.APPDATA, "atelier", "secrets.json");
  return join(d.env.XDG_CONFIG_HOME || join(d.home, ".config"), "atelier", "secrets.json");
}

function sessionBus(d) {
  return !!d.env.DBUS_SESSION_BUS_ADDRESS || (!!d.env.XDG_RUNTIME_DIR && existsSync(join(d.env.XDG_RUNTIME_DIR, "bus")));
}

// "secret-tool" is installed when running it does not fail to start.
function hasSecretTool(d) {
  const r = d.spawn("secret-tool", ["--help"], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  return !r.error;
}

// ATELIER_SECRET_STORE=file (or keychain, secret-service) names a store
// outright, for someone who wants the file on a system with a native store.
export function chooseBackend(d = defaults()) {
  const named = d.env.ATELIER_SECRET_STORE;
  if (named && named in BACKENDS) return named;
  if (d.platform === "darwin") return "keychain";
  if (d.platform === "linux" && sessionBus(d) && hasSecretTool(d)) return "secret-service";
  return "file";
}

// The store in words, for `atelier login --store`: never a value.
export function describeStore(name = "API_TOKEN", deps = {}) {
  const d = { ...defaults(), ...deps };
  const backend = chooseBackend(d);
  return backend === "keychain" ? `the macOS Keychain, item atelier.${name}`
    : backend === "secret-service" ? `the Linux Secret Service, service atelier, account ${name}`
    : `the file ${secretsFile(d)}`;
}

// ── backends ───────────────────────────────────────────────────────────────

const keychain = {
  read(name, d) {
    const r = d.spawn("security", ["find-generic-password", "-s", `atelier.${name}`, "-w"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  },
  // `security -i` takes its commands from stdin, which keeps the value out of
  // the argument list; the value is quoted for its parser. -U updates an
  // existing item, and -T names the one application that may read the item
  // without asking: /usr/bin/security itself, which is how this CLI reads it.
  // Without -T any process the owner runs could read the value the same way,
  // silently; running atelier login again applies the list to an item made
  // before it was given.
  write(name, value, d) {
    const quote = (s) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
    const line = `add-generic-password -U -T /usr/bin/security -s ${quote(`atelier.${name}`)} -a ${quote(d.user())} -w ${quote(value)}\n`;
    const r = d.spawn("security", ["-i"], { input: line, encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error(`could not write to the macOS Keychain (security exited ${r.status ?? "without starting"})`);
  },
};

const secretService = {
  read(name, d) {
    const r = d.spawn("secret-tool", ["lookup", "service", "atelier", "account", name], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  },
  write(name, value, d) {
    const r = d.spawn("secret-tool", ["store", "--label", `Atelier ${name}`, "service", "atelier", "account", name], { input: value, encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error(`could not write to the Linux Secret Service (secret-tool exited ${r.status ?? "without starting"})`);
  },
};

// A file the owner alone can read. Where POSIX modes apply, a wider mode is
// refused rather than repaired: someone may already have read it.
function checkMode(file, d) {
  if (d.platform === "win32") return;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${file} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${file}`);
  }
}

function readFileStore(d) {
  const file = secretsFile(d);
  if (!existsSync(file)) return {};
  checkMode(file, d);
  try { return JSON.parse(readFileSync(file, "utf8")) ?? {}; }
  catch { throw new Error(`${file} is not valid JSON`); }
}

const fileStore = {
  read(name, d) {
    const value = readFileStore(d)[name];
    return typeof value === "string" && value ? value : null;
  },
  write(name, value, d) {
    const file = secretsFile(d);
    const all = readFileStore(d);
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ ...all, [name]: value }, null, 2) + "\n", { mode: 0o600 });
    if (d.platform !== "win32") chmodSync(file, 0o600);
  },
};

const BACKENDS = { keychain, "secret-service": secretService, file: fileStore };

// ── the interface ──────────────────────────────────────────────────────────

// The secret's value, or null when none is stored. Throws if the store is
// unreadable, such as a file with a wide mode.
export function readSecret(name, deps = {}) {
  const d = { ...defaults(), ...deps };
  const fromEnv = d.env[envNameFor(name)];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return BACKENDS[chooseBackend(d)].read(name, d);
}

// Stores the value and returns where it went, in words.
export function writeSecret(name, value, deps = {}) {
  assertValue(value);
  const d = { ...defaults(), ...deps };
  BACKENDS[chooseBackend(d)].write(name, value, d);
  return describeStore(name, d);
}

// A secret typed at a terminal is read without echo; one piped in is its first
// line. The prompt goes to stderr so a pipe's stdout stays clean.
export async function promptSecret(question, input = process.stdin, output = process.stderr) {
  if (!input.isTTY) {
    let text = "";
    input.setEncoding("utf8");
    for await (const chunk of input) text += chunk;
    return text.split(/\r?\n/)[0].trim();
  }
  output.write(question);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (fn, v) => { input.setRawMode(false); input.pause(); input.off("data", onData); output.write("\n"); fn(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(resolve, typed.trim());
        if (ch === "\u0003") return done(reject, new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    input.on("data", onData);
  });
}

export function normalizeRunner(name) {
  const value = String(name).includes(":") ? String(name).toLowerCase() : `home:${String(name).toLowerCase()}`;
  if (!/^(home|cloud):[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error("runner needs home:NAME or cloud:NAME");
  return value;
}

// A stored runner credential carries its server in the same secret entry.
// An explicit empty/invalid environment credential is an error, never a
// request to try the owner's credential instead.
export function runnerCredential(server, name, deps = {}) {
  const env = deps.env ?? process.env;
  if (Object.hasOwn(env, "ATELIER_RUNNER_TOKEN") && env.ATELIER_RUNNER_TOKEN !== undefined) {
    const token = env.ATELIER_RUNNER_TOKEN.trim();
    if (!token) throw new Error("ATELIER_RUNNER_TOKEN is empty");
    return token;
  }
  if (!name) return null;
  const key = `runner.${normalizeRunner(name)}`;
  const raw = (deps.read ?? readSecret)(key, { ...deps, env: { ...env, [envNameFor(key)]: undefined } });
  if (!raw) throw new Error(`no runner credential in ${key}; store one with token store --runner ${name}`);
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error(`${key} has no server binding; store it again`); }
  if (record.server !== server.replace(/\/+$/, "") || typeof record.token !== "string" || !record.token) throw new Error(`${key} is not bound to this server`);
  return record.token;
}

export function storeRunnerCredential(server, name, token, deps = {}) {
  return writeSecret(`runner.${normalizeRunner(name)}`, JSON.stringify({ server: server.replace(/\/+$/, ""), token }), deps);
}

export function runnerChildEnv(base, name, credential, override) {
  return { ...base, ATELIER_RUNNER_NAME: normalizeRunner(name), ...(credential ? { ATELIER_RUNNER_TOKEN: credential } : {}),
    ...(override ? { ATELIER_TOKEN: override, ATELIER_RUNNER_TOKEN: override } : {}) };
}
