// Read grants for a project's repository on the server (POST
// projects/P/git-token, kind read; docs/branches.md). A read grant reads
// every branch: { remote, token, expiresAt, defaultBranch }, the project's
// branch. With a task named, the answer also names the task's branch
// (`branch`, null before its first claim makes it), the branch it merges
// into (`into`: its plan's for a part, the project's otherwise), and its
// recorded head and base. `request(method, path, body, as)` is the caller's.
const path = (name) => `/projects/${encodeURIComponent(name)}/git-token`;

export const readGrant = (request, name, id = null, as) => request("POST", path(name), { kind: "read", ...(id ? { item: id } : {}) }, as);

// The task's own branch to clone, with its head and base; refused, naming
// the claim, before its first claim makes the branch.
export async function taskReadGrant(request, name, id, as) {
  const g = await readGrant(request, name, id, as);
  if (!g.branch) throw new Error(`no_workspace: ${id} has no workspace yet; run atelier claim ${id} --as HARNESS/MODEL to make its workspace`);
  return g;
}

// The branch the task merges into, as the baseline its clone fetches
// (`defaultBranch`).
export async function baseReadGrant(request, name, id, as) {
  const g = await readGrant(request, name, id, as);
  return { ...g, defaultBranch: g.into };
}
