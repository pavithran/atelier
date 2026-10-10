// Which runner runs which test file (t466). npm test (run.mjs) used to name
// its node --test files by glob, test/**, so a test file anywhere else, as
// under cli/, was never run by the checks. Discovery here walks the tree for
// every test file by name, whatever the runners' own patterns are, and
// assigns each to exactly one runner. A file no runner owns, or that several
// own, is rejected before anything runs, so no file is silently skipped or run
// twice. The Vitest suites are *.spec.ts files, which its config
// (vitest.config.ts) selects itself; they are not discovered here.
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Every name that looks like a test file, so a misnamed one (x.test.js, say)
// is found and rejected rather than ignored.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(["node_modules"]);

export const RUNNERS = [
  { name: "node", owns: (file) => /\.test\.(mjs|ts)$/.test(file) },
  // Vitest's config includes test/**/*.spec.ts only.
  { name: "vitest", owns: (file) => /^test\/.*\.spec\.ts$/.test(file) },
];

// Every test file under root, as slash-separated paths relative to it, sorted.
// Dot-directories (.git, .cache, .wrangler) and node_modules are not walked.
export function discover(root = ".") {
  const found = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) walk(path); }
      else if (TEST_FILE.test(entry.name)) found.push(path);
    }
  };
  walk("");
  return found.sort();
}

// { byRunner: {name: [files]}, unassigned: [files], multiple: [{file, runners}] }
export function assign(files, runners = RUNNERS) {
  const byRunner = Object.fromEntries(runners.map((r) => [r.name, []]));
  const unassigned = [], multiple = [];
  for (const file of files) {
    const owners = runners.filter((r) => r.owns(file));
    if (owners.length === 0) unassigned.push(file);
    else if (owners.length > 1) multiple.push({ file, runners: owners.map((r) => r.name) });
    else byRunner[owners[0].name].push(file);
  }
  return { byRunner, unassigned, multiple };
}

// The lines that name each rejected path; empty when every file has one runner.
export function rejections({ unassigned, multiple }) {
  return [
    ...unassigned.map((file) => `${file}: no runner runs this test file`),
    ...multiple.map(({ file, runners }) => `${file}: owned by more than one runner (${runners.join(", ")})`),
  ];
}
