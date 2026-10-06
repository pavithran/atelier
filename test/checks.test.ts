import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adapterClasses, checkClassOf, classText, classifyCommand, knownReadOnly, parseDeclarations, refusalOf, settleCheckClasses, simpleCommands,
  type CheckDeclaration,
} from "../src/checks.ts";
import { parseRuleError } from "../src/rules.ts";

// A check runs in a clean clone whenever anyone asks, so it must be
// read-only. These tests pin the refusal list, the known build and test
// forms, the classes recorded on a project and what a ControlPlane adapter
// says, against the commands projects register.

const refusedWith = (fn: () => unknown) => {
  try { fn(); } catch (err) { return parseRuleError(err); }
  assert.fail("expected a refusal");
};

test("a command line reads as the simple commands it runs, past quotes, substitutions and redirections", () => {
  assert.deepEqual(simpleCommands("npm ci --no-fund && npm test"), [["npm", "ci", "--no-fund"], ["npm", "test"]]);
  assert.deepEqual(simpleCommands("a | b; c || d & e"), [["a"], ["b"], ["c"], ["d"], ["e"]]);
  assert.deepEqual(simpleCommands("xcodebuild -destination 'generic/platform=iOS Simulator' build"), [["xcodebuild", "-destination", "generic/platform=iOS Simulator", "build"]]);
  assert.deepEqual(simpleCommands(`echo "a \\"b\\" $HOME" 'c d'`), [["echo", 'a "b" $HOME', "c d"]]);
  // A substitution is one more command, in or out of double quotes, and in backticks.
  assert.deepEqual(simpleCommands("H=$(mktemp -d)"), [["mktemp", "-d"], ["H=$(mktemp -d)"]]);
  assert.deepEqual(simpleCommands('echo "$(git rev-parse HEAD)" `date`'), [["git", "rev-parse", "HEAD"], ["date"], ["echo", "$(git rev-parse HEAD)", "`date`"]]);
  assert.deepEqual(simpleCommands("diff <(sort a) b"), [["sort", "a"], ["diff", "<(sort a)", "b"]]);
  // Redirections and their targets are dropped, a file descriptor with them.
  assert.deepEqual(simpleCommands("npm test 2>&1 >out.log </dev/null &>all"), [["npm", "test"]]);
  assert.deepEqual(simpleCommands("(cd a && make test) # build it\nnpm test"), [["cd", "a"], ["make", "test"], ["npm", "test"]]);
  assert.deepEqual(simpleCommands("echo $((1 + 2)) ${HOME:-/tmp}"), [["echo", "$((1 + 2))", "${HOME:-/tmp}"]]);
  // What cannot be read this way is null, not a guess.
  for (const line of ["echo 'unclosed", 'echo "unclosed', "echo $(unclosed", "cat <<EOF\nx\nEOF", "echo ${X:-$(date)}"]) assert.equal(simpleCommands(line), null, line);
});

