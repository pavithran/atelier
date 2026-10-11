// The identity a project's commits carry (t451). The policy names the name
// and address the project commits under, the addresses its agents may
// commit under beside it, and any addresses the owner declares private,
// which no commit may carry. A claim writes the project's name and address
// into the workspace's own Git config (cli/atelier.mjs claimWorkspace), a
// runner refuses to start a builder whose effective author or committer
// falls outside the policy (cli/runner.mjs), and a landing refuses a commit
// it would put on the baseline that does (cli/atelier.mjs merge). The
// baseline's history from before a landing is not read: only the commits
// that landing adds.
//
// Publishing to a public mirror asks more (publicRefusals): the owner
// declares which remotes are public mirrors (publicMirrors), a project that
// declares one must commit under a GitHub no-reply address, and every commit
// such a remote lacks must carry that one address. An address allowed for
// landing, an agent's above all, is not thereby public.
import { RuleError } from "./rules.ts";

export interface CommitIdentityPolicy {
  name: string;
  email: string;
  // Addresses agents may author or commit under beside the project's own.
  agentEmails: string[];
  // Addresses the owner declares private: refused as an author or committer
  // everywhere, and refused as the project's or an agent's address.
  privateEmails?: string[];
  // The names of the checkout's remotes that are public mirrors: atelier
  // wrap --push publishes to one only commits under the project's address.
  publicMirrors?: string[];
}

// What an init sends; a field absent keeps the recorded value.
export interface CommitIdentityInit {
  commitName?: string;
  commitEmail?: string;
  agentEmails?: string[];
  privateEmails?: string[];
  publicMirrors?: string[];
}

const NAME_MAX = 200, EMAIL_MAX = 254, LIST_MAX = 50;
// One address, as Git writes it between angle brackets: no space, no
// brackets, one @, a dotted domain.
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@.]+$/;
// The domains Git makes up when it guesses an address from the user and the
// host name (user@host.local, user@host.(none)), and the ones a machine
// answers to on its own network only. None reaches anyone.
const GUESSED_DOMAIN = /(^|\.)(local|localdomain|lan|home|internal|localhost|\(none\))$/i;
// GitHub's no-reply addresses, the one kind of address a public mirror takes.
const PUBLIC_EMAIL = /^(\d+\+)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\[bot\])?@users\.noreply\.github\.com$/i;

export const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Why an address cannot stand for anyone, or null when it can.
export function emailProblem(email: string | null | undefined): string | null {
  if (!email) return "is not set";
  if (email.length > EMAIL_MAX || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) return "is not an email address";
  // A bare host name (user@macbook) is a guess as surely as user@host.local.
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (GUESSED_DOMAIN.test(domain) || !domain.includes(".")) return "is one Git guesses from the machine's user and host names";
  if (!EMAIL.test(email)) return "is not an email address";
  return null;
}

export function isPublicEmail(email: string): boolean {
  return PUBLIC_EMAIL.test(email);
}

function nameArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new RuleError("bad_identity", "commitName must be the name the project's commits carry, such as \"Project Owner\"", 400);
  const name = value.trim();
  // Git cuts angle brackets and line breaks out of a name; one that holds
  // them would not be the name the commits carry.
  if (name.length > NAME_MAX || /[<>\x00-\x1f\x7f]/.test(name)) throw new RuleError("bad_identity", `commitName must be at most ${NAME_MAX} characters with no angle brackets or control characters`, 400);
  return name;
}

function emailArg(value: unknown, field: string): string {
  const email = typeof value === "string" ? value.trim() : "";
  const problem = emailProblem(email);
  if (problem) throw new RuleError("bad_identity", `${field} ${JSON.stringify(email)} ${problem}; give the address the commits carry, such as 123+owner@users.noreply.github.com`, 400);
  return email;
}

// A Git remote's name, as git remote add takes one; never an option or a URL.
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function remotesArg(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) throw new RuleError("bad_identity", "publicMirrors must be a list of remote names, or [] to clear it", 400);
  const out: string[] = [];
  for (const entry of raw.map((r) => r.trim()).filter(Boolean)) {
    if (!REMOTE.test(entry) || entry.endsWith(".lock")) throw new RuleError("bad_identity", `publicMirrors ${JSON.stringify(entry)} is not a remote name, such as github`, 400);
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > LIST_MAX) throw new RuleError("too_long", `publicMirrors lists at most ${LIST_MAX} remotes`, 400);
  return out;
}

