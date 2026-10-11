#!/usr/bin/env node
// atelier-opencode [--providers DIR] [--secret-store NAME] [--secrets-dir DIR]
// MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the opencode adapter a runner runs
// by default, with the provider configs `atelier runner setup` wrote in DIR
// and its keys read from the runner's credential store (cli/harness/adapter.mjs;
// docs/runners.md).
// It reports a provider's usage limit as the runner reads it (limit.mjs).
import { runWithLimits } from "./limit.mjs";

process.exitCode = runWithLimits("opencode", process.argv.slice(2));
