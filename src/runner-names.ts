// Machine names for Today's Running rows (t578). A runner's id reads
// "home:<host>-<name>" (home:studio-atelier-build); the host part is the
// machine, and this one table gives each known host its display name. A host
// not in the table shows the runner id unchanged, so a new machine reads as
// itself until it is added here.
export const MACHINE_NAMES: Record<string, string> = {
  studio: "Mac Studio",
  mini: "Mac mini",
  macbook: "MacBook Pro",
};

// The host part of a runner id: "studio" in "home:studio-atelier-build"; null when the id has no such part.
export function hostOf(runner: string): string | null {
  return /^home:([a-z0-9]+)-/i.exec(runner)?.[1]?.toLowerCase() ?? null;
}

// The runner's own name after the host: "atelier-build"; null when the host is not known to split on.
export function runnerNameOf(runner: string): string | null {
  const host = hostOf(runner);
  return host && MACHINE_NAMES[host] ? runner.replace(/^home:[a-z0-9]+-/i, "") : null;
}

export function machineName(runner: string): string {
  const host = hostOf(runner);
  return host && Object.hasOwn(MACHINE_NAMES, host) ? MACHINE_NAMES[host] : runner;
}