function emailsArg(value: unknown, field: string): string[] {
  const raw = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(raw)) throw new RuleError("bad_identity", `${field} must be a list of email addresses, or [] to clear it`, 400);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") throw new RuleError("bad_identity", `${field} must be a list of email addresses`, 400);
    if (!entry.trim()) continue;
    const email = emailArg(entry, field);
    if (!out.some((e) => sameEmail(e, email))) out.push(email);
  }
  if (out.length > LIST_MAX) throw new RuleError("too_long", `${field} lists at most ${LIST_MAX} addresses`, 400);
  return out;
}

// The policy an init leaves: what it names over what is recorded, checked
// whole. A name or address alone is refused when the other is not recorded,
// and so is an agent's or the project's address the owner declared private.
// Nothing named and nothing recorded leaves no identity (a project from
// before t451; docs/setup.md says how to set one).
export function settleCommitIdentity(init: CommitIdentityInit, current: CommitIdentityPolicy | undefined): CommitIdentityPolicy | undefined {
  const named = init.commitName !== undefined || init.commitEmail !== undefined || init.agentEmails !== undefined || init.privateEmails !== undefined || init.publicMirrors !== undefined;
  if (!named) return current;
  const name = init.commitName ?? current?.name;
  const email = init.commitEmail ?? current?.email;
  if (name === undefined || email === undefined) {
    throw new RuleError("bad_identity", `the project's commit identity needs both a name and an address: give ${name === undefined ? "commitName (atelier init --commit-name NAME)" : "commitEmail (atelier init --commit-email EMAIL)"} too`, 400);
  }
  const policy: CommitIdentityPolicy = {
    name: nameArg(name),
    email: emailArg(email, "commitEmail"),
    agentEmails: init.agentEmails !== undefined ? emailsArg(init.agentEmails, "agentEmails") : [...(current?.agentEmails ?? [])],
  };
  const privateEmails = init.privateEmails !== undefined ? emailsArg(init.privateEmails, "privateEmails") : current?.privateEmails ?? [];
  if (privateEmails.length) policy.privateEmails = [...privateEmails];
  const declared = (e: string) => privateEmails.some((p) => sameEmail(p, e));
  if (declared(policy.email)) throw new RuleError("bad_identity", `commitEmail ${policy.email} is declared private in privateEmails; the project cannot commit under it`, 400);
  const hidden = policy.agentEmails.filter(declared);
  if (hidden.length) throw new RuleError("bad_identity", `agentEmails ${hidden.join(", ")} ${hidden.length === 1 ? "is" : "are"} declared private in privateEmails; agents cannot commit under ${hidden.length === 1 ? "it" : "them"}`, 400);
  const publicMirrors = init.publicMirrors !== undefined ? remotesArg(init.publicMirrors) : current?.publicMirrors ?? [];
  if (publicMirrors.length) {
    // A public mirror publishes the project's address, so it must be a
    // no-reply one, as t433 asks of what a public mirror carries.
    if (!isPublicEmail(policy.email)) throw new RuleError("bad_identity", `commitEmail ${policy.email} is not a GitHub no-reply address (such as 123+owner@users.noreply.github.com), and publicMirrors ${publicMirrors.join(", ")} would publish it; set commitEmail to one, or clear publicMirrors`, 400);
    policy.publicMirrors = [...publicMirrors];
  }
  return policy;
}

// Every address a landed commit may carry as its author or committer.
export function allowedEmails(policy: CommitIdentityPolicy): string[] {
  return [policy.email, ...policy.agentEmails];
}

// Why `email` may not stand as a commit's author or committer under the
// policy, or null when it may.
export function addressRefusal(policy: CommitIdentityPolicy, email: string | null | undefined): string | null {
  const problem = emailProblem(email);
  if (problem) return problem;
  if (policy.privateEmails?.some((p) => sameEmail(p, email!))) return "is declared private in the project's policy (privateEmails)";
  if (!allowedEmails(policy).some((a) => sameEmail(a, email!))) return `is neither the project's commit address (${policy.email}) nor an agent address the policy allows (agentEmails)`;
  return null;
}

export const NO_IDENTITY = (project: string) =>
  `${project} has no commit identity in its policy; the owner sets one with atelier init --commit-name NAME --commit-email EMAIL [--agent-email EMAIL ...] (docs/setup.md, "Commit identity")`;

