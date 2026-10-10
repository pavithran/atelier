import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "init",
  forms: [
    {
      group: "Setup", line: 1, slot: 30,
      form: "init [--title TEXT] [--check CMD]... [--declare-read-only TEXT] [--protect GLOB]... [--core GLOB]... [--sandbox-only] [--refuse-overlap] [--require-criteria] [--no-override] [--approval TEXT] [--regenerate CMD] [--review-bar TEXT] [--review-tier H/M,H/M] [--reset] [--history-since YYYY-MM-DD]",
      about: "Run by the project owner in the project checkout: creates the baseline repository in Artifacts, pushes the current branch to it, and records that branch as the project's branch, the required checks, the protected paths and an optional title. Run again, it changes only what it names. `--sandbox-only` counts only checks run in a Cloudflare container, and `--refuse-overlap` refuses a claim whose scope overlaps another live item's. `--require-criteria` refuses a task filed or cleared without acceptance criteria. `--no-override` refuses every override of the independent review in the project, confirmed or not: a change lands only with an approval from a model of another family than every contributor; `--no-override=false` allows overrides again. `--core` records the project's core files: the queue holds a dispatch whose scope overlaps, within a core file, the scope of a live item (claimed, submitted or accepted, outside the dispatch's own plan) until that item merges or is abandoned; unset, nothing is held. `--regenerate` records the command that regenerates the project's generated fixtures, which `atelier land` runs in a task's workspace after it merges main. `--review-bar` records what may block a review, which every review brief states; unset, the brief states the default bar, which blocks for a correctness, security or data-loss defect, a behaviour change without a test that covers it, docs or help that now contradict the code, a breaking change to a command, route or API field without a migration, or a visible regression on a user-facing page, and treats anything else as a follow-up. `--review-tier` names the top review tier, which reviews every protected change: the gate's cross-family review goes to a tier model first and then serves both, and only a gate reviewer outside the tier gets a separate tier review beside it; unset, none does. Every check must be read-only: a command that deploys, installs, publishes, pushes or spends money is refused, a known build or test command is read-only by its words, and `--declare-read-only` records the owner's reason for the others. `--reset` rebuilds the policy from the defaults; `--history-since` gives a project too large for Artifacts a baseline with its recent history only.",
    },
    {
      group: "Projects", line: 1, slot: 50,
      form: "init --name NAME --rename-local",
      about: "Changes only this machine's local name for the registered checkout. Nothing on the server changes.",
    },
  ],
  flags: {
    title: 'give the title as --title TEXT, or --title "" to clear it',
    name: false,
    "rename-local": true,
    check: '--check needs text: atelier init --check "TEXT", once per entry',
    protect: '--protect needs text: atelier init --protect "TEXT", once per entry',
    core: '--core needs a glob: atelier init --core "GLOB", once per entry, or --core "" alone to clear them',
    approval: false,
    reset: true,
    "refuse-overlap": true,
    "require-criteria": true,
    "sandbox-only": true,
    "no-override": true,
    "history-since": false,
    "declare-read-only": '--declare-read-only needs a reason: atelier init --declare-read-only "why the checks change nothing outside the clone"',
    regenerate: '--regenerate needs a command: atelier init --regenerate "CMD", or --regenerate "" to clear it',
    "review-bar": '--review-bar needs text: atelier init --review-bar "what may block a review", or --review-bar "" to restore the default',
    "review-tier": '--review-tier needs models: atelier init --review-tier H/M,H/M,..., or --review-tier "" to clear it',
  },
  help: {
    flags: {
      "--title TEXT": "the project's title on its pages; --title \"\" clears it",
      "--check CMD": "a required check, run in a clean clone of the head; once per check",
      "--protect GLOB": "a protected path pattern, whose change needs an independent review; once per pattern",
      "--declare-read-only TEXT": "the owner's reason that a check not known to be read-only changes nothing outside the clone; every check must be read-only",
      "--sandbox-only": "counts only checks run in a Cloudflare container",
      "--refuse-overlap": "refuses a claim whose scope overlaps another live task's",
      "--require-criteria": "refuses a task filed or cleared without acceptance criteria, since a review judges its change against them; --require-criteria=false turns it off",
      "--no-override": "refuses every override of the independent review in the project; --no-override=false allows them again, with the owner's confirmation",
      "--core GLOB": "a core file pattern: the queue holds a dispatch whose scope overlaps a live item's within one until that item merges or is abandoned; once per pattern, replacing the recorded ones; --core \"\" alone clears them",
      "--approval TEXT": "records the project owner's approval of the copy in Artifacts; a ControlPlane project needs it",
      "--reset": "rebuilds the policy from the defaults and the options given",
      "--history-since YYYY-MM-DD": "builds the baseline from the commits since that day only, for a project too large for Artifacts",
      "--regenerate CMD": "the command that regenerates the project's generated fixtures, run by atelier land in a task's workspace after it merges main; --regenerate \"\" clears it",
      "--review-bar TEXT": 'what may block a review, stated in every review brief (at most 1000 characters); --review-bar "" restores the default: a correctness, security or data-loss defect, a behaviour change without a test that covers it, docs or help that now contradict the code, a breaking change to a command, route or API field without a migration, or a visible regression on a user-facing page; anything else is a follow-up',
      "--review-tier H/M,H/M": "the top review tier: a protected change's gate review goes first to one of these of another family than every contributor, and serves as the tier review too; when the gate's reviewer is outside the tier, one of these that did not build the change reviews it beside, whatever its family: its rejection sends the change back, its approval never satisfies the gate, and a landing never waits for it; --review-tier \"\" clears it",
      "--name NAME": "the project's name; the checkout folder's name unless given",
      "--rename-local": "with --name, changes only this machine's name for the registered checkout",
    },
    example: 'atelier init --title "Demo" --check "npm test" --protect "src/rules.ts"',
  },
};

export default spec;
