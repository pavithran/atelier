#!/usr/bin/env node
// atelier-agy MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the Antigravity adapter
// a runner runs by default (cli/harness/adapter.mjs; docs/runners.md).
import { runAdapter } from "../../cli/harness/adapter.mjs";

process.exitCode = runAdapter("antigravity", process.argv.slice(2));
