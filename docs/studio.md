# The Studio

How Atelier 2.0 runs on the Studio, the Mac that hosts the server. The design is `~/Documents/ai-project-data/atelier/design-branches-2026-10-28.md`, sections 4.1 to 4.11; what was built and when is in `docs/2.0-log.md`. This document covers the nightly backups and the monthly restore rehearsal. The rest of the layout is documented in the setup scripts themselves (`scripts/studio/setup-staging.sh`, `setup-tunnel.sh`, `setup-backup.sh`, `setup-restore.sh`); production and `atelier ship` come with the rest of plan task 9.

## Layout

The service user `atelierd` owns everything the server writes:

| Path | Owner | Holds |
|---|---|---|
| `/Users/atelierd/data/ENV` | atelierd, 700 | the Ledgers (`ledgers/*.sqlite`), `alarms.sqlite`, `git-grants.sqlite`, `large/` |
| `/Users/atelierd/repos/ENV` | atelierd, 700 | one bare repository per project, `KEY.git` |
| `/Users/atelierd/secrets/ENV` | atelierd, 700 | the server's settings, one file each |
| `/Users/atelierd/secrets/backup` | atelierd, 700 | the R2 settings and the backup public key |
| `/Users/atelierd/backup-work` | atelierd, 700 | a backup while it is packed; empty otherwise |
| `/Users/atelierd/log` | atelierd, 700 | `staging.log`, `tunnel.log`, `backup-ENV.log` |
| `/Users/atelierd/bin`, `server` | root, group atelierd | node and the server's code, read-only to the daemon |

ENV is `staging` or `production`.

## Nightly backups

A LaunchDaemon, `zone.atelier.backup.ENV`, runs `node server/cli/backup.mjs` as `atelierd` at 03:00 local for production and 03:30 for staging, so the two never run together. Each run:

1. Copies every SQLite database in the data directory through SQLite's `VACUUM INTO`, which reads the database inside one transaction. The copy is the database at one moment while the server keeps writing, and the files under WAL are never copied raw. The index (`ledgers/__index.sqlite`) is copied first and the other Ledgers listed only after it; a project is registered in the index only once its own Ledger exists, so every project the copied index registers has its Ledger in the backup, and the backup fails if one does not.
2. Copies `large/`. Each large object is written beside its name and renamed over it, so a plain copy reads it whole; the files still being written (`NAME.PID.RANDOM.tmp`) are left out, and a file removed between the listing and its copy is skipped.
3. Makes a `git bundle create --all` of each repository, after the databases, so a restored Ledger never names a commit its repository lacks. The refs recorded are read back from the bundle.
4. Writes `manifest.json`: every file's path, size and SHA-256, each repository's refs and HEAD, the projects the index registers, and each project's count of items and events. It holds no secret value. The server's own secrets are not in the backup at all; a restored server is given its secrets anew.
5. Packs these into one `tar.gz` and encrypts it to the backup's age recipient (below).
6. Uploads it to R2 as `atelier/ENV/atelier-ENV-YYYYMMDDTHHMMSSZ.backup`, through R2's S3 API, each request signed with AWS Signature Version 4 by Node's crypto.
7. Deletes this environment's own backups older than 30 days. The prefix is made of plain segments, none empty, `.` or `..`, and each key is signed and sent exactly as listed, never normalised, so no deletion can reach another key. An object is deleted only when it is under the environment's prefix, carries this command's own name pattern for this environment, and is older than 30 days by both the time in its name and R2's LastModified. Nothing else in the bucket is touched.

Every backup is full. The design's weekday incrementals would make a backup depend on the Sunday before it, and the repositories are small enough that a full bundle every night costs little in R2.

Each run appends to `/Users/atelierd/log/backup-ENV.log`: what it copied, the bytes uploaded, the object's key, and what retention deleted. A failure ends with `backup of ENV failed:` and the reason. No credential or key appears in the log.

### Encryption

