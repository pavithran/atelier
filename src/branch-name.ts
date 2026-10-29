// The branch names the server takes (Atelier 2.0): ASCII letters, digits,
// ".", "_", "/" and "-", starting with a letter or digit, at most 200
// characters, with no "..", no trailing "/" and no ".lock" ending. One rule
// for the repositories the server makes (checkBranch in src/git/branches.mjs)
// and for the branch init records (branchArg in src/index.ts), so init never
// takes a name the repository then refuses.
export function validBranch(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)
    && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock");
}