// One side of an identity Git resolves (git var GIT_AUTHOR_IDENT): the name
// and address, null for one Git would not give without guessing, and the
// setting each comes from, as a person would fix it.
export interface ResolvedIdent { unusable?: string;
  name: string | null;
  email: string | null;
  nameFrom: string;
  emailFrom: string;
}

// Why a builder may not start under the identity Git resolves for it, one
// line per field, each naming the setting to fix. Empty when it may.
export function builderRefusals(policy: CommitIdentityPolicy | undefined | null, resolved: { author: ResolvedIdent; committer: ResolvedIdent }, project: string): string[] {
  if (!policy) return [NO_IDENTITY(project)];
  const out: string[] = [];
  for (const role of ["author", "committer"] as const) {
    const id = resolved[role];
    if (id.unusable && id.name && id.email) { out.push(`Git cannot use the ${role} identity (${id.unusable}); fix ${id.nameFrom} and ${id.emailFrom}`); continue; }
    if (!id.name) out.push(`the ${role} name is not set, so Git would guess one; set ${id.nameFrom}`);
    const why = addressRefusal(policy, id.email);
    if (why) out.push(`the ${role} email ${id.email ? `${id.email} ` : ""}${why}; ${id.email ? "fix" : "set"} ${id.emailFrom}${id.email ? "" : ` to ${policy.email}`}`);
  }
  return out;
}

// One commit as IDENTITY_LOG_FORMAT prints it.
export interface CommitIdent {
  commit: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

// git log --format for parseIdentityLog: the hash, the author's and the
// committer's names and addresses, separated by NUL, each commit ended by
// RS, so no name or address can pass for another field. %aE and %cE are
// left unmapped by .mailmap: the addresses the commits carry.
export const IDENTITY_LOG_FORMAT = "%H%x00%an%x00%ae%x00%cn%x00%ce%x1e";

export function parseIdentityLog(text: string): CommitIdent[] {
  return text.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [commit, authorName, authorEmail, committerName, committerEmail] = record.split("\x00");
    return { commit, authorName: authorName ?? "", authorEmail: authorEmail ?? "", committerName: committerName ?? "", committerEmail: committerEmail ?? "" };
  });
}

const fields = (c: CommitIdent) => [
  ["author name", c.authorName, "author email", c.authorEmail],
  ["committer name", c.committerName, "committer email", c.committerEmail],
] as const;

// Why a landing may not put these commits on the baseline: one line per
// offending field, naming the commit and the field. Empty when it may.
export function commitRefusals(policy: CommitIdentityPolicy, commits: CommitIdent[]): string[] {
  const out: string[] = [];
  for (const c of commits) {
    for (const [nameField, name, emailField, email] of fields(c)) {
      if (!name.trim()) out.push(`commit ${c.commit.slice(0, 12)}: the ${nameField} is empty`);
      const why = addressRefusal(policy, email);
      if (why) out.push(`commit ${c.commit.slice(0, 12)}: the ${emailField} ${email || "(empty)"} ${why}`);
    }
  }
  return out;
}

// Whether the policy declares `remote` a public mirror (publicMirrors).
export function isPublicMirror(policy: CommitIdentityPolicy | undefined | null, remote: string): boolean {
  return !!policy?.publicMirrors?.includes(remote);
}

// Why these commits may not go to a public mirror: every author and
// committer address must be the project's own, and that a GitHub no-reply
// address. The landing's allowance does not reach here: an agent address
// the policy allows is refused like any other, and so is the project's own
// when it is not a no-reply one.
export function publicRefusals(policy: CommitIdentityPolicy, commits: CommitIdent[]): string[] {
  const out: string[] = [];
  const publicOwn = isPublicEmail(policy.email);
  for (const c of commits) {
    for (const [, , emailField, email] of fields(c)) {
      if (!sameEmail(email, policy.email)) out.push(`commit ${c.commit.slice(0, 12)}: the ${emailField} ${email || "(empty)"} is not the project's public address ${policy.email} (commitEmail), the only one a public mirror (publicMirrors) takes`);
      else if (!publicOwn) out.push(`commit ${c.commit.slice(0, 12)}: the ${emailField} ${email} is not a GitHub no-reply address (such as 123+owner@users.noreply.github.com); set commitEmail to one before publishing to a public mirror`);
    }
  }
  return out;
}
