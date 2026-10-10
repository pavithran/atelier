#!/usr/bin/env node
// atelier-codex MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the Codex adapter a
// runner runs by default (cli/harness/adapter.mjs; docs/runners.md).
import { runAdapter } from "../../cli/harness/adapter.mjs";

process.exitCode = runAdapter("codex", process.argv.slice(2));
