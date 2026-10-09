#!/usr/bin/env node
// atelier-opencode [--providers DIR] [--secret-store NAME] [--secrets-dir DIR]
// MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the opencode adapter a runner runs
// by default, with the provider configs `atelier runner setup` wrote in DIR
// and its keys read from the runner's credential store (cli/harness/adapter.mjs;
// docs/runners.md).
import { runAdapter } from "../../cli/harness/adapter.mjs";

process.exitCode = runAdapter("opencode", process.argv.slice(2));
