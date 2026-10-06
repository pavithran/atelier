// Neutral labels for the public showcase. A project the owner shows
// anonymously is titled by what it is, read from its checks and the names of
// the files at its baseline's root, and each of its tasks is titled by its
// kind of work, read from the words of its title. Both are pure functions so
// the server can label a story before it reaches any page: nothing an
// anonymised project named itself is drawn publicly.

// What a project is, from its required checks and the entries at its
// baseline's root. `files` is null when the repository could not be read, and
// only the checks are asked then. "a project" when nothing recognisable.
export function projectKind(checks: string[], files: string[] | null): string {
  const check = (re: RegExp) => checks.some((c) => re.test(c));
  const file = (re: RegExp) => files?.some((f) => re.test(f)) ?? false;
  // An Xcode project at the root is an app; its checks say for which system,
  // and where they do not, the bundle itself is the stronger guess.
  if (file(/\.xcodeproj$|\.xcworkspace$/) || check(/\bxcodebuild\b/)) {
    return check(/platform\s*=\s*macOS|\bmacOS\b/) && !check(/\biOS\b/) ? "a Mac app" : "an iOS app";
  }
  if (file(/^package\.json$/)) {
    return file(/^(wrangler\.(json|jsonc|toml)|Dockerfile|fly\.toml|Procfile|server\.[jt]s)$/) || check(/\b(wrangler deploy|wrangler dev)\b/) ? "a web service" : "a JavaScript library";
  }
  if (file(/^(pyproject\.toml|setup\.py|setup\.cfg)$/)) {
    return check(/\b(pip install|pipx run|uv run|python -m)\b/) ? "a Python tool" : "a Python library";
  }
  if (file(/^Package\.swift$/)) return "a Swift library";
  if (file(/^Cargo\.toml$/)) return "a Rust library";
  if (file(/^go\.mod$/)) return "a Go module";
  if (file(/^Gemfile$/)) return "a Ruby library";
  if (check(/^(pytest|python -m pytest|uv run pytest)\b/)) return "a Python tool";
  return "a project";
}

// What kind of work a task was, from the words of its title. The showcase
// titles an anonymised project's task stories with only this, so the words of
// the title itself stay private.
export function workKind(title: string): string {
  const t = title.toLowerCase();
  if (/\b(fix|fixes|fixed|repair|bug|crash|regression|broken|failure|fails|wrong)\b/.test(t)) return "a fix";
  if (/\b(test|tests|spec|specs|coverage)\b/.test(t)) return "tests";
  if (/\b(doc|docs|documentation|readme|guide|changelog|comment|comments)\b/.test(t)) return "documentation";
  if (/\b(refactor|refactoring|renam(e|es|ing)|reorganis(e|es|ing)|clean(s|ed|ing)? up|tidy|simplify)\b/.test(t)) return "a refactor";
  if (/\b(add|adds|added|support|supports|create|creates|build|builds|implement|implements|introduce|allow|allows|enable|enables|make|makes|write|writes|improve|improves|new)\b/.test(t)) return "a feature";
  return "a change";
}
