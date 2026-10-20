import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { requiredForCommand } from "../src/route-level.ts";

// t136's finding (found during t772's cut-over): registeredHere in
// cli/atelier.mjs called real(p.path) for every local config entry, so one
// entry without a path (a project with no checkout on this Mac) stopped
// every command with "The paths[0] argument must be of type string.
// Received undefined", and an entry with an empty path matched the current
// folder, since resolve("") is the cwd. Commands that need a named entry's
// checkout (merge, sync, pull, branch, notes-remote, record-merge) ran git
// in whatever folder they were started in. These tests drive the CLI with a
// temporary config and checkouts; only the version preflight some commands
// make is answered, by a local server, since every refusal comes before the
// first real request.

const cli = resolve("cli/atelier.mjs");

// spawn, not spawnSync: the CLI's first request is made while this process
// keeps its event loop, as every command the tests start does (test/run.mjs).
async function run(argv, configDir, cwd) {
  const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ATELIER_CONFIG_DIR: configDir, ATELIER_TOKEN: "test-token" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (x) => stdout += x);
  child.stderr.on("data", (x) => stderr += x);
  const status = await new Promise((resolve) => child.on("close", resolve));
  return { status, stdout, stderr };
}

async function withConfig(projects, fn) {
  const configDir = mkdtempSync(join(tmpdir(), "atelier-entry-cfg-"));
  try {
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ server: null, projects }));
    return await fn(configDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

// Answers the one request these commands make before the refusal: the
// version preflight GET /api/version, with every capability the three
// commands it is asked for declare (the same table the CLI checks against).
const PREFLIGHT_CAPABILITIES = [...new Set([
  ...requiredForCommand("merge"),
  ...requiredForCommand("branch", "push"),
  ...requiredForCommand("record-merge"),
])];

function versionServer() {
  return new Promise((start) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ capabilities: PREFLIGHT_CAPABILITIES }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => start({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("a command finds this checkout registered behind entries with no usable path", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "atelier-entry-repo-"));
  try {
    spawnSync("git", ["init", "--quiet"], { cwd: checkout });
    await withConfig({ none: {}, empty: { path: "" }, number: { path: 7 }, demo: { path: checkout } }, async (configDir) => {
      const r = await run(["notes-remote"], configDir, checkout);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^demo: notes stay local and in Artifacts\./);
    });
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a config holding only unusable paths registers no checkout, and an empty path never matches the current folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-entry-only-"));
  try {
    spawnSync("git", ["init", "--quiet"], { cwd: dir });
    await withConfig({ ghost: { path: "" }, none: {} }, async (configDir) => {
      const r = await run(["notes-remote"], configDir, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /is not a registered checkout or a task workspace/);
      assert.equal(r.stdout, "");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that needs the named entry's checkout refuses an unusable path before any checkout operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-entry-refuse-"));
  // fresh: true is what makes record-merge reach its checkout at all;
  // every command here dies before anything else reads it.
  const projects = { none: { fresh: true }, empty: { path: "", fresh: true } };
  const sha = "a".repeat(40);
  const refuses = (r, name, argv) => {
    assert.equal(r.status, 1, `${argv.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${name} has no checkout on this Mac; make one with atelier clone ${name}`));
    assert.equal(r.stdout, "");
    assert.doesNotMatch(r.stderr, /paths\[0\]|fetch failed|ECONNREFUSED|ENOTFOUND/, argv.join(" "));
  };
  try {
    // sync, pull and notes-remote declare no server capabilities, so they
    // reach their refusal with no server configured at all.
    await withConfig(projects, async (configDir) => {
      for (const [name, argv] of [
        ["none", ["sync", "--project", "none"]],
        ["empty", ["sync", "--project", "empty"]],
        ["none", ["pull", "--project", "none"]],
        ["none", ["notes-remote", "origin", "--project", "none"]],
      ]) refuses(await run(argv, configDir, dir), name, argv);
    });
    // merge, branch and record-merge ask the server's version first.
    const { server, url } = await versionServer();
    const configDir = mkdtempSync(join(tmpdir(), "atelier-entry-cfg-"));
    try {
      writeFileSync(join(configDir, "config.json"), JSON.stringify({ server: url, projects }));
      for (const [name, argv] of [
        ["none", ["merge", "t9", "--project", "none"]],
        ["none", ["branch", "push", "wip/x", "--project", "none"]],
        ["empty", ["branch", "push", "wip/x", "--project", "empty"]],
        ["none", ["record-merge", "t9", "--merge", sha, "--review", `h/m=approve@${sha}`, "--project", "none"]],
      ]) refuses(await run(argv, configDir, dir), name, argv);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that works without a checkout still works for an entry with no path", async () => {
  await withConfig({ demo: {} }, async (configDir) => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-entry-off-"));
    try {
      const r = await run(["notes-remote", "--off", "--project", "demo"], configDir, dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /demo: provenance notes stay local and in Artifacts\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
