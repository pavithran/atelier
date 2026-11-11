# t702: the criterion tests, red on main and green at the head

No code changed in this round. Both runs use the tests at head 2038a039. The
"main" run puts `src/secret-scan.ts` from main (a8ff91e8, which has no t702
change) in the working tree, runs the tests, then restores the head's file.

Command, both runs (inside a test slot):

    node '/Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs' -- node test/run.mjs test/git-scan.test.mjs test/secret-scan.test.ts

## Red on main (`git checkout a8ff91e8 -- src/secret-scan.ts`)

Exit 1. `ℹ pass 35`, `ℹ fail 5`. Failing tests:

- test/git-scan.test.mjs:241 `a 1 MB random .bin with no key pattern passes the push scan, and one with a key in its bytes refuses` (criteria 1 and 2, through the push scan)
- test/secret-scan.test.ts `a key inside an image's bytes is still a hit, and other binaries still block, while a media name is never flagged`
- test/secret-scan.test.ts `a false or truncated image signature under a neutral name is scanned as bytes, whatever the format`
- test/secret-scan.test.ts `a PNG, JPEG, MP4 and WebP add no flag, at any size, while an oversized text file and an unknown binary still do`
- test/secret-scan.test.ts `a 1 MB random .bin with no key pattern records nothing, and one with a key written into it is a hit` (criteria 1 and 2, unit level)

The push-scan failure for criterion 1, at test/git-scan.test.mjs:250 (the
push itself is accepted; `recordPush` then records an unscanned flag):

    AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    + actual - expected
    + [
    +   {
    +     by: 'atelier/hook',
    +     file: 'pack.bin',
    +     line: 0,
    +     reason: 'binary content',
    +     unscanned: true
    +     (commit, head, fingerprint and at omitted here)
    +   }
    + ]
    - []

## Green at the head (`git checkout HEAD -- src/secret-scan.ts`)

Exit 0. `ℹ tests 40`, `ℹ pass 40`, `ℹ fail 0`.

Not run here: the full suite and the typecheck (the runner runs them after the
commit). The house-style file could not be read in this workspace.
