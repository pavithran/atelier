#!/usr/bin/env node
// atelier-agy MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the Antigravity adapter
// a runner runs by default (cli/harness/adapter.mjs; docs/runners.md).
// It reports a provider's usage limit as the runner reads it (limit.mjs).
import { runWithLimits } from "./limit.mjs";

process.exitCode = runWithLimits("antigravity", process.argv.slice(2));
