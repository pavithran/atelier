# Mechanical checks at done

`atelier done` uses the project's required checks and affected-test declaration,
as `atelier check` does. A failed selected test prevents submission. The output
names the failing check and the command to run in the workspace after fixing it.
An unmapped change still falls back to the full suite; an empty selection runs
no tests.

When the project declares `regenerate`, done also runs that command after check
preparation in its clean clone. Changed tracked files or new unignored files
mean the generated fixtures or snapshots are stale. Done refuses submission,
names the files and tells the builder to run the declared generator, inspect and
commit its outputs, then run done again. A failed or interrupted generator also
prevents submission. No passing fixture result is written before the generator
finishes and its outputs have been compared. The workspace is not regenerated.

A project with neither declaration gets no additional command. Existing required
fixture or snapshot checks still run normally and report their own failures.

The callers of the check handler are the direct `check` command and `finish`;
`done` calls `finish` with its progress state set. Only done adds regeneration.
Direct check, finish, landing and shipping retain their existing command
selection. The usage declarations and their generated help, guide and usage
fixtures retain their existing contract: done pushes, checks and submits, and
failed checks return exit code 2 without submission. No API or generated page
contract changes.

These checks use the existing local check runtime and its limits. This change
adds no dependency on a remote platform limit or deploy-time behavior.
