import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareReviewDependencies, installEvidenceDependencies } from "../cli/runner.mjs";

for (const kind of ["review", "evidence"]) {
  const install = (dir, run) => kind === "review"
    ? prepareReviewDependencies(dir, join(dir, "absent"), { executeChild: run })
    : installEvidenceDependencies(dir, join(dir, "absent"), { run });
  for (const lock of ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", null]) {
    const command = lock === "pnpm-lock.yaml" ? ["pnpm", "install", "--frozen-lockfile"]
      : ["npm", lock || kind === "evidence" ? "ci" : "install", ...(kind === "evidence" ? ["--prefer-offline"] : []), "--no-audit", "--no-fund"];
    const fixture = (t) => {
      const dir = mkdtempSync(join(tmpdir(), "runner-dependency-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { example: "1" } }));
      if (lock) writeFileSync(join(dir, lock), "{}");
      return dir;
    };
    test(`${kind} installs with ${lock ?? "no lockfile"}`, async (t) => {
      const dir = fixture(t), calls = [];
      await install(dir, async (argv, options) => {
        calls.push(argv);
        assert.equal(options.cwd, dir);
        return { code: 0 };
      });
      assert.deepEqual(calls, [command]);
    });
    for (const outcome of ["failed", "timed out", "could not start"]) {
      test(`${kind} setup names ${command.join(" ")} when it ${outcome}`, async (t) => {
        const dir = fixture(t);
        await assert.rejects(install(dir, async () => {
          if (outcome === "could not start") throw new Error("spawn ENOENT");
          return outcome === "failed" ? { code: 1, stderr: "ERESOLVE" } : { code: null, timedOut: true };
        }), (error) => {
          assert.match(error.message, /runner.s .*dependency setup/);
          assert.ok(error.message.includes(command.join(" ")), error.message);
          assert.ok(error.message.includes(outcome), error.message);
          return true;
        });
      });
    }
  }
}
