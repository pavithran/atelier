#!/usr/bin/env node
// atelier-claude MODEL BRIEF WORKSPACE PLAN DIFF VERDICT: the Claude Code
// adapter a runner runs by default (cli/harness/adapter.mjs; docs/runners.md).
import { runAdapter } from "../../cli/harness/adapter.mjs";

process.exitCode = runAdapter("claude-code", process.argv.slice(2));
