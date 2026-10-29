# The Studio

How Atelier 2.0 runs on the Studio, the Mac that hosts the server. The design is `~/Documents/ai-project-data/atelier/design-branches-2026-10-28.md`, sections 4.1 to 4.11; what was built and when is in `docs/2.0-log.md`. This document covers the nightly backups and the monthly restore rehearsal. The rest of the layout is documented in the setup scripts themselves (`scripts/studio/setup-staging.sh`, `setup-tunnel.sh`, `setup-backup.sh`); production and `atelier ship` come with the rest of plan task 9.

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

1. Copies every SQLite database in the data directory through SQLite's `VACUUM INTO`, which reads the database inside one transaction. The copy is the database at one moment while the server keeps writing, and the files under WAL are never copied raw.
2. Copies `large/`. Each large object is written beside its name and renamed over it, so a plain copy reads it whole.
3. Makes a `git bundle create --all` of each repository, after the databases, so a restored Ledger never names a commit its repository lacks. The refs recorded are read back from the bundle.
4. Writes `manifest.json`: every file's path, size and SHA-256, each repository's refs and HEAD, and each project's count of items and events. It holds no secret value. The server's own secrets are not in the backup at all; a restored server is given its secrets anew.
5. Packs these into one `tar.gz` and encrypts it to the backup public key (below).
6. Uploads it to R2 as `atelier/ENV/atelier-ENV-YYYYMMDDTHHMMSSZ.backup`, through R2's S3 API, each request signed with AWS Signature Version 4 by Node's crypto.
7. Deletes this environment's own backups older than 30 days. An object is deleted only when it is under the environment's prefix, carries this command's own name pattern for this environment, and is older than 30 days by both the time in its name and R2's LastModified. Nothing else in the bucket is touched.

Every backup is full. The design's weekday incrementals would make a backup depend on the Sunday before it, and the repositories are small enough that a full bundle every night costs little in R2.

Each run appends to `/Users/atelierd/log/backup-ENV.log`: what it copied, the bytes uploaded, the object's key, and what retention deleted. A failure ends with `backup of ENV failed:` and the reason. No credential or key appears in the log.

### Encryption

The archive is encrypted with Node's own crypto, the construction `age` uses: a fresh X25519 key pair per backup, its shared secret with the recipient's public key turned into an AES-256 key by HKDF-SHA256, and the archive sealed with AES-256-GCM in 64 KiB chunks whose nonces carry the chunk's number and a last-chunk flag, so a chunk changed, reordered, dropped or cut off fails to open. It was chosen over `age` because the Studio would need another binary installed root-owned and checked; Node is already installed that way. It was chosen over `openssl` because the system's LibreSSL has no X25519, and `openssl enc` offers no authenticated mode.

The private key never sits on the Studio. PAVI keeps it. Without it a backup in R2 cannot be read, by anyone holding the R2 token included.

Public-key encryption gives secrecy, not proof of origin: whoever holds the R2 write token could upload a backup of their own making. The restore checks the archive's layout and every sum in the manifest before writing, which catches damage but not a forgery. An R2 bucket lock rule (below) stops the token from deleting or overwriting a backup younger than 30 days.

### Setting it up

PAVI's steps, once:

1. **The bucket.** In the Cloudflare dashboard, create an R2 bucket, for example `atelier-backups`. Add a bucket lock rule on the prefix `atelier/` with a retention of 30 days, so no backup younger than that can be deleted, by the Studio's token or anyone else.
2. **The token.** Create an R2 API token with "Object Read & Write" on that bucket alone. Note its Access Key ID and Secret Access Key, and the account's S3 endpoint, `https://ACCOUNT.r2.cloudflarestorage.com`.
3. **The key pair**, on the Mac, from the checkout:

   ```
   node cli/backup.mjs keygen --out ~/.config/atelier/backup-key
   ```

   `backup.key` is the private key; keep it where only PAVI can read it, and keep a second copy off both machines (a password manager's secure note). Losing it makes every backup unreadable. `backup.pub` goes to the Studio.
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

   It copies its inputs into root-owned storage and checks them there, refuses a private key, installs the settings and public key as `atelierd`'s, installs the LaunchDaemon from `scripts/studio/zone.atelier.backup.plist.template`, and runs one backup at once, waiting up to 300 seconds for it to report its upload. On any failure it puts back the settings and the LaunchDaemon it found. It prints no secret. Afterwards remove `R2.env` and the copy of `backup.pub` given to it; the script deletes nothing in a path PAVI's user controls. Run it again with `production` when production moves.

`DRYRUN=1` before `bash` prints what the script would change and needs no root.

## The monthly restore rehearsal

Once a month, on the first Monday, restore last night's staging backup and check it. A backup that has never been restored is not known to be a backup.

On the Mac, from the checkout, with a secrets directory holding the same four R2 settings (mode 700, files mode 600; a read-only R2 token is enough here):

```
node cli/restore.mjs list --env staging --secrets ~/.config/atelier/r2-read
node cli/restore.mjs --env staging --secrets ~/.config/atelier/r2-read --key ~/.config/atelier/backup-key/backup.key --data /tmp/rehearsal/data --repos /tmp/rehearsal/repos --check
```

The restore:

1. Fetches the newest staging backup, or the one `--object KEY` names. `--file F` restores a downloaded file instead.
2. Decrypts it with the private key (`--passphrase-file F` for a key kept encrypted).
3. Checks the archive holds only files and directories within a backup's layout, then checks every file's size and SHA-256 against the manifest, and that the manifest names every file.
4. Restores into `--data` and `--repos`, which must be absent or empty; it never writes over anything. It says which two directories it is about to create before its first write: removing them undoes the restore. Every database passes SQLite's integrity check, and every repository's refs and HEAD equal the manifest's.
5. With `--check`, starts a server on the restored directories, on 127.0.0.1 and a free port, with a one-off owner token and none of the shell's secrets or notification settings. It checks that `/api/version` answers and that each project has the items and events the manifest counted, to the same last event.

Record each rehearsal in `docs/2.0-log.md`: the date, the backup's key, the counts the check printed. Then remove the rehearsal directories.

### Restoring for real

If the Studio's data is lost or untrusted: restore as above into fresh directories on the Studio, as `atelierd`, beside the live ones. Before the next step, record the undo: stop the server's LaunchDaemon, and move the current `data/ENV` and `repos/ENV` aside to `data/ENV.before-restore-DATE` and `repos/ENV.before-restore-DATE` rather than deleting them. Then move the restored directories into place and start the server. Moving the two aside directories back undoes the restore. Work recorded after the backup was made (at most a day) is lost from the Ledger; commits pushed since are still in the developers' workspaces and are pushed again.

## What is tested

`test/backup.test.mjs` runs a real server, writes to it continuously while `cli/backup.mjs` backs it up in a separate process to a local S3-compatible stub, and restores with `cli/restore.mjs --check`. The stub verifies every request's SigV4 signature with a verifier of its own, which is itself checked against curl's `--aws-sigv4`. The test shows:

- the restored server answers with the same project record, every item and event the same as the source's up to the backup's moment, as many as the manifest counted, and the same Git refs and large objects;
- the object in the stub is not an archive, holds none of the data in the clear, and opens with the private key alone: another key, a changed byte or a truncated file fails;
- retention deleted only this environment's backup older than 30 days, and kept recent ones, an old-named one R2 says is recent, other prefixes, other names and the other environment's;
- no secret value (the R2 credentials, the private key, the owner token, the override secret) appears in either command's output, the manifest or the archive.

`setup-backup.sh` has been run only with `DRYRUN=1`; it has not run on the Studio.