Each backup is an [age](https://age-encryption.org/v1) v1 file encrypted to one X25519 recipient, written by Node's own crypto (`src/backup/age.mjs`): a random 16-byte file key wrapped for the recipient with HKDF-SHA256 and ChaCha20-Poly1305, a header MAC, and the payload in 64 KiB ChaCha20-Poly1305 chunks whose last one is flagged, so a chunk changed, reordered, dropped or cut off fails to open. The keys are age's: the recipient is an `age1...` string, the identity an `AGE-SECRET-KEY-1...` line in age-keygen's key-file format. Node is already installed root-owned on the Studio, so nothing more is needed there; the standard `age` tool on the Mac opens a backup too (`age -d -i backup.key`), and `test/backup.test.mjs` checks both directions against age v1.3.2 when it is on PATH.

The identity never sits on the Studio, and decryption happens only on PAVI's Mac. Without the identity a backup in R2 cannot be read, by anyone holding the R2 token included.

Public-key encryption gives secrecy, not proof of origin: whoever holds the R2 write token could upload a backup of their own making. The restore checks the archive's layout and every sum in the manifest before writing, which catches damage but not a forgery. An R2 bucket lock rule (below) stops the token from deleting or overwriting a backup younger than 30 days.

### Setting it up

PAVI's steps, once:

1. **The bucket.** In the Cloudflare dashboard, create an R2 bucket, for example `atelier-backups`. Add a bucket lock rule on the prefix `atelier/` with a retention of 30 days, so no backup younger than that can be deleted, by the Studio's token or anyone else.
2. **The token.** Create an R2 API token with "Object Read & Write" on that bucket alone. Note its Access Key ID and Secret Access Key, and the account's S3 endpoint, `https://ACCOUNT.r2.cloudflarestorage.com`.
3. **The key pair**, on the Mac, from the checkout (`age-keygen -o backup.key` makes the same):

   ```
   node cli/backup.mjs keygen --out ~/.config/atelier/backup-key
   ```

   `backup.key` is the age identity; keep it where only PAVI can read it, and keep a second copy off both machines (a password manager's secure note). Losing it makes every backup unreadable. `backup.pub` holds the `age1...` recipient and goes to the Studio.
4. **The settings file**, a file of PAVI's own, mode 600:

   ```
   R2_ENDPOINT=https://ACCOUNT.r2.cloudflarestorage.com
   R2_BUCKET=atelier-backups
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   ```

5. **The install**, on the Studio, after `setup-staging.sh` has installed a release holding `cli/backup.mjs`:

   ```
   sudo bash scripts/studio/setup-backup.sh staging R2.env backup.pub
   ```

   It copies its inputs into root-owned storage and checks them there, and refuses an identity. Then it stops every `atelierd` job (the servers, the tunnel and the backups), waits until no `atelierd` process runs, checks the directories again, installs the settings and recipient as `atelierd`'s and the LaunchDaemon from `scripts/studio/zone.atelier.backup.plist.template`, starts again the jobs that ran, and runs one backup at once, waiting up to 300 seconds for it to report its upload. Staging is down for those seconds. On any failure it puts back, under the same rules, the settings and the LaunchDaemon it found, and starts the jobs that ran. It prints no secret. Afterwards remove `R2.env` and the copy of `backup.pub` given to it; the script deletes nothing in a path PAVI's user controls. Run it again with `production` when production moves.

`DRYRUN=1` before `bash` prints what the script would change and needs no root.

## The monthly restore rehearsal

Once a month, on the first Monday, restore last night's staging backup and check it. A backup that has never been restored is not known to be a backup.

On PAVI's Mac, where the identity is, from the checkout, with a secrets directory holding the same four R2 settings (mode 700, files mode 600; a read-only R2 token is enough here):

```
node cli/restore.mjs list --env staging --secrets ~/.config/atelier/r2-read
node cli/restore.mjs --env staging --secrets ~/.config/atelier/r2-read --key ~/.config/atelier/backup-key/backup.key --data /tmp/rehearsal/data --repos /tmp/rehearsal/repos --check
```

The restore:

1. Fetches the newest staging backup, or the one `--object KEY` names. `--file F` restores a downloaded file instead.
2. Decrypts it with the age identity.
3. Checks the archive holds only files and directories within a backup's layout, then checks every file's size and SHA-256 against the manifest, and that the manifest names every file.
4. Restores into `--data` and `--repos`, which must be absent or empty; it never writes over anything. It says which two directories it is about to create before its first write: removing them undoes the restore. Every database passes SQLite's integrity check, and every repository's refs and HEAD equal the manifest's.
5. With `--check`, starts a server on the restored directories, on 127.0.0.1 and a free port, with a one-off owner token and none of the shell's secrets or notification settings. It checks that `/api/version` answers and that every project the restored index registers has its Ledger and the items and events the manifest counted, to the same last event.

Record each rehearsal in `docs/2.0-log.md`: the date, the backup's key, the counts the check printed. Then remove the rehearsal directories.

### Restoring for real

If the Studio's data is lost or untrusted, the restore is made on PAVI's Mac, as in the rehearsal, and moved to the Studio through a root script with the setup scripts' safeguards. The identity never goes to the Studio.

1. On the Mac, restore into a fresh directory and check it:

   ```
   node cli/restore.mjs --env production --secrets ~/.config/atelier/r2-read --key ~/.config/atelier/backup-key/backup.key --data ~/restore/data --repos ~/restore/repos --check
   tar -cf ~/restore.tar -C ~/restore data repos
   ```

2. Copy `restore.tar` and the checkout's `scripts/studio/` to the Studio over the tailnet, and there:

   ```
   sudo bash scripts/studio/setup-restore.sh production restore.tar
   ```

   It copies the tar into root-owned storage and checks it there: plain files and directories under `data/` and `repos/` only, every database through SQLite's integrity check, every project the index registers with its Ledger, every repository bare. Then it stops every `atelierd` job, waits until no `atelierd` process runs, and checks the four paths again (data and repos absent or plain directories, never links; both destinations absent, not even a dangling link). It records the undo before the next step: it prints how to undo, and moves the current `data/ENV` and `repos/ENV` aside to `ENV.before-restore-STAMP`, never deleting them. It installs the restored directories as `atelierd`'s and starts again the jobs that ran. Each move aside is recorded as it happens, so on a failure it undoes exactly the moves made, removing any partial copy first and moving nothing over a link or an existing path. If the undo is incomplete, every `atelierd` job stays stopped, and it prints, for data and repos, what the run placed and moved and what stands at each of the four paths now, then the steps that remove what the run placed and move each original back, and only after them the commands that start the jobs; when an original is not where it was moved, it prints no start command at all. Moving the two aside directories back undoes the restore.

Work recorded after the backup was made (at most a day) is lost from the Ledger; commits pushed since are still in the developers' workspaces and are pushed again.

## What is tested

`test/backup.test.mjs` runs a real server and, while `cli/backup.mjs` backs it up in a separate process to a local S3-compatible stub, keeps writing to it: items, new projects, pushes carrying commits on main, a notes ref and a new `t/N` branch each, and large objects. Then it restores with `cli/restore.mjs --check`. The stub verifies every request's SigV4 signature with a verifier of its own, which is itself checked against curl's `--aws-sigv4`. The test shows:

- the restored server answers with the same project record, every item and event the same as the source's up to the backup's moment, as many as the manifest counted, every project registered while the backup ran, the bundle's refs (each the source's or an ancestor of it, notes and new branches included), and the large objects whole;
- the object in the stub is an age file, not an archive, holds none of the data in the clear, and opens with its identity alone: another identity, a changed byte, a changed header MAC or a cut fails;
- retention deleted only this environment's backup older than 30 days, and kept recent ones, an old-named one R2 says is recent, other prefixes, other names and the other environment's; a prefix with an empty, `.` or `..` segment is refused, and a listed key with odd characters is deleted exactly, its normalised neighbours left;
- a backup refuses an index that registers a project with no Ledger, and so does a restore; a large object being written is not in a backup;
- no secret value (the R2 credentials, the identity, the owner token, the override secret) appears in either command's output, the manifest or the archive;
- with `age` on PATH, a key from `age-keygen` works with this code's encryption, `age -r` output opens with this code, and `cli/backup.mjs keygen`'s keys work with `age`; without it the test is skipped and says so.

`test/setup-restore.test.mjs` sources `setup-restore.sh`'s functions without root and shows that a failed second move aside is undone (data moved back, repos untouched), that a partial placement is removed and both directories moved back, that a link at either directory or anything at either destination, a dangling link included, is refused, and that recovery moves nothing over a link.

`setup-backup.sh` and `setup-restore.sh` have been run only with `DRYRUN=1`; neither has run on the Studio.
