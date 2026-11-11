# t682: criterion 1 test, red on main, then green

Local `main` has no branch in this workspace; its tip is the merge base
`4a0ab001` (the commit merged into t682 at `0b1d4945`). I took `cli/runner.mjs`,
`src/ledger.ts` and `src/tokens.ts` from it. `src/ledger.ts` is identical on
both; `cli/runner.mjs` and `src/tokens.ts` differ.

## Red: main's files

    git checkout 4a0ab001 -- cli/runner.mjs src/ledger.ts src/tokens.ts
    node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- node --test --test-name-pattern="strictly behind" test/land-queue.test.mjs

Output (exit 1):

    ✖ t682: a clean checkout strictly behind the baseline fetches with the baseline's credential, fast-forwards, then lands (245.612458ms)
    ℹ tests 1
    ℹ pass 0
    ℹ fail 1

    test at test/land-queue.test.mjs:425:1
      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

      0 !== 1

          at TestContext.<anonymous> (file:///.../test/land-queue.test.mjs:427:10)

Line 427 is `assert.equal(c.lands.length, 1)`: on main the lander refuses the
behind checkout and `land()` never runs.

## Green: the files restored

    git checkout HEAD -- cli/runner.mjs src/tokens.ts src/ledger.ts
    node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- node --test --test-name-pattern="strictly behind" test/land-queue.test.mjs

Output:

    ✔ t682: a clean checkout strictly behind the baseline fetches with the baseline's credential, fast-forwards, then lands (355.288208ms)
    ℹ tests 1
    ℹ pass 1
    ℹ fail 0

Not run here: the full suite and the typecheck (this round changes no code); the runner runs them after the commit.
