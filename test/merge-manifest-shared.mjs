// What the parts of merge-manifest.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MANIFEST_PATH } from "../cli/merge-driver.mjs";
import { runGroup } from "../cli/group.mjs";
import { commandFiles, handlerIndex, specIndex } from "../cli/regenerate.mjs";
export const root = resolve(".");
export const SPECS = "src/usage/commands", HANDLERS = "cli/commands";
export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-own-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ["cli", "src", "test/fixtures/cli", "package.json", ".gitattributes", MANIFEST_PATH]) cpSync(join(root, part), join(dir, part), { recursive: true });
  if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  git(dir, "init", "-q", "-b", "main");
  appendFileSync(join(dir, ".git/info/exclude"), "node_modules\n");
  git(dir, "config", "commit.gpgsign", "false");
  // No automatic gc: a detached `git gc --auto`, which a commit starts once
  // the loose objects pass its estimate, still writes .git/objects/pack while
  // the cleanup removes the folder, and the rm fails with ENOTEMPTY (t571,
  // whose two new command files tipped the copied tree over it).
  git(dir, "config", "gc.auto", "0");
  git(dir, "config", "maintenance.auto", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}
export function sides(dir, theirs, ours, opts) {
  git(dir, "tag", "base");
  addCommands(dir, "theirs", theirs, opts);
  addCommands(dir, "main", ours, opts);
}
export const counting = () => {
  const calls = [];
  const run = (argv, { cwd, env }) => { calls.push(argv); return runGroup(argv, { cwd, env: { ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}` } }); };
  return { run, calls };
};
export function addCommands(dir, branch, commands, { indexes = true } = {}) {
  git(dir, "checkout", "-q", "-B", branch, "base");
  for (const [file, name, word] of commands) {
    writeFileSync(join(dir, SPECS, `${file}.ts`), declaration(name));
    writeFileSync(join(dir, HANDLERS, `${file}.mjs`), handler(name, word));
  }
  if (indexes) {
    writeFileSync(join(dir, SPECS, "index.ts"), specIndex(commandFiles(dir, SPECS, ".ts")));
    writeFileSync(join(dir, HANDLERS, "index.mjs"), handlerIndex(commandFiles(dir, HANDLERS, ".mjs")));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `add ${commands.map((c) => c[1]).join(", ")}`);
}
export const declaration = (name) => `import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "${name}",
  forms: [{ group: "Local", line: 9, slot: 10, form: "${name}", about: "Says ${name}." }],
  flags: {},
  help: { example: "atelier ${name}" },
};

export default spec;
`;
export const handler = (name, word = name) => `// atelier ${name}. Its forms and help are declared in src/usage/commands/${name}.ts.
export default function command() {
  console.log("${word}");
}
`;