test("a command that deploys, installs, publishes, pushes, reaches another machine or spends money is refused, wherever in the line it runs", () => {
  const refused: [string, RegExp][] = [
    ["npx wrangler deploy", /deploys \(wrangler deploy\)/],
    ["wrangler publish", /deploys/],
    ["node_modules/.bin/wrangler deploy --keep-vars", /deploys/],
    ["npx wrangler versions deploy", /deploys/],
    ["wrangler pages deploy dist", /deploys/],
    ["wrangler secret put KEY", /secrets/],
    ["wrangler d1 migrations apply DB --remote", /Cloudflare resources/],
    ["npm publish", /publishes a package/],
    ["pnpm publish --no-git-checks", /publishes a package/],
    ["npm run deploy", /deploys or publishes/],
    ["npm --prefix web run deploy", /deploys or publishes/],
    ["npm run db:migrate:remote", /remote database/],
    ["npm install -g wrangler", /installs onto this machine/],
    ["git push origin main", /pushes/],
    ["git -C repo push", /pushes/],
    ["git lfs push origin", /pushes/],
    ["xcrun altool --upload-app -f App.ipa", /Apple/],
    ["xcrun notarytool submit App.zip --wait", /Apple/],
    ["fastlane beta", /fastlane/],
    ["bundle exec fastlane test", /fastlane/],
    ["xcrun devicectl device install app --device iPhone.18 App.app", /installs on a device/],
    ["ios-deploy --bundle App.app", /installs on a device/],
    ["xcodebuild -allowProvisioningUpdates archive", /provisioning/],
    ["ssh host make test", /another machine/],
    ["scp a host:b", /another machine/],
    ["rsync -a dist/ host:/srv/www", /another machine/],
    ["curl -X POST https://api.example/x", /write request/],
    ["curl --request=DELETE https://api.example/x", /write request/],
    ["curl -fsSL -d @body.json https://api.example/x", /write request/],
    ["curl --json '{}' https://api.example/x", /write request/],
    ["wget --post-data=a=b https://api.example/x", /write request/],
    ["gh release create v1", /writes to GitHub/],
    ["gh api -X PATCH repos/a/b", /write request to GitHub/],
    ["docker push example/app", /pushes an image/],
    ["brew install jq", /installs onto this machine/],
    ["launchctl load ~/Library/LaunchAgents/x.plist", /service/],
    ["claude -p 'review this'", /paid model/],
    ["codex exec fix", /paid model/],
    ["atelier merge t3", /Atelier itself/],
    ["make install", /make target install/],
    ["python3 -m twine upload dist/*", /publishes a package/],
    ["cargo publish", /publishes a crate/],
    ["terraform apply -auto-approve", /infrastructure/],
    // Hidden behind a wrapper, a script, a trap or a substitution.
    ["sh -c 'npm ci && npx wrangler deploy'", /deploys/],
    ["/bin/bash -lc \"launchctl load x.plist\"", /service/],
    ["trap 'git push' EXIT; npm test", /pushes/],
    ["echo $(npm publish)", /publishes/],
    ["eval 'git push'", /pushes/],
    ["env CI=1 timeout 60 npx wrangler deploy", /deploys/],
    ["sudo npm publish", /publishes/],
    ["git ls-files | xargs -0 git push", /pushes/],
    ["npm test; if true; then git push; fi", /pushes/],
  ];
  for (const [command, why] of refused) {
    const r = refusalOf(command);
    assert.ok(r, `${command} was not refused`);
    assert.match(r, why, command);
    assert.equal(knownReadOnly(command), false, command);
  }
  // A dry run deploys and publishes nothing, and a quoted word is not a command.
  for (const command of ["npx wrangler deploy --dry-run --outdir dist", "npm publish --dry-run", "cargo publish --dry-run", "echo 'npx wrangler deploy'", "grep -r 'git push' docs", "curl -s https://example.test/health", "rsync -a dist/ build/", "gh pr view 3", "make test", "npm run release:check", "claude --version"]) {
    assert.equal(refusalOf(command), null, command);
  }
});

// The checks the projects on atelier.zone registered before checks had
// classes, as their init commands were given. Each that is plainly a build
// or test is read-only by its words; the three that run a project script or
// remove a folder are undeclared, still run, and wait for the owner.
const REGISTERED = [
  "npm ci --prefer-offline --no-audit --no-fund && npm test",
  "npm run types && npm run typecheck",
  "npm ci --prefer-offline --no-audit --no-fund && npm run types && npm run check && npm test",
  "npm ci --prefer-offline --no-audit --no-fund && npm run check && npm test",
  "npm ci --prefer-offline --no-audit --no-fund && npm run build",
  "python3 -B -m unittest discover -s tests",
  "python3 -m unittest discover -s tests",
  "python3 -m py_compile build.py serve.py",
  "git ls-files -z '*.py' | xargs -0 python3 -B -m py_compile",
  "node --check bin/observatory.js && node --test",
  "swift test",
  "swift test --package-path SandscapeCore",
  "swift test --package-path Packages/AtlasIndex",
  "xcodebuild build -quiet -project Photograph.xcodeproj -scheme Photograph -destination 'generic/platform=iOS Simulator' -derivedDataPath .atelier-build",
  "xcodegen generate && xcodebuild build -quiet -project Soundbar.xcodeproj -scheme Soundbar -derivedDataPath .atelier-build CODE_SIGNING_ALLOWED=NO",
  "xcodebuild build-for-testing -quiet -project Assets.xcodeproj -scheme Assets -destination 'generic/platform=iOS Simulator' -derivedDataPath .atelier-build CODE_SIGNING_ALLOWED=NO",
  "xcodebuild test -quiet -project MacBench.xcodeproj -scheme MacBench -destination 'platform=macOS' -derivedDataPath .atelier-build CODE_SIGNING_ALLOWED=NO",
  "cd ios && xcodegen generate && xcodebuild build -quiet -project MicahApp.xcodeproj -scheme MicahApp -destination 'generic/platform=iOS Simulator' -derivedDataPath ../.atelier-build CODE_SIGNING_ALLOWED=NO",
  "cd relay && npm ci --prefer-offline --no-audit --no-fund && npm run typecheck && npm test",
  "(cd backend && uv sync --frozen && uv run pytest) && (cd frontend && npm ci --prefer-offline --no-audit --no-fund && npm test && npm run build)",
];
const UNDECLARED = [
  "npm ci --prefix frontend --prefer-offline --no-audit --no-fund && npm ci --prefix family --prefer-offline --no-audit --no-fund && ./check.sh",
  `export PATH="/opt/homebrew/bin:$PATH" npm_config_cache="$HOME/.npm"; H=$(mktemp -d /tmp/ourai-check.XXXXXX); trap 'rm -rf "$H"' EXIT; export HOME="$H"; cd relay && npm run typecheck && npm test && git diff --exit-code -- package-lock.json`,
  `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && (cd frontend && npm ci --no-audit --no-fund) && (cd roon-sidecar && npm ci --no-audit --no-fund) && (cd backend && uv sync --frozen --extra dev) && bin/check`,
];

