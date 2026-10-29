// The file a Durable Object name's SQLite database lives in, under
// DATA/ledgers (src/runtime/namespace.mjs; the backup reads the same names,
// src/backup/snapshot.mjs). The name is percent-encoded, "." and "*"
// included, and so is every uppercase letter: macOS's disk folds case, so
// project:Repo-Collision and project:repo-collision would otherwise open one
// file (found by task 7). A name with no uppercase letter keeps the file name
// it always had. decodeURIComponent gives the name back.
export function ledgerFile(name) {
  return [...name].map((c) => (/[.*A-Z]/.test(c) ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(c))).join("") + ".sqlite";
}
