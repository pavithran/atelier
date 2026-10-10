# Task page owner controls: remote smoke (t457)

The orchestrator runs this after deploying a change to the task page's owner
controls, signed in as the owner in Safari on macOS, on a disposable task in
a smoke project: a submitted protected change with no independent review.
Record the Safari version, the deployed revision (`DEPLOYED_MAIN`), the task,
and the result of every step. The local tests (test/owner-state.spec.ts,
test/owner-forms.spec.ts, test/layout.test.ts) assert the markup, the
stylesheet rules and the handlers. They cannot show how a browser draws
the disclosure or moves focus.

1. Open the task. Beside the actions, the state panel labels Your approval,
   Independent review, Command-line permission and Acceptance apart, with one
   Next, Waiting or Done line.
2. Press Approve revision. After the redirect, and again after a reload,
   "Approved by you" shows beside the actions with the short head and a time
   with its zone, and Approve revision is not offered again. Independent
   review still reads required.
3. "Accept without an independent review" reads as a disclosure, not a
   button: a chevron and "show the override and command-line permission".
   Click it: it opens, the chevron turns, the hint reads "hide", and nothing
   is submitted (the task's history gains no event). Click again to close it.
4. With the keyboard alone (Tab to the summary, then Enter, then Space), the
   disclosure opens and closes the same way. With VoiceOver, the summary is
   announced as a collapsed or expanded disclosure. Tab inside it reaches the
   reason field, then the two buttons.
5. Type a reason of spaces only and press Override the review and accept.
   The page comes back with the disclosure open, the refusal beside the
   button, a Reload link, the reason kept, the secret field (if any) empty,
   and the task still submitted.
6. Allow an override from the command line. The permission reads Active with
   the revision and a zoned expiry. Then override from the page with a real
   reason. The permission reads "Invalidated by your override on this page",
   not Expired. The history's review overridden entry says whether a
   qualifying reviewer was available.