test("a registered check that is plainly a build or test is read-only by its words; the rest are undeclared and still run", () => {
  for (const command of REGISTERED) {
    assert.equal(knownReadOnly(command), true, command);
    assert.deepEqual(checkClassOf({}, command), { command, class: "read-only", by: "command" });
  }
  for (const command of UNDECLARED) {
    assert.equal(refusalOf(command), null, command);
    assert.equal(checkClassOf({}, command).class, "undeclared", command);
  }
  // A project script, an inline program and a tool named by a project path are not known.
  for (const command of ["./check.sh", "bin/check", "node scripts/verify.mjs", "python -c 'print(1)'", "./scripts/tsc", "make", "sudo npm test", "curl -s https://example.test"]) {
    assert.equal(knownReadOnly(command), false, command);
  }
  // A tool where tools live, and a wrapper around a known form, is known.
  for (const command of ["node_modules/.bin/vitest run", ".venv/bin/pytest -q", "npx -y @biomejs/biome@1.9 check .", "env CI=1 npm test", "timeout 600 swift test", "uv run -m pytest", "./gradlew test", "FOO=1 npm test 2>&1 | tee out.log", "[[ -f x ]] && npm test", "exit 0", "true"]) {
    assert.equal(knownReadOnly(command), true, command);
  }
});

test("a check's class: a refusal beats anything recorded, then the record, then its words", () => {
  const recorded: CheckDeclaration[] = [
    { command: "./check.sh", by: "owner", note: "PAVI: builds and runs the tests" },
    { command: "npx wrangler deploy", by: "owner", note: "a mistake" },
  ];
  assert.equal(checkClassOf({ checkClasses: recorded }, "npx wrangler deploy").class, "refused");
  assert.deepEqual(checkClassOf({ checkClasses: recorded }, "./check.sh"), { command: "./check.sh", class: "read-only", by: "owner", note: "PAVI: builds and runs the tests" });
  assert.equal(classText(checkClassOf({ checkClasses: recorded }, "./check.sh")), "read-only, declared by the project owner: PAVI: builds and runs the tests");
  assert.equal(classText(checkClassOf({}, "npm test")), "read-only, a known build or test command");
  assert.match(classText(checkClassOf({}, "./check.sh")), /^undeclared: .*still run.*--declare-read-only/);
  assert.match(classText(checkClassOf({}, "npm run deploy")), /^refused, because it runs a script whose name says it deploys or publishes \(npm run deploy\); Atelier will not run it/);
  assert.equal(classText({ command: "x", class: "read-only", by: "adapter", note: "capability unit-tests is local-read-only" }), "read-only, from ControlPlane: capability unit-tests is local-read-only");
});

