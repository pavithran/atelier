# Repairs and review escapes

File a repair with `atelier new "Fix the missing row" --fix-of t7`.
The target must exist in the same project and be merged. Unknown and
unmerged targets are refused before a task is created. Use the normal brief,
criteria and scope flags to describe the repair.

`atelier file-fix t7 --from-note 1` also records the link when filing a
follow-up from a review finding. Repeating that command returns the task
already filed from that note. A rejection records findings as notes; it
does not automatically file tasks.

`atelier show t7` lists the task it fixes and every task that fixes it.
The JSON output carries these as `repairs.fixes` and `repairs.fixedBy`.
`atelier events --kind item.fix_of` exports each link: `item` is the repair
task and `data.itemId` is the repaired task.

`atelier escapes --since 2026-11-01` lists merged tasks with later repairs,
grouped by the reviewers whose approvals stood at the merged head. Each
reviewer gets a task count and the repair IDs. Multiple repairs of one task
count once per reviewer. Superseded or withdrawn approvals and approvals of
other heads do not count. The date filters when repair links were recorded,
so approvals and merges before that date still count. Omit `--since` for all
history. Add `--project NAME` to select another project.

This is a count of recorded repair links, not a defect rate: unlinked repairs
are absent, and a link does not establish why a reviewer missed a defect.
The query uses the developer-only events export and its existing secret
redaction. It adds no endpoint or disclosure level.
