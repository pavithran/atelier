#!/usr/bin/env node
// atelier-opencode [--providers DIR] [--secret-store NAME] [--secrets-dir DIR]
// MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the opencode adapter a runner runs
// by default, with the provider configs `atelier runner setup` wrote in DIR
// and its keys read from the runner's credential store (cli/harness/adapter.mjs;
// docs/runners.md).
import { spawnSync } from "node:child_process";
import { readSecret } from "../../cli/credentials.mjs";
import { parseArgs, runAdapter, storeEnv } from "../../cli/harness/adapter.mjs";

const argv = process.argv.slice(2);
process.exitCode = runAdapter("opencode", argv, {
  secret: (name) => readSecret(name, {
    env: storeEnv(process.env, parseArgs(argv).options),
    // A locked Keychain or unresponsive Secret Service can wait for user
    // interaction before the harness ever starts. Bound only credential
    // commands, not the build itself; SIGKILL also ends an unresponsive helper.
    spawn: (command, args, options) => {
      const result = spawnSync(command, args, { ...options, timeout: 5_000, killSignal: "SIGKILL" });
      if (result.error?.code === "ETIMEDOUT") {
        // Credential output may contain secrets, so never include it here.
        throw new Error(`credential command ${command} timed out after 5000 ms (signal ${result.signal})`);
      }
      return result;
    },
  }),
});
