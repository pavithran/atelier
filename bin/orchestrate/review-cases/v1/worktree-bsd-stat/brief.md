Read only: change no file, commit nothing, push nothing, run no atelier command. You may run the project's tests (node --test FILES, npx vitest run FILES).

You review a change to Atelier (a Git platform on Cloudflare for coding agents). The workspace is the project at 95b71f9a with the change applied but not committed (git diff shows it; the same diff is below). The task and its acceptance criteria:

Task t678: bin/orchestrate/run-agent.sh fails in a linked git worktree, because there `.git` is a file (a "gitdir:" pointer), not a directory. Line 15 writes to "$ws/.git/info/exclude", which fails there.
Fix: resolve the exclude file with git itself (git rev-parse --git-path info/exclude; note it may be relative to the workspace in a plain clone and absolute in a worktree, and its folder may not exist), and keep the same behaviour in a plain clone. Change nothing else in the script.
Acceptance: run-agent.sh starts the agent in a linked worktree and in a plain clone; a test in test/orchestrate-stdin.test.mjs, written like the existing run-agent.sh test there (same stand-in helper, same HOME setup), creates a repo, adds a linked worktree with `git worktree add`, runs run-agent.sh glm against the worktree with the stand-in agent, and asserts the agent ran and `.scratch/` is listed in the exclude file git uses for that worktree. It must fail on the current script.

Check that each criterion is met, that each new test fails without the fix (reason it through or run it), that nothing else regresses, and that the fix cannot be bypassed. Report each finding as a line 'FINDING: blocking|followup file:line text' (blocking means a criterion not met or a real defect).

Your reply MUST end with exactly one line: VERDICT: APPROVE or VERDICT: REJECT
