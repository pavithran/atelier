import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "merge",
  forms: [
    {
      group: "Owner", line: 1, slot: 20,
      form: "merge ID [--head SHA [--approve [--note TEXT]] [--override-review REASON]] [--policy-changed-ok]",
      about: "The project owner lands the accepted head in the registered checkout and publishes the merge to the baseline. With `--head`, a submitted task is accepted at that exact revision first: `--approve` records the owner's review, with `--note` as its reason, which is not the independent review, and `--override-review` accepts with the owner's override, as `accept` does, under the same confirmation from the task's page. Run again, it resumes an interrupted merge; `--cancel` ends one. A plan whose branch would conflict with main is not accepted, and one accepted that conflicts at the merge is put back to building through `plan refresh`, which takes main into its branch.",
    },
    {
      group: "Owner", line: 1, slot: 30,
      form: "merge ID --cancel [--discard-local]",
      about: "Ends an interrupted merge: the landing lease is released, so the task's owner can push again. An unpublished merge commit in the checkout is kept unless `--discard-local` removes it and returns the branch to where the merge began.",
    },
  ],
  flags: {
    cancel: true,
    "discard-local": true,
    head: false,
    approve: true,
    note: false,
    "policy-changed-ok": true,
    "override-review": '--override-review needs a reason: atelier merge ID --head FULL_REVISION --override-review "why no independent review is possible"',
  },
  help: {
    flags: {
      "--head SHA": "the full revision to accept first, when the task is submitted and not yet accepted",
      "--approve": "with --head, records the owner's review of that revision, which is not the independent review",
      "--note TEXT": "with --approve, the review's note",
      "--override-review REASON": "with --head, accepts with the owner's override of a missing independent review, once allowed on the task's page with the Access sign-in or the confirmation secret",
      "--policy-changed-ok": "lands a change that touches paths the ControlPlane policy began to protect after acceptance, once that change of policy is reviewed",
      "--cancel": "ends an interrupted merge, so the task's owner can push again",
      "--discard-local": "with --cancel, removes the unpublished merge commit from the checkout",
    },
    example: "atelier merge t3 --project demo",
  },
};

export default spec;
