# Where each harness adapter writes a size error

The runner reads a harness's refusal of its input for its size from stderr
alone, and only after a non-zero exit or a signal that was not a time limit
(t554; `inputSizeRefusal` in `cli/runner.mjs`). This page records, from the
adapters' source, where a size error reaches the runner.

None of the four adapters writes a size error of its own. Each starts the
vendor's executable and relays what it printed. So the question per adapter is
which stream carries the vendor's message to the runner. The vendors'
executables are not in this repository, so what they print is not read here;
only the adapters' handling of each stream is.

All four entry points call `runWithLimits` (`bin/harness/limit.mjs`) and share
`runHarness` (`cli/harness/adapter.mjs`).

| Adapter | Entry point | Stderr to the runner | Stdout to the runner |
| --- | --- | --- | --- |
| claude-code | `bin/harness/atelier-claude.mjs:7` | relayed | review: dropped on failure; build: relayed |
| codex | `bin/harness/atelier-codex.mjs:7` | relayed | review: dropped on failure; build: relayed |
| antigravity | `bin/harness/atelier-agy.mjs:7` | relayed | review: dropped on failure; build: relayed |
| opencode | `bin/harness/atelier-opencode.mjs:14` | relayed | review: dropped on failure; build: relayed |

## How the streams are handled

- `bin/harness/limit.mjs:282` runs the vendor with all three streams piped.
- `bin/harness/limit.mjs:293` writes the vendor's stderr to the adapter's
  stderr, minus any line that begins with the adapter's own limit marker
  (`limit.mjs:288`). This is the only path by which a size error is read, and
  it reaches the runner as stderr.
- `bin/harness/limit.mjs:292` writes the vendor's stdout to the adapter's
  stdout only when the caller asked to inherit it (`limit.mjs:277`). Builds do
  (`cli/harness/adapter.mjs:680`, stdout is `inherit` or the progress log when
  the run is not a captured review).
- A review captures stdout (`cli/harness/adapter.mjs:667`, `capture`). On a
  non-zero exit the adapter returns the status at
  `cli/harness/adapter.mjs:693` without writing that stdout anywhere, so
  nothing the vendor printed on stdout reaches the runner from a failed
  review.
- The retry in `runLimited` reads the vendor's stderr from a file
  (`cli/harness/adapter.mjs:730-741`); it is for transport errors and does not
  classify size.
- The adapter's own failures (`fail`, `cli/harness/adapter.mjs:611`) go to
  stderr and say nothing of size.

## Stdout-only size errors

The source shows no adapter that writes a size error only to stdout; no
adapter writes one at all. One thing the source does show: `limit.mjs:221`
looks for provider errors in both streams, and for claude-code, codex,
opencode and antigravity it decodes them from JSON records the vendor
prints on stdout (`limit.mjs:176-205`, `structuredArgs` at `limit.mjs:236`
asks for that JSON). That is evidence a vendor may print a provider error on
stdout in those modes, but it concerns usage limits, and the source does not
say whether a vendor puts a size error there. If a vendor does, a failed
review loses it (`adapter.mjs:693`) and the runner would record a plain
harness failure, not a size refusal. That is the safe side of the t554 rule,
and it needs a run of the real vendor to confirm. This page does not claim it
is so.
