t480 fixes restrictive pool creation and crash-journal permissions. The pool
now lives at `/tmp/atelier-test-slots-v2/pool.sqlite`, in a mode 0777 directory
without the sticky bit. Its file is created and, when owned by the caller,
kept at mode 0666. SQLite writes run synchronously with umask 0, so journals
are shared too; the caller's umask is restored on return or error.

The PID finding is covered by a regression: a forged active entry names an
unrelated live PID under the wrapper's own lease. The victim survives cleanup.
The existing implementation already selects and rechecks live process nonces
before signalling; it never uses the entry's PID as authority. That code did
not need changing. The t180 inaccessible-pool cleanup behavior still passes.

Commands below used the host slot wrapper as a prefix:
`node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' --`.

- Before implementation, `node --test test/load-sharing.test.mjs` exited 1:
  `tests 3`, `pass 1`, `fail 2`. The host-directory assertion found `/tmp`;
  the sharing assertion found mode 0750 rather than 0777. An earlier version
  of that test also demonstrated that a missing directory was not created.
- After implementation, the same command exited 0: `tests 3`, `pass 3`,
  `fail 0`. The final tests cover both creator umasks 077 and 027, verify
  directory/database/journal permissions, kill a writer before COMMIT,
  verify a nonzero hot-journal header, recover the old capacity and write
  again. The uncommitted capacity 999 never becomes visible after the crash.
- The first focused run found the old inaccessible-pool fixture was now
  accessible because missing directories are created. It now creates the
  database first, then tries to use that file as a directory. A later run
  found the session-isolation guard needed to run before file preparation;
  its interception point was moved before the first filesystem operation.
- Final focused command, with `TMPDIR="$PWD/.scratch"`:
  `node test/run.mjs test/load-sharing.test.mjs test/load.test.mjs test/load-process.test.mjs test/load-cli.test.mjs test/check-load.test.mjs test/check-limit.test.mjs test/slot-isolation.test.mjs test/test-slot-brief.test.mjs test/cli-sessions-isolation.test.mjs`.
  Output: `tests 78`, `pass 78`, `fail 0`, `duration_ms 26171.447458`, exit 0.
- `npm run typecheck` passed, exit 0:
  `tsc -p . && tsc -p test`.
- Full suite command, with the same TMPDIR and
  `ATELIER_TEST_TIMEOUT_MS=3600000`, was
  `node -e 'console.log("slot_acquired", Date.now()); const {spawnSync}=require("node:child_process"); const r=spawnSync("npm", ["test"], {stdio:"inherit",timeout:3600000,killSignal:"SIGKILL"}); console.log("suite_ended", Date.now()); process.exit(r.status ?? 1)'`.
  It printed `slot_acquired 1793738120796` and
  `suite_ended 1793738178675`: under one second queued, 57.879 seconds running.
  It was stopped with SIGTERM, exit 143, after unrelated failures, as required;
  it did not time out or pass. The review-bake failures are already recorded
  in `test/t451-validation.md` and `test/t472-validation.md`.

Unfixed failures observed in the full suite:

- `review-bake.sh gives a Codex reviewer the same blind brief and diff on standard input, read-only, and records the reply`
- `review-bake.sh tries a reply with no verdict again and records a second miss as failed; --skip runs nothing`
- `the runner keeps and collects exactly the replies the scorer reads a verdict in`
- `a protected change with no qualifying reviewer waits on the owner in every view, and goes back to review once one qualifies`

Their streamed output marked each with `✖`; the stopped suite did not print
its final assertion details. No unrelated implementation was changed.

The public function signatures and stored entry format are unchanged. Direct
production callers are `cli/atelier.mjs`, `cli/runner.mjs`, and
`cli/commands/{slots,status,check,wrap,merge}.mjs`; all resolve the pool through
this module and need no call changes. Focused tests cover slot status and
capacity, check/wrap sequences, admission, nested reuse, and generated runner
brief commands. No generated page consumes the path. The test copies in
`guard`, `cli-sessions-shared`, `check-limit`, `check-load`, `load-cli`,
`load-process`, `slot-isolation` and `test-slot-brief` were updated to the new
literal; their relevant checks pass. CLI help and runners documentation name
the new path. `docs/test-slots.md` still names the old path; that file is
outside this task's allowed scope.

Local tests use one OS account. They establish the other-user permission bits
and crash recovery, but cannot establish Studio ACLs, actual handoff between
atelier-build and pavi, or reboot behavior. The project declares remote checks
before deployment and live verification afterward (see
`docs/atelier/runner-refresh.md`). Before and after deployment, smoke-test
creation and recovery as both users, including a killed writer and fresh
creation after reboot. Drain old wrappers and update both accounts together:
v1 and v2 do not coordinate, and v2 starts with fresh capacity. No remote
check or deployment was performed here.

No routes, visibility levels or UI changed; trust/disclosure matrices and
screenshots do not apply. No completion marker was introduced. The referenced
house-style file was unavailable in this workspace and could not be read;
prose uses plain wording. No push or atelier command was run.
