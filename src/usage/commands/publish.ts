import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "publish",
  forms: [
    {
      group: "Setup", line: 1, slot: 50,
      form: "publish [REMOTE]",
      about: "Without REMOTE, pushes the registered branch to the baseline with a write token. It is refused for a baseline that holds only part of the history; `sync` does that job. With REMOTE, a public mirror declared in the registered commitIdentity policy (publicMirrors remote names, publicMirrorDestinations pinned URLs, the project’s GitHub no-reply email, privateEmails, privatePaths globs and privatePatterns regular expressions; set with init --public-mirror, --public-mirror-destination, --private-email, --private-path and --private-pattern), it fetches the mirror's branch and pushes the registered branch to the declared destination alone: never forced, never tags, notes or other refs. Before any push it checks every commit the mirror lacks (all history for an empty mirror, merged ancestry included), reading each commit's own patch and file list rather than the net difference, so content added and later removed is checked too: author and committer email must equal the declared address case-insensitively, and no added line, no line of the commit object (author and committer names, every header, the whole message) and no path name a commit adds, renames or deletes may match the push scan's secret rules, a private address (RFC 1918, carrier-grade NAT, link-local, unique-local and link-local IPv6 including compressed endings such as fe80::, private hostname suffixes) a declared private email (case-insensitive) or a policy pattern, and no path a private glob. Replace refs and grafts (refs/replace, info/grafts) are ignored throughout, as the push ignores them, and diff.ignoreSubmodules or submodule.*.ignore cannot hide a submodule. Once any public mirror is declared, wrap --push runs the same check for every remote it pushes, declared or not. A Git LFS pointer a commit adds or changes publishes the object it names, so that object is read from the checkout's LFS storage and scanned as a file of its own, or the commit is refused when the object is missing, not what the pointer says, binary or oversized. It names commit, path and line, never the matched text (a path whose name matches is given by its place in the commit's file list), and refuses a diverged or ahead mirror, a remote re-pointed from its declared destination, unreadable, binary, oversized or submodule content, and a missing or invalid policy, all before the push.",
    },
  ],
  flags: {},
  help: {
    example: "atelier publish github --project demo",
  },
};

export default spec;
