// What the parts of fast.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANIFEST_PATH } from "./merge-pipeline.mjs";
export const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
export function repo(name = null) {
  let dir = mkdtempSync(join(tmpdir(), "fast-land-"));
  if (name) { dir = join(dir, name); mkdirSync(dir); }
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "start");
  const branch = (name, file, agent) => {
    git(dir, "checkout", "-q", "-b", name, "main");
    writeFileSync(join(dir, file), `${name}\n`);
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", `${name}\n\nAgent: ${agent}`);
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    return sha;
  };
  return { dir, one: branch("one", "one.txt", "claude-code/opus-5.5"), two: branch("two", "two.txt", "codex/gpt-6") };
}
export const base = { titles: { t1: "One", t2: "Two" }, reason: "forks fail", typecheck: "true", regen: null };
export const GENERATOR = `import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const names = readdirSync("cmds").sort().map((f) => /^name: (\\S+)/m.exec(readFileSync("cmds/" + f, "utf8"))[1]);
mkdirSync("out", { recursive: true });
writeFileSync("out/index.txt", names.map((n) => n + "\\n").join(""));
`;
export function generatedRepo(generator = GENERATOR) {
  const dir = mkdtempSync(join(tmpdir(), "fast-land-gen-"));
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    execFileSync(process.execPath, ["gen.mjs"], { cwd: dir });
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  git(dir, "init", "-q", "-b", "main");
  commit({ "gen.mjs": generator, [MANIFEST_PATH]: JSON.stringify(MANIFEST, null, 2), ".gitattributes": "out/index.txt merge=atelier-generated\n", "cmds/help.txt": "name: help\n" }, "start");
  const branch = (name, agent) => {
    git(dir, "checkout", "-q", "-b", name, "main");
    const sha = commit({ [`cmds/${name}.txt`]: `name: ${name}\n` }, `Add the ${name} command\n\nAgent: ${agent}`);
    git(dir, "checkout", "-q", "main");
    return sha;
  };
  return { dir, push: branch("push", "claude-code/opus-5.5"), land: branch("land", "codex/gpt-6") };
}
export const KEY = `AWS_KEY=AKIA${"Q".repeat(16)}\n`;
export const inCheckout = {
  rebase: { dir: "rebase-merge", enter: (id) => `git ${id} rebase -q --exec false HEAD^ >/dev/null 2>&1; test -d .git/rebase-merge`,
    // paused before the late commit is replayed, so late.bin is absent
    enterBefore: (id) => `git ${id} rebase -q --exec false HEAD~2 >/dev/null 2>&1; test -d .git/rebase-merge` },
  bisect: { dir: "BISECT_START", enter: () => `git bisect start HEAD HEAD~2 >/dev/null 2>&1 && test -f .git/BISECT_START` },
};
export const MANIFEST = { version: 1, generators: [{ name: "index", command: [process.execPath, "gen.mjs"], inputs: ["cmds/**", "gen.mjs"], outputs: ["out/index.txt"] }], records: [], registries: [] };
export function leakBranch(dir, commits) {
  git(dir, "checkout", "-q", "-b", "leak", "main");
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(dir, path));
      else writeFileSync(join(dir, path), content);
    }
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "leak\n\nAgent: codex/gpt-6");
  }
  const sha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return sha;
}
