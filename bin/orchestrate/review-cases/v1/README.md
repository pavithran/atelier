# Reviewer cases, version 1

Judged builds from the 2026-10-15 model bake-off: some clean (grade A) and
some with one defect each that the judge confirmed and reproduced. Each folder
holds what a reviewer is given and nothing the judge said:

- `brief.md`: the blind review brief. It carries the review-brief version named
  in `manifest.json` (`briefVersion`).
- `diff.txt`: the build's change, to apply on top of the commit in `base`.
- `base`: a commit of this repository the diff applies to.

`truth.json` names each case's grade and confirmed defects (the scorer's format,
described in `bin/orchestrate/review-bake-score.mjs`), `sample.txt` lists the
cases, and `manifest.json` names the case set and its brief version. The case-set
hash a score records is computed over every file in this folder, so editing any
of them makes a score that does not compare with an earlier one.

A new version is a new folder (`v2`), never an edit of `v1`.
Run it with `bin/orchestrate/review-bake.sh run --cases bin/orchestrate/review-cases/v1 ...`.
