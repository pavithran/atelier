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

| Adapter | Entry point | Stderr to the runner | Stdout to the runner, review | Stdout to the runner, build |
| --- | --- | --- | --- | --- |
| claude-code | `bin/harness/atelier-claude.mjs:7` | relayed | captured (`adapter.mjs:238`, `:667`); dropped on failure (`:693`) | inherited (`:680`), forwarded (`limit.mjs:292`) |
| codex | `bin/harness/atelier-codex.mjs:7` | relayed | inherited, not captured: `verdictFrom` is "file" (`adapter.mjs:251`), so `capture` is false (`:667`) and stdout is inherited (`:680`); forwarded on any exit status (`limit.mjs:292`) | inherited (`:680`), forwarded (`limit.mjs:292`) |
| antigravity | `bin/harness/atelier-agy.mjs:7` | relayed | captured (`adapter.mjs:283`, `:667`); dropped on failure (`:693`) | inherited (`:680`), forwarded (`limit.mjs:292`) |
| opencode | `bin/harness/atelier-opencode.mjs:14` | relayed | captured (`adapter.mjs:269`, `:667`); dropped on failure (`:693`) | inherited (`:680`), forwarded (`limit.mjs:292`) |

## How the streams are handled

- `bin/harness/limit.mjs:283-284` runs the vendor with all three streams
  piped.
- `bin/harness/limit.mjs:293` writes the vendor's stderr to the adapter's
  stderr, minus any line that begins with the adapter's own limit marker
  (`limit.mjs:288`). This is the only path by which a size error is read, and
  it reaches the runner as stderr.
- `bin/harness/limit.mjs:292` writes the vendor's stdout to the adapter's
  stdout whenever the caller asked to inherit it (`limit.mjs:277`), on any exit
  status, zero or not. Builds inherit it (`cli/harness/adapter.mjs:680`; the
  progress log stands in for claude-code builds the runner follows). So do
  Codex reviews, because their answer is read from a file
  (`adapter.mjs:251`, `:667`, `:680`).
- The other three adapters' reviews capture stdout (`adapter.mjs:667`). On a
  non-zero exit the adapter returns the status at `adapter.mjs:693` without
  writing that captured stdout anywhere, so nothing the vendor printed on
  stdout reaches the runner from a failed claude-code, antigravity or opencode
  review.
- So stdout may reach the runner (Codex reviews, and builds by every adapter),
  but the runner never reads it for a size refusal: its three call sites pass
  `result.stderr` only (`cli/runner.mjs:2848`, `:3172`, `:3366`).
- The retry in `runLimited` reads the vendor's stderr from a file
  (`cli/harness/adapter.mjs:726-747`); it is for transport errors and does not
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
claude-code, antigravity or opencode review loses it (`adapter.mjs:693`); a
Codex review or a build forwards it, and the runner ignores it. Either way the
runner would record a plain harness failure, not a size refusal. That is the
safe side of the t554 rule, and it needs a run of the real vendor to confirm. This page does not
claim it is so.
