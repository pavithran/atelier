# Miqra's visual journeys on the Studio build runner (t570)

Finding written 2026-11-08 as `atelier-build` on `ai-studio-256`. Miqra main was
`b585cb41`. The reproduction was a scratch clone of it, installed with `npm ci`,
run through the test slot wrapper. Raw output was kept in the workspace under
`.scratch/` and is not committed. Run-log lines below are lines of
`/Users/atelier-build/log/studio-miqra-build.log`.

## What was found

**A setup gap, closed by one script: builders cannot find `lsof`.**
`~/.config/atelier/studio-miqra-2026-11/start-build.zsh:9` sets
`PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`. `lsof`
lives in `/usr/sbin`. Miqra's gate (`scripts/verify-miqra-io.mjs:87`, through
`scripts/verification-runtime.mjs:52`) checks who owns its port with `lsof` before
any journey runs. The same `PATH` line is in every Studio build runner's start
script (atelier, miqra, tapestries, walters-coach). The control loop's own `PATH`
(`/Users/atelier-build/control/loop.zsh:10`) does include `/usr/sbin`, which is why
only builder processes are affected.

Reproduction, same clone, same command, only `PATH` differs:

| `PATH` | Command | Result |
| --- | --- | --- |
| runner's (no `/usr/sbin`) | `VERIFY_JOURNEYS=010-signin.mjs,030-members.mjs,040-editor.mjs ... node scripts/verify-miqra-io.mjs` | exit 1, `Error: Cannot verify server ownership on http://localhost:5635: spawn lsof ENOENT` before any journey (`repro-040-nousrsbin.log:16`) |
| plus `/usr/sbin` | same | exit 0, `miqra.io gate passed for 3 journeys: 54 checks` (`repro-040.log:136`); 040-editor 8.5 s, pass |

The builders met this: the t85-era run log says "`lsof` isn't on this environment's
`PATH`, so I appended `/usr/sbin`" (line 843929), and t82 ("the sandbox `PATH` needing
`/usr/sbin` for `lsof`") at line 847875. Each builder had to find and work around it.

## Journey 040 (criterion 1, partly met)

- Not reproduced. With `/usr/sbin` on `PATH`, 040-editor passed on a first run and on a
  rerun in the same clone (`repro-040.log:136`, `repro-040-rerun.log:132`), and passed
  in the 11-journey run (`repro-247.log:587`).
- What the logs say: t82 reports `040-editor` timing out on
  `.me-verse.is-flash[data-v="9"]` "every time" after the first run (lines 847881 and
  847892); t85 reports the same at `040-editor.mjs:147` on an unmodified checkout
  (lines 848056 and 848079). Line 147 is the wait after reopening Genesis 1.
- I did not find why those workspaces failed where this clone did not. The
  `lsof` gap does not explain it: the builders had already worked around it. Their
  workspaces also had no corpus (t85 saw 503s on `/admin/miqra/obadiah/1`); this
  clone has the same repository files and passed. The next step is to rerun in a
  builder's own workspace with the sandbox they ran under. That was not possible here.

## Journey 247 (criterion 1, partly met)

- `247-everyday-t3` passed (`repro-247.log:586`).
- `247-member-pages-design-t75` failed in my run, at `today 375 light`: the `ESV` link
  (`a.day-esv`, 18 px high) fails "every target is 44px or more" and two sibling checks
  (`repro-247.log:275-277`). That link renders only when `ESV_API_KEY` is set
  (`src/components/McheyneReadings.astro:53,185`), and the server logged
  `esv-fetch-failed ... 403` throughout. I did not find where a key reached the dev
  server in this environment, so I cannot say whether the Mac renders the link.
  I have not shown this is a runner difference rather than a defect in the journey.
- The 503s on `/admin/miqra/obadiah/1` (`repro-247.log:429`) also appear in my run,
  where the journey requests that page as its "offline" case (`247-member-pages-design-t75.mjs:51`).
  They are not a runner difference.
- t85 named 247, 249, 266, 252, 253, light theme and sandbox. Only 247 was run here.
  249, 266, 252 and 253 were not reproduced.

## The fix (criterion 2, not yet shown)

`scripts/studio/fix-build-runner-path.sh` adds `:/usr/sbin:/sbin` to the `PATH` line
of each `start-build*.zsh` in the folders it is given. It leaves any file whose line
is not the known one unchanged and says so, is safe to run twice, and keeps the file
mode. `test/build-runner-path.test.mjs` covers each of those.

The start scripts are outside this task's workspace, so the script was **not run
against them**. Someone with access runs, as `atelier-build` on the Studio:

```
sh scripts/studio/fix-build-runner-path.sh ~/.config/atelier/studio-*-2026-11
```

then restarts the runners (the start scripts are read at launch). After that, the
check is: the 040 and 247 journeys run from a builder workspace on
`home:studio-miqra-build` at Miqra main, with no manual `PATH` edit. Until that run,
criterion 2 is unproven, and the remaining 040 and 247 failures above may stay.

## Criterion 3

Not built. The cause found is fixable on the runner, so a per-runner "unrunnable
check" declaration is not justified by this evidence. If the 040 timeout still
appears after the `PATH` fix and turns out to be the sandbox, that decision reopens.

## Not checked

The house style file could not be read from this workspace, so this prose follows
no checked standard beyond being plain.
