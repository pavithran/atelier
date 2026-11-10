// Shared instruction text for CLI and server briefs. Keep this module free of imports.

// The rules every build brief carries, whatever runs the agent (t376). They
// lived only in the local wrappers (atelier-claude, atelier-codex,
// atelier-opencode, atelier-agy), so a runner with a generic wrapper gave its
// agents none of them. The text names no actor or job, so one fixture,
// test/fixtures/briefs/build-rules.txt, pins it for every build brief; the
// commit message each job wants is stated beside it.
export const BUILD_EVIDENCE = [
  "- For a behaviour change, write a failing test first; report the commands and red and green output.",
  "- For changes touching routes, endpoints or data with visibility levels, list each endpoint's trust checks: who may call, membership, edit right and where the disclosure level comes from. Derive that level from trusted caller identity, never from a caller's requested level; test each refusal.",
  "- For changes touching routes, endpoints or data with visibility levels, test a table of visibility level by output path. List responses, search snippets, derived fields, exports, UI copy and generated pages, and what each level may see.",
  "- When a contract changes or tightens, list every caller and generated page that uses it; report each one's update or compatibility check.",
  "- For UI changes, attach before and after screenshots, console output and network failures for every affected page. For pages with visibility levels, include evidence at each level, not only as the owner.",
  "- In a fix report, name the findings addressed, covering tests, commands and output before re-review.",
  "- Write each status, version or completion marker only after the work it marks; test that a crash before completion leaves it unset.",
].join("\n");

export const BUILD_RULES = [
  "- Use no path outside this workspace: read and write files only inside it.",
  "- Put scratch files only under .scratch/ in this workspace.",
  "- Run no rm and no mktemp, and make no temporary folders.",
  // t302: a local model lost finished work four times to a heredoc and an &&
  // chain its harness refused.
  "- Commit first when the work is done, before anything else, with plain single git commands, one per call: git add FILES, then git commit. No heredoc, no -F -, no && chain and no redirection: a harness refuses them, and the run ends without a commit.",
  "- A run that ends without a commit counts as stalled, whatever it did.",
  // t619: builders of t604, t612 and t101 started busy loops on the shared build machine.
  "- Start no process that loads the machine or outlives your command; simulate load inside the test only.",
  "- If a test outside the task's scope fails on main, do not change it; report the failing test and its output in the summary and stop.",
  "- A fix comes with a test that fails without it.",
  BUILD_EVIDENCE,
  // t534: 18 of 65 blocking findings in t512-t528's rejections were logic no
  // production code called.
  "- Test through the production caller: a function only tests call fails the static check (npm run test:static), so wire each new function into the code that runs it.",
  "- A change that depends on a platform limit or runtime behaviour local tests cannot reproduce names it in the task, and the project declares a remote smoke check run before and after deploy.",
].join("\n");

// The rules every review brief carries, whatever runs the reviewer (t376).
// They lived only in the local wrappers (atelier-claude, atelier-codex,
// atelier-opencode, atelier-agy), so a runner with a generic wrapper gave its
// reviewers none of them. test/fixtures/briefs/review-rules.txt pins the text.
export const REVIEW_RULES = [
  "- Only correctness, security, data loss and actively misleading docs block. Other findings are follow-ups.",
  "- Treat the builder's claims as unverified; check them against the diff and cite file and line. A stated reason does not reduce a defect's severity.",
  "- Check the behaviour test's commands and red and green output in the builder's report; name missing evidence.",
  "- For changes touching routes, endpoints or data with visibility levels, list each endpoint's trust checks from the code: who may call, membership, edit right and where the disclosure level comes from. Check that caller identity, not a requested level, determines disclosure, and that each refusal is tested.",
  "- For changes touching routes, endpoints or data with visibility levels, independently enumerate output paths and compare the builder's table of visibility level by output path with the code and tests. Include responses, search snippets, derived fields, exports, UI copy and generated pages.",
  "- When a contract changes or tightens, search for every caller and generated page that uses it; verify the builder's list and compatibility claims, citing file and line.",
  "- For UI changes, check before and after screenshots, console output and network failures for every affected page and visibility level; name missing evidence.",
  "- For each status, version or completion marker, check that it is written after the work it marks and that a crash before completion leaves it unset.",
  "- Verify each blocking finding before you report it, by reading the code it names or by running a test, and say in the finding how you verified it: the lines you read, or the test you ran and what it printed.",
  "- Inability to run a command in the reviewer’s environment is never blocking. Report sandbox permissions, missing dependencies and unavailable services as verification limits, not code defects; use Atelier’s Observed results at the head under review. A demonstrated defect in the project remains blocking. If environment limits prevent a verdict, explain the limitation without a VERDICT line so the run is recorded as failed, rather than rejecting the change.",
  "- Give at most 12 findings, the most serious first.",
  "- Edit nothing: change, create and delete no file, and do not commit or push.",
].join("\n");

// Applies only when the supplied diff starts at an earlier reviewed head.
export const RE_REVIEW_RULE = "- On re-review, mark each earlier finding addressed or still open; inspect only the fix diff for new breakage and the same defect class. Check the fix report's covering tests, commands and output. If no fix report is supplied, check the earlier findings against the current code and available test evidence; name missing evidence. Defer unrelated observations.";
