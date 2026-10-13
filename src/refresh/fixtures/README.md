# Mechanical conflict fixtures (t462)

Each `NAME.conflicted.txt` is a file as a refresh's merge leaves it, with
git's diff3 markers (`merge.conflictStyle=diff3`): the task's side, the merge
base and main's side. `index.json` names the kind each is classified as
(src/refresh/mechanical.ts) and, for a mechanical one, the transformation
that resolves it; `NAME.resolved.txt` is that resolution, which a resolver
must write exactly (for `import-union`, the same lines with the base lines
in their order and the added imports anywhere among them).

| Fixture | Kind | Why |
| --- | --- | --- |
| same-change | mechanical | both sides made the same change |
| one-sided | mechanical | the task left the lines as they were; main's side is taken |
| whitespace | mechanical | the task changed only trailing whitespace and a blank line |
| import-union | mechanical | both sides only added imports |
| behavioural | behavioural | both sides changed one line differently |
| import-clash | behavioural | both sides import `parse`, from different modules |
| no-base | uncertain | the conflict style shows no merge base |
| unclosed | uncertain | a conflict that never closes |

src/refresh/mechanical.test.mjs reads every fixture listed here.
