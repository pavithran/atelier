import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localGit, mergeThrough } from "../../cli/merge-pipeline.mjs";
import { MANIFEST_PATH } from "../merge-declarations.ts";

// Replay from the approved parents. Commit messages supplied by a builder
// are not evidence that a generator ran or that it wrote these bytes.
export async function verifyRegeneration(source, oldHead, main, newHead) {
  const scratch = mkdtempSync(join(tmpdir(), "atelier-retention-"));
  const clone = join(scratch, "clone");
  const git = (args, opts = {}) => localGit([
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "user.name=Atelier verification", "-c", "user.email=verification@atelier.invalid",
    ...args,
  ], opts);
  try {
    git(["clone", "--quiet", "--no-checkout", "--shared", source, clone]);
    // Only the baseline's declaration may authorize commands. A task that
    // changes it needs review of the resulting revision.
    const declaration = (rev) => git(["ls-tree", rev, "--", MANIFEST_PATH], { cwd: clone });
    if (!declaration(main) || declaration(oldHead) !== declaration(main) || declaration(newHead) !== declaration(main)) return [];
    git(["checkout", "--quiet", "--detach", oldHead], { cwd: clone });
    const result = await mergeThrough(clone, main, { git, commit: false });
    if (result.state !== "merged" || git(["write-tree"], { cwd: clone }) !== git(["rev-parse", `${newHead}^{tree}`], { cwd: clone })) return [];
    return result.regenerated.flatMap((g) => g.outputs.map((o) => o.path)).sort();
  } catch {
    return [];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
