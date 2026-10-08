// Git for the check container, with no image built and no Internet (t303).
//
// The container starts from the Cloudflare-managed cloudflare/debian-trixie
// image (node:24-trixie-slim pinned by digest), which has no git: on
// 2026-10-08 every test that made a repository died with
// `spawnSync git ENOENT`. A custom image would need Docker wherever
// `wrangler deploy` runs, or Workers Builds; this supplies git without either.
//
// The Worker, not the container, fetches Debian trixie's own git package,
// pinned here by version, size and sha256 (the values Debian's archive
// publishes), refuses any bytes that do not match, and streams the package
// into the container the way it streams the checked tree. The container
// unpacks it with dpkg-deb, which every Debian image has, and gains no host
// to reach and no credential: its egress stays the npm registry alone.
//
// The package's own dependencies that the core `git` binary loads, libc6,
// libpcre2-8-0 and zlib1g, are in every Debian trixie image (grep and dpkg,
// both essential, depend on them). The rest it lists serve parts a check
// cannot use offline: libcurl3t64-gnutls and libexpat1 the http(s) remote
// helpers, perl and liberror-perl the Perl scripts (git svn, send-email),
// git-man the manual pages.

export interface PinnedDeb {
  name: string;
  version: string;
  bytes: number;
  sha256: string;
  urls: string[];   // tried in order; every one must yield exactly these bytes
}

// https://packages.debian.org/trixie/amd64/git/download gives the size and
// sha256; Cloudflare containers run linux/amd64. When the pool drops this
// version, snapshot.debian.org keeps it forever under its sha1
// (https://snapshot.debian.org/mr/binary/git/1:2.47.3-0+deb13u1/binfiles).
// To move to a newer git, change all four values together.
export const GIT_DEB: PinnedDeb = {
  name: "git",
  version: "1:2.47.3-0+deb13u1",
  bytes: 8861572,
  sha256: "3e35662fd5c46add561703e54031a1d8ad9df45811927689f0a51122b13be722",
  urls: [
    "https://deb.debian.org/debian/pool/main/g/git/git_2.47.3-0%2Bdeb13u1_amd64.deb",
    "https://snapshot.debian.org/file/bb5947667cef07307ce77aeb86fd95c2a3e85472",
  ],
};

// Where the package lands inside the container before it is unpacked into /.
export const TOOLS_DIR = "tmp/atelier-tools";

// A fetched package is kept in R2 under its sha256, when the LARGE bucket
// exists, so a run after the first does not reach Debian at all.
export function toolKey(deb: PinnedDeb): string {
  return `tools/${deb.name}/${deb.sha256}.deb`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// What a package's bytes must be: its size and its sha256, exactly.
async function verified(deb: PinnedDeb, bytes: Uint8Array): Promise<string | null> {
  if (bytes.length !== deb.bytes) return `${bytes.length} bytes, not ${deb.bytes}`;
  const sha = await sha256Hex(bytes);
  return sha === deb.sha256 ? null : `sha256 ${sha.slice(0, 12)}…, not ${deb.sha256.slice(0, 12)}…`;
}

export interface FetchDeps {
  fetch: (url: string) => Promise<Response>;
  bucket?: R2Bucket | null;
}

// The package's bytes, verified, from R2 or else from the first URL that
// yields them; every refusal is named in the error when none does. A copy in
// R2 that does not verify is ignored and replaced.
export async function fetchPinned(deb: PinnedDeb, deps: FetchDeps): Promise<Uint8Array> {
  const why: string[] = [];
  const key = toolKey(deb);
  const held = await deps.bucket?.get(key).catch(() => null);
  if (held) {
    const bytes = new Uint8Array(await held.arrayBuffer());
    const bad = await verified(deb, bytes);
    if (!bad) return bytes;
    why.push(`R2 ${key}: ${bad}`);
  }
  for (const url of deb.urls) {
    try {
      const res = await deps.fetch(url);
      if (!res.ok) { why.push(`${url}: HTTP ${res.status}`); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const bad = await verified(deb, bytes);
      if (bad) { why.push(`${url}: ${bad}`); continue; }
      await deps.bucket?.put(key, bytes, { customMetadata: { sha256: deb.sha256, version: deb.version } }).catch(() => {});
      return bytes;
    } catch (err) {
      why.push(`${url}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  throw new Error(`no verified copy of ${deb.name} ${deb.version}: ${why.join("; ")}`);
}

// The commands that install a package already streamed to `${TOOLS_DIR}/NAME.deb`
// and prove it runs: dpkg-deb unpacks the files alone (no maintainer
// scripts, no dependency resolution, nothing fetched), then the tool prints
// its version.
export function installCommands(deb: PinnedDeb): string[][] {
  return [
    ["dpkg-deb", "-x", `/${TOOLS_DIR}/${deb.name}.deb`, "/"],
    ["rm", "-f", `/${TOOLS_DIR}/${deb.name}.deb`],
    [deb.name, "--version"],
  ];
}
