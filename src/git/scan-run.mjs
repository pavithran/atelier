// The hook's rules 5 and 6 (src/git/scan.mjs, checkPush) run outside the
// hook, over history the server writes itself: a project's repository moved
// to the Studio (Atelier 2.0, task 11, src/git/move.mjs). The scan reads the
// repository its working directory is, as in the hook, so the server runs
// this in a process of its own with the bare repository as its directory.
// Argument: JSON { old, sha, ref, branch, policyPath, reportPath }. Prints
// JSON { refusal } (null when the history may go in).
await import("../runtime/loader.mjs");
const { checkPush } = await import("./scan.mjs");
const args = JSON.parse(process.argv[2]);
const refusal = await checkPush({ ...args, task: "" });
process.stdout.write(`${JSON.stringify({ refusal })}\n`);
