# What criteria review asks

A criteria review judges the acceptance criteria before the task is built. The
brief it reads (`src/review/criteria.ts`) carries these rules.

## Failure behaviour

For a task that writes state, sends anything, retries, or spans more than one
process or call, the criteria must say what happens on:

- a crash part-way,
- a retry,
- a repeated or concurrent call,
- a timeout,

or say why one does not apply. A set that leaves one of them undecided and
unexplained is rejected with a blocking finding that names which behaviour is
open. A task with none of these traits (a docs change, a pure function) is not
asked for any of this.

Example, the notification. "Exactly one notification is sent" cannot hold across
a crash between sending and recording: if the process dies after the send, a
retry sends it twice; if it records first, a crash loses it. The criteria must
choose (at least once with a recorded send key, or at most once with a
reconciliation step) and say which. Leaving this open cost a round in each of
t519, t521, t524 and t526.

## Sharp criteria

The reviewer also blocks for:

- an absolute (exactly, never, always) whose strictest reading is impossible or
  unstated;
- a number or field with no named source that records it ("computed from the
  ledger" when the runner never recorded the parts);
- a behaviour with no named production entry point (which command of "a passed
  deploy step").
