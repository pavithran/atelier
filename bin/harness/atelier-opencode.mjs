#!/usr/bin/env node
// atelier-opencode [--providers DIR] MODEL BRIEF WORKSPACE PLAN DIFF VERDICT:
// the opencode adapter a runner runs by default, with the provider configs
// `atelier runner setup` wrote in DIR (cli/harness/adapter.mjs; docs/runners.md).
import { runAdapter } from "../../cli/harness/adapter.mjs";

process.exitCode = runAdapter("opencode", process.argv.slice(2));
