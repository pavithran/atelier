// What the Worker reads of a merge of main into an approved head, for
// retentionVerdict in src/rules.ts (t56). It reads and decides nothing: it
// answers the commit's parents and four path lists, each from two trees, and
// the declared outputs the merge's own provenance says it regenerated. A
// failure to read any of it answers `unread`, and the head is reviewed again.
//
//   task      paths the approved head changed since the base
//   incoming  paths main changed between the base and its commit
//   moved     paths the merge changed from the approved head
//   offMain   paths the new head holds differently from main's commit
//
// The base is the newest commit on main's history that the approved head
// holds (mergeBase in src/diff.ts); the lists are tree differences, so a
// rename or a deletion is listed at both of its ends and no history the
// agent shaped can shrink them.
import { changedPaths, mergeBase, pairReader, type Reader } from "./diff.ts";
import { MANIFEST_PATH, parseManifest } from "./merge-declarations.ts";
import type { RetentionFacts, RetentionRead } from "./rules.ts";

type Repo = Pick<ArtifactsRepo, "log" | "readTree" | "readBlob">;

const HISTORY = 1000;
const PATHS_MAX = 5000;

// The bytes at a path of a tree, or null where it is not a file there.
async function fileAt(r: Reader, tree: string, path: string): Promise<Uint8Array | null> {
  let hash = tree;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const entry = (await r.tree(hash))?.find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry.type === "blob" || entry.type === "exec" ? r.blob(entry.hash) : null;
    if (entry.type !== "tree") return null;
    hash = entry.hash;
  }
  return null;
}

// The declared outputs of the generators the merge commit's message says it
// ran: its `Atelier-Regenerated: NAME (COMMAND): PATH matches …` lines (the
// merge pipeline writes them, cli/merge-pipeline.mjs), kept only for a
// generator main's manifest declares under that name and command, and only
// for a path that generator declares. A manifest main does not hold, or one
// that does not parse, exempts nothing.
export async function regeneratedOutputs(r: Reader, mainTree: string, message: string): Promise<string[]> {
  const lines = message.split("\n").filter((l) => l.startsWith("Atelier-Regenerated: "));
  if (!lines.length) return [];
  const bytes = await fileAt(r, mainTree, MANIFEST_PATH);
  if (!bytes) return [];
  let generators;
  try { generators = parseManifest(new TextDecoder().decode(bytes)).generators; } catch { return []; }
  const out = new Set<string>();
  for (const line of lines) {
    for (const g of generators) {
      if (!line.startsWith(`Atelier-Regenerated: ${g.name} (${g.command.join(" ")}): `)) continue;
      for (const path of g.outputs) if (line.includes(`: ${path} matches `) || line.includes(`; ${path} matches `)) out.add(path);
    }
  }
  return [...out].sort();
}

export async function readRetention(fork: Repo, baseline: Repo, oldHead: string, newHead: string): Promise<RetentionRead> {
  const unread = (why: string): RetentionRead => ({ unread: why });
  try {
    const [head] = await fork.log({ ref: newHead, limit: 1 });
    if (!head || head.hash !== newHead || !head.treeHash) return unread("the new head's commit could not be read");
    const parents = head.parents ?? [];
    const facts: RetentionFacts = { oldHead, newHead, parents, main: null, base: null, task: [], incoming: [], moved: [], offMain: [], outputs: [] };
    if (parents.length !== 2 || parents[0] !== oldHead) return facts;
    const main = parents[1];
    // Main's commit must be in the baseline's own history, not only a commit
    // the fork holds: a fork's second parent is the agent's to choose.
    const [mainLog, top, workspace] = await Promise.all([
      baseline.log({ ref: main, limit: HISTORY }), baseline.log({ limit: HISTORY }), fork.log({ ref: oldHead, limit: HISTORY }),
    ]);
    const merged = mainLog[0];
    if (!merged || merged.hash !== main || !merged.treeHash) return unread("main's commit is not in the baseline");
    if (!top.some((c) => c.hash === main)) return unread("main's commit is not in the baseline's recent history");
    const approved = workspace[0];
    if (!approved || approved.hash !== oldHead || !approved.treeHash) return unread("the approved head's commit could not be read");
    const base = mergeBase(workspace, mainLog.map((c) => c.hash));
    const baseCommit = base ? mainLog.find((c) => c.hash === base) : undefined;
    if (!base || !baseCommit?.treeHash) return unread("no commit of main's history is held by the approved head within the history read");
    const reader = pairReader(fork as ArtifactsRepo, baseline as ArtifactsRepo);
    const diff = (a: string, b: string) => changedPaths(reader, a, b, PATHS_MAX);
    const [task, incoming, moved, offMain] = await Promise.all([
      diff(baseCommit.treeHash, approved.treeHash), diff(baseCommit.treeHash, merged.treeHash),
      diff(approved.treeHash, head.treeHash), diff(merged.treeHash, head.treeHash),
    ]);
    const outputs = await regeneratedOutputs(reader, merged.treeHash, head.message ?? "");
    return { ...facts, main, base, task, incoming, moved, offMain, outputs };
  } catch (error) {
    return unread(error instanceof Error ? error.message.slice(0, 200) : "the repositories could not be read");
  }
}