test("an init that names its checks must show each one read-only; one that does not keeps their classes", () => {
  // A known form is recorded as such.
  assert.deepEqual(settleCheckClasses(["npm test"], undefined, undefined, true), [{ command: "npm test", by: "command" }]);
  // A command that is never read-only is refused, whatever is declared.
  const deploy = refusedWith(() => settleCheckClasses(["npm test", "npx wrangler deploy"], [{ command: "npx wrangler deploy", by: "owner", note: "trust me" }], undefined, true));
  assert.equal(deploy?.code, "not_read_only");
  assert.equal(deploy?.status, 400);
  assert.match(deploy!.detail, /`npx wrangler deploy` is not a check: it deploys \(wrangler deploy\)/);
  // A command Atelier cannot read as read-only needs a declaration.
  const undeclared = refusedWith(() => settleCheckClasses(["./check.sh"], undefined, undefined, true));
  assert.equal(undeclared?.code, "undeclared_check");
  assert.match(undeclared!.detail, /`\.\/check\.sh` is not a command Atelier knows to be read-only.*--declare-read-only/);
  const owner = { command: "./check.sh", by: "owner" as const, note: "PAVI, 2026-10-06: runs the unit tests" };
  assert.deepEqual(settleCheckClasses(["./check.sh"], [owner], undefined, true), [owner]);
  // An init that names the same checks again keeps a declaration made before.
  assert.deepEqual(settleCheckClasses(["./check.sh", "npm test"], undefined, [owner], true), [owner, { command: "npm test", by: "command" }]);
  // Without the checks named, an undeclared check stays registered and unrecorded, and one may be declared.
  assert.deepEqual(settleCheckClasses(["./check.sh", "npm test"], undefined, undefined, false), [{ command: "npm test", by: "command" }]);
  assert.deepEqual(settleCheckClasses(["./check.sh"], [owner], undefined, false), [owner]);
  // A registered check that is refused does not stop an init that names no checks, but cannot be declared.
  assert.deepEqual(settleCheckClasses(["npx wrangler deploy", "./check.sh"], [owner], undefined, false), [owner]);
  assert.equal(refusedWith(() => settleCheckClasses(["npx wrangler deploy"], [{ command: "npx wrangler deploy", by: "owner", note: "x" }], undefined, false))?.code, "not_read_only");
  // A declaration must name a check the project has.
  assert.equal(refusedWith(() => settleCheckClasses(["npm test"], [{ ...owner, command: "./other.sh" }], undefined, true))?.code, "bad_declaration");
});

test("a declaration from a request names a command, is by the adapter or the owner, and carries a reason", () => {
  assert.deepEqual(parseDeclarations([{ command: " ./check.sh ", by: "owner", note: " runs\nthe tests " }]), [{ command: "./check.sh", by: "owner", note: "runs the tests" }]);
  for (const bad of [null, {}, [{ command: "x", by: "command", note: "n" }], [{ command: "", by: "owner", note: "n" }], [{ command: "x", by: "owner", note: "  " }], [{ command: "x", by: "owner", note: "n".repeat(501) }], [{ command: 3, by: "owner", note: "n" }]]) {
    assert.equal(refusedWith(() => parseDeclarations(bad))?.status, 400, JSON.stringify(bad));
  }
});

test("a ControlPlane adapter declares the checks it lists as read-only capabilities and refuses those it lists under any other class", () => {
  const adapter = {
    capabilities: {
      "unit-tests": { action_class: "local-read-only", command: ["npm", "test"] },
      "production-build": { action_class: "local-write", command: ["npm", "run", "build"] },
      "app-build": { action_class: "local-read-only", command: ["xcodebuild", "-destination", "generic/platform=iOS Simulator", "build"] },
      verify: { action_class: "local-read-only", command: ["bin/control-plane-check.sh"] },
      install: { action_class: "device", command: ["bin/device-delivery.sh", "install", "--target", "canonical-ipad"] },
      deploy: { action_class: "deploy", command: ["npm", "run", "deploy"] },
    },
  };
  const checks = ["npm test", "npm run build", "xcodebuild -destination 'generic/platform=iOS Simulator' build", "bin/control-plane-check.sh", "bin/device-delivery.sh install --target canonical-ipad", "./other.sh", "npm ci && npm test"];
  const { declarations, refusals } = adapterClasses(adapter, checks);
  assert.deepEqual(declarations, [
    { command: "npm test", by: "adapter", note: "capability unit-tests is local-read-only" },
    { command: "npm run build", by: "adapter", note: "capability production-build is local-write" },
    { command: "xcodebuild -destination 'generic/platform=iOS Simulator' build", by: "adapter", note: "capability app-build is local-read-only" },
    { command: "bin/control-plane-check.sh", by: "adapter", note: "capability verify is local-read-only" },
  ]);
  assert.deepEqual(refusals.map((r) => r.command), ["bin/device-delivery.sh install --target canonical-ipad"]);
  assert.match(refusals[0].text, /is ControlPlane capability install, of class device/);
  // Capabilities may be a list, and an adapter without them says nothing.
  assert.deepEqual(adapterClasses({ capabilities: [{ name: "t", action_class: "local-read-only", command: ["./t.sh"] }] }, ["./t.sh"]).declarations, [{ command: "./t.sh", by: "adapter", note: "capability t is local-read-only" }]);
  assert.deepEqual(adapterClasses(null, ["npm test"]), { declarations: [], refusals: [] });
});

test("an unreadable command is neither refused nor known", () => {
  assert.deepEqual(classifyCommand("echo 'unclosed"), { refusal: null, known: false, parsed: false });
  assert.equal(knownReadOnly("echo 'unclosed"), false);
});
