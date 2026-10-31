# The Studio

How Atelier 2.0 runs on the Studio, the Mac that hosts the server. The design is `~/Documents/ai-project-data/atelier/design-branches-2026-10-28.md`, sections 4.1 to 4.11. What was built and when is in `docs/2.0-log.md`. The setup scripts in `scripts/studio/` say in their headers what each one makes.

## Layout

The service user `atelierd` owns everything the server writes. It has no password, no login shell and no admin rights. PAVI's user `pavi` is not in its group, so `pavi`, and every agent, can neither read nor change anything under `/Users/atelierd`.

| Path | Owner | Holds |
|---|---|---|
| `/Users/atelierd` | root, group atelierd, 750 | the home; the daemon enters it but cannot rename what is in it |
| `/Library/Atelier/lock` | root, wheel, 755 | the PID lock shared by setup, installs and rollbacks |
| `/Library/Atelier/install-server.sh` | root, wheel, 755 | the installer `atelier ship` runs; only `setup-server.sh` changes it |
| `/Users/atelierd/bin` | root, group atelierd | `node` and `cloudflared`, read-only to the daemon; each setup adds its own and keeps the rest |
| `/Users/atelierd/server` | root, group atelierd | staging's code, read-only to the daemon, with `COMMIT` |
| `/Users/atelierd/server-production` | root, group atelierd | production's code, the same way |
| `server.prev`, `server-production.prev` | root, group atelierd | the release before, kept for rollback |
| `server.failed` | root, group atelierd | a release that did not answer, until the next install |
| `/Users/atelierd/data/ENV` | atelierd, 700 | the Ledgers (`ledgers/*.sqlite`), `alarms.sqlite`, `git-grants.sqlite`, `large/` |
| `/Users/atelierd/repos/ENV` | atelierd, 700 | one bare repository per project, `KEY.git` |
| `/Users/atelierd/secrets/ENV` | atelierd, 700 | the server's settings, one file each: the owner token, the Access settings |
| `/Users/atelierd/secrets/tunnel` | atelierd, 700 | the tunnel's credential and config |
| `/Users/atelierd/secrets/backup` | atelierd, 700 | the R2 settings and the backup public key |
| `/Users/atelierd/backup-work` | atelierd, 700 | a backup while it is packed; empty otherwise |
| `/Users/atelierd/log` | atelierd, 700 | `staging.log`, `production.log`, `tunnel.log`, `backup-ENV.log` |

ENV is `staging` or `production`. Each environment has its own code, so a staging release never reaches production.

`COMMIT` holds the commit the release was built from. The server reports it at `/api/version`. A development checkout has no `COMMIT`, and reports its `git rev-parse HEAD`.

## The daemons

LaunchDaemons in `/Library/LaunchDaemons`, owned by root, each run as `atelierd`. They run with no one logged in, restart when they stop, and only an administrator can unload them.

| Daemon | Runs | Listens |
|---|---|---|
| `zone.atelier.server.staging` | `server/cli/serve.mjs --env staging` | 100.99.0.102:4101 |
| `zone.atelier.server` | `server-production/cli/serve.mjs --env production` (since 2026-10-31) | 100.99.0.102:4100 |
| `zone.atelier.tunnel` | `cloudflared tunnel run` | outbound to Cloudflare |
| `zone.atelier.backup.ENV` | the nightly backup, below | nothing |

Both servers share `bin/node` and the home. Everything else is per environment.

## macOS per-user services

If ship reports that `/Users/atelierd` is owned by `atelierd`, rerun the
reviewed server setup. It stops both the Atelier system jobs and the
`user/UID` launchd domain before requiring that no `atelierd` process
remains. It checks the home is a plain directory with an accepted owner,
no group or other writes, and no ACL, then restores `root:atelierd` mode
750 and installs the trusted node and release again. Ship refuses before
using node from that home; changing only the home's owner cannot establish
that its contents were preserved while it was writable by `atelierd`.

After reviewing and copying the setup pair into `/private/var/root` as
specified under Shipping a release, run this repair for production. Replace
`RELEASE.tar` and `NODE` with absolute paths to the trusted release archive
and Node binary; the token argument is the developer's output copy. For
staging, replace both occurrences of `production` with `staging`.

```sh
/usr/bin/sudo /bin/bash -p /private/var/root/setup-server.sh --env production RELEASE.tar NODE ~/.config/atelier/production-token
```

On 2026-10-31 the Studio ran `distnoted`, `lsd`, `cfprefsd`, `trustd`, `secd`
and `containermanagerd` as `atelierd`, with parent PID 1, after its first
HTTPS use. The HTTPS request may have triggered macOS's Security framework;
that trigger has not been established. `containermanagerd` created
`/Users/atelierd/Library` as `atelierd:atelierd` mode 700 and changed the
home's owner to `atelierd:atelierd`, leaving mode 750. These services belong
to the per-user launchd domain, independently of Atelier's system jobs.
Stopping only the system jobs therefore left processes running and blocked
setup. Later HTTPS use can start the services again.

If setup cannot stop an unrelated `atelierd` process before replacing code
or plists, recovery restarts the saved daemons without changing installed
files. After a replacement, recovery still requires all service-user
processes to stop before restoring files; a failed shutdown leaves the code
in place and reports the failure. It attempts to restart every saved
daemon from the files left in place in either case, skipping jobs already
loaded. A restart cannot succeed if the failed run left required files
missing; saved inputs remain available for repair.

## Shipping a release

Agents run as `pavi`, so nothing `pavi` can write is ever run as root or as `atelierd`. The release is built on the Studio, by root, from the Studio's own repository of the project, which only reviewed, landed commits reach.

Since the 2026-10-31 cut-over, `atelier ship`, run by PAVI in the registered checkout on the Mac, deploys main to production at `atelier.zone`. Staging at `next.atelier.zone` ships from the separate `atelier-trial` project. Main's deploy step is `node scripts/ship-studio.mjs deploy --env production --version-url https://atelier.zone/api/version --host ai-studio`:

1. It checks that the checkout is clean and at the commit ship captured.
2. It checks that the branch head production reports at `/api/version` holds that commit. After a landing it does.
3. It runs `/usr/bin/ssh -t -- ai-studio /usr/bin/sudo -- /Library/Atelier/install-server.sh --env production COMMIT`. sudo asks for the administrator password on the terminal. PAVI types it there. Nothing in Atelier reads it. On the Mac, ship uses absolute paths for sudo, ssh and the Command Line Tools Git. The remote command contains only fixed words, a validated environment and a 40-digit lowercase hexadecimal commit.

Server setup, tunnel setup and the installer use privileged Bash (`/bin/bash -p`), which ignores `BASH_ENV`, inherited functions and shell options. As root they discard the inherited environment (setup retains only `SUDO_USER`), set PATH, HOME to `/var/root`, umask 077 and the working directory to `/`. Service-user commands receive an empty environment with explicit HOME, PATH and locale. Health checks disable curl's configuration files. Server setup and the installer take the same PID lock at `/Library/Atelier/lock/install.lock`, under a root-owned directory writable only by root, for both environments. A second run refuses; a dead process's lock is reclaimed. The lock is released on exit, after recovery.

The installer, as root, then:

1. As `atelierd`, with no configuration but the repository's own and no hooks, checks that the commit is on the project's branch in `/Users/atelierd/repos/production/atelier.git`, and writes `git archive COMMIT`.
2. Checks the archive holds only plain files and directories inside itself, and extracts it into a fresh root-owned directory.
3. Fetches each runtime package the archived lock file installs, as `atelierd`, from the npm registry, and keeps it only if its SHA-512 is the lock file's `integrity`. No install script runs. This is `npm ci --ignore-scripts` for a lock file whose packages come from the registry; the Studio has no npm of root's own, and Homebrew's belongs to `pavi`.
4. Writes `COMMIT`.
5. Stops the daemon, moves `server-production` to `server-production.prev` and the new release into place, starts the daemon, and waits up to 60 seconds for `/api/version` to report the commit.
6. On a failure at any of these points it puts back what ran before: the new release moves to `server-production.failed`, `server-production.prev` comes back, and the daemon starts again. Every run first settles what an interrupted run left, including rollback moves through `server-production.swap`, then proceeds with the requested install or rollback even if the current release cannot answer. At exit it checks that the installed release answers, even if recovery failed. If it cannot start or answer, the installer prints `COULD NOT START` with the environment and log path.

The verify step then reads `https://atelier.zone/api/version` and passes only when its commit is the one shipped. With `--push` ship then scans and pushes main to GitHub.

The deploy runs only when the server's code changed since the commit live: `src/**`, `cli/serve.mjs`, `cli/private-guard.mjs`, `hooks/**`, `package.json` or `package-lock.json`. Otherwise it is skipped, with the verify step.

**Before the first ship** PAVI reviews `setup-server.sh` and `install-server.sh` together in the checkout. On the Studio, PAVI copies that reviewed pair into root's directory:

```
sudo /usr/bin/install -o root -g wheel -m 700 scripts/studio/setup-server.sh scripts/studio/install-server.sh /private/var/root/
sudo /bin/bash -p /private/var/root/setup-server.sh --env staging RELEASE.tar NODE ~/.config/atelier/staging-token
```

Give setup absolute paths for RELEASE.tar, NODE and OWNER_TOKEN_COPY; it changes directory to `/` before reading inputs. Use the command above with `-p` when invoking Bash explicitly. `DRYRUN=1` is available only without root.

Setup requires `/Library/Developer/CommandLineTools/usr/bin/git` and `llvm-otool`; the installer requires only that Git binary. Each tool and every parent must be root-owned, carry no ACL, and deny group and other writes; symlinks are refused. They never invoke the `/usr/bin` Xcode dispatch shims, and `DEVELOPER_DIR` is unset. If Command Line Tools are missing, PAVI installs them with:

```
/usr/bin/xcode-select --install
```

Over SSH, the installation needs the Mac’s screen. PAVI can also download the Command Line Tools package. Privileged scripts refuse root execution unless Bash reports privileged mode, and use fixed absolute system commands whose files are checked for root ownership. `SUDO_USER` must be a valid account name belonging to a real user; sudo receives `--` before the command.

Setup checks the copied node with `file` before reading its dependencies through the verified `llvm-otool`. It must be a Mach-O executable with a nonempty system-library list and no tool errors. Setup writes `ATELIER_GIT=/Library/Developer/CommandLineTools/usr/bin/git` into the daemon plist. Every server Git subprocess uses that absolute path. The backup daemon template supplies the same configuration for its snapshot subprocesses; existing backup plists need setup rerun before using the changed shared code. Without `ATELIER_GIT`, PATH lookup is allowed only for development: the effective uid must be nonzero and the OS account name must differ from `atelierd`. A configured relative path is refused. The backend and hook PATH contains only the Command Line Tools and system directories, with no Homebrew or `/usr/local/bin`. Repository hook wrappers execute the server’s absolute Node path. Tunnel setup also checks `file -b` before reading libraries; both library checks inspect all architectures, reject empty output and reject tool errors.

Setup refuses a source file or any parent that is a symlink, has an ACL, is writable by a group or others, or is owned by anyone but root. It installs the sibling `install-server.sh` at `/Library/Atelier/install-server.sh`; an installer in `RELEASE.tar` is ignored. This installs what the 2026-10-28 setup lacked. Updating the installer requires PAVI to review and copy the pair again and rerun setup from that protected directory. A ship cannot replace it.

Setup refuses unresolved `bin/node.old` or this environment's `server.old` before stopping jobs. It never treats the shared node backup as permission to delete the other environment's server. Recovery records the swap before moving code, stops all service jobs before restoring files, and checks `/api/version` after restarting the restored server. On a first installation failure it unloads the new daemon and removes the new server and plist, and restores the installer or removes it if none existed. Recovery attempts to restart other jobs even when restoring this environment fails; saved inputs remain available for repair. Archive extraction suppresses archived ownership, and setup strips ACLs from the staged server before installing it.

Since the 2026-10-31 cut-over, main's ship file names `--env production` and `https://atelier.zone/api/version`. The production installer works on `server-production`, `repos/production` and `zone.atelier.server`.

## Rolling back

On the Studio:

```
sudo /Library/Atelier/install-server.sh --env staging --rollback
```

It swaps `server` and `server.prev`, restarts the daemon, and waits for the previous commit at `/api/version`. If that does not answer, or a move fails, it swaps them back. A rollback can itself be rolled back by running it again. Use `--env production` for production.

## Reading the logs

The logs are `atelierd`'s, so reading them needs sudo:

```
sudo tail -n 100 /Users/atelierd/log/staging.log
sudo tail -n 100 /Users/atelierd/log/tunnel.log
```

Without sudo, `curl http://100.99.0.102:4101/api/version` shows whether staging answers and which commit it runs. `sudo launchctl print system/zone.atelier.server.staging` shows the daemon's state and environment.

## The tunnel and Access

`cloudflared`, run as `atelierd`, holds one tunnel, `atelier-studio`. It carries `next.atelier.zone` to staging at 100.99.0.102:4101. Since the 2026-10-31 cut-over it also carries `atelier.zone` to production at port 4100. Its credential is only in `secrets/tunnel`.

Cloudflare Access guards the owner pages. Staging uses the "atelier staging owner" application, production the "atelier owner" application. Each server checks the Access assertion itself, from `CF_ACCESS_ISS`, `CF_ACCESS_AUD` and `CF_ACCESS_OWNER_EMAIL` in its secrets, so a request over the tailnet gets no owner page either. `/api/*`, `/git/*` and `/live.js` stay outside Access; their bearer tokens are checked by the server.

Requests through the tunnel arrive on the tailnet listener. A Git remote is given by the request's Host: a request whose Host is `PUBLIC_ORIGIN`'s host, such as `next.atelier.zone`, is told the public remote, `https://next.atelier.zone/git/KEY.git`. Any other request is told the tailnet remote, `http://100.99.0.102:4101/git/KEY.git`. Both are the server's own, so a made-up Host only picks which one.

## Production cut-over procedure

The procedure for the 2026-10-31 cut-over, with PAVI's authorization:

1. `sudo /bin/bash -p /private/var/root/setup-server.sh --env production RELEASE.tar NODE ~/.config/atelier/production-token`, after reviewing and copying the pair as above. It stops every `atelierd` job (staging's server, the tunnel, the backups), checks nothing of `atelierd` runs, makes `server-production`, the production daemon on port 4100 and production's owner token, puts node into `bin/` beside `cloudflared`, and starts again every job that ran. On a failure it puts its code and plist back and starts them all.
2. `/usr/bin/sudo /bin/bash -p scripts/studio/setup-tunnel.sh --production CLOUDFLARED CREDENTIALS.json ACCESS_AUD`, with the "atelier owner" application's audience tag. It stops every `atelierd` job the same way, adds `atelier.zone` to the tunnel, writes production's Access settings, gives production the origin `https://atelier.zone`, and starts again every job that ran. It does not touch DNS.
3. Detach `atelier.zone` from the 1.0 Worker's custom domain, then point it at the tunnel: either run step 2 again with `--route-dns ORIGIN_CERT`, with a cloudflared origin certificate for the `atelier.zone` zone, or change the record by hand. Only `--route-dns` makes the script touch DNS.
4. Change the ship file to `--env production` and production's version URL.

## What needs PAVI's password

Every write as root, and nothing else:

- each setup script: `setup-server.sh`, `setup-tunnel.sh`, `setup-backup.sh`, `setup-restore.sh`;
- each deploy through `atelier ship`, at sudo's prompt in the terminal ship runs in;
- a rollback;
- reading the logs, and stopping or starting a daemon.

An agent can run the tests and read `/api/version`. It cannot install, roll back or change anything under `/Users/atelierd` or `/Library/Atelier`, and nothing it writes is run as root or as `atelierd`.

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

5. **The install**, on the Studio, after a release holding `cli/backup.mjs` is installed:

   ```
   sudo /usr/bin/install -o root -g wheel -m 700 scripts/studio/setup-backup.sh scripts/studio/zone.atelier.backup.plist.template /private/var/root/
   sudo /usr/bin/install -o root -g wheel -m 600 R2.env backup.pub /private/var/root/
   rm R2.env backup.pub
   sudo /bin/bash -p /private/var/root/setup-backup.sh staging /private/var/root/R2.env /private/var/root/backup.pub
   ```

   It requires root-owned inputs and parents without links, writable modes or ACLs, copies them once without following links, and refuses an identity. Then it stops every `atelierd` job (the servers, the tunnel and the backups), waits until no `atelierd` process runs, checks the directories again, installs the settings and recipient as `atelierd`'s and the LaunchDaemon from `scripts/studio/zone.atelier.backup.plist.template`, starts again the jobs that ran, and runs one backup at once, waiting up to 300 seconds for it to report its upload. Staging is down for those seconds. On any failure it puts back, under the same rules, the settings and the LaunchDaemon it found, and starts the jobs that ran. It prints no secret. Remove the developer-owned input copies immediately after installing them, as above; the script deletes nothing in a path PAVI's user controls. Run it again with `production` when production moves.

Review the script and template before copying them. The privileged scripts require a root-owned source path, clear the inherited environment, verify the Command Line Tools and daemon Node, and hold the shared `/Library/Atelier/lock/install.lock` through recovery. Pass absolute input paths because they change to `/`.

`DRYRUN=1 /bin/bash -p scripts/studio/setup-backup.sh staging "$PWD/R2.env" "$PWD/backup.pub"` prints what would change without root. Root discards `DRYRUN`.

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
   sudo /usr/bin/install -o root -g wheel -m 700 scripts/studio/setup-restore.sh /private/var/root/
   sudo /usr/bin/install -o root -g wheel -m 600 restore.tar /private/var/root/
   sudo /bin/bash -p /private/var/root/setup-restore.sh production /private/var/root/restore.tar
   ```

   It requires the archive and every parent to be root-owned, without links, writable modes or ACLs, then copies it once without following links and checks it: plain files and directories under `data/` and `repos/` only, every database through SQLite's integrity check, every project the index registers with its Ledger, every repository bare. It replaces each repository config with only `core.bare` and the installed environment’s `core.hooksPath`, and removes restored hooks, alternates, `info/` and `config.worktree`. Then it stops every `atelierd` job, waits until no `atelierd` process runs, and checks the four paths again (data and repos absent or plain directories, never links; both destinations absent, not even a dangling link). It records the undo before the next step: it prints how to undo, and moves the current `data/ENV` and `repos/ENV` aside to `ENV.before-restore-STAMP`, never deleting them. It installs the restored directories as `atelierd`'s and starts again the jobs that ran. Each move aside is recorded as it happens, so on a failure it undoes exactly the moves made, removing any partial copy first and moving nothing over a link or an existing path. If any undo step fails, for any reason, every `atelierd` job stays stopped and no start command is printed: it prints what the run placed and moved, what stands at each of the four paths (a link named as one), repair hints, and "repair these, then run setup-restore.sh again (or bootstrap by hand once all four are as they were)".

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

`test/setup-backup-hardening.test.mjs` exercises hostile startup environments, executable ownership, source custody, the shared PID lock and its cleanup, Node validation, input snapshots and the rendered backup plist against temporary files.

`setup-backup.sh` and `setup-restore.sh` have been run only with `DRYRUN=1`; neither has run on the Studio.

`test/ship-studio.test.mjs` runs `install-server.sh` for real, not as root, against a scratch home holding a bare repository, with stand-in `launchctl`, `lsof`, `curl`, `sudo` and `mv`. It shows that ship passes the installer the environment and the commit alone; that the installer builds the release from the repository with `COMMIT`, refuses a commit off the project's branch or an archive holding a link, and keeps runtime packages only when their SHA-512 matches the lock file; and that a failure at each point of the swap and of a rollback (each move, the daemon's start, the wait) puts back the release that ran. It also kills the installer after each stop, move and start of an install or rollback, then requests an invalid commit and checks that the installed service answers; overlaps two runs to check the lock; and checks environment clearing and curl configuration suppression. It also replaces a live release that cannot answer, through both rollback and a fresh install. These tests use fakes and run without root. `test/ship.test.mjs` runs `atelier ship` with main's ship file and a stand-in `ssh`. `test/setup-server.test.mjs` shows that staging's setup still makes the user, directories, token and server settings the 2026-10-28 script made (kept in `test/fixtures/studio/`), with absolute Git configuration in the daemon plist, that setup checks both source files and every parent for root ownership, permissions, symlinks and ACLs, installs only the sibling installer at `/Library/Atelier` and adds node to `bin/` without touching the rest, what production gets instead, and, through the scripts' own functions, that production's setup and tunnel step stop every `atelierd` job and start again those that ran, on a failure too. Additional setup tests cover macOS per-user domain shutdown, service-owned home repair and its ownership, mode, link and ACL refusals, the installer's documented repair command, recovery with an unrelated process still running before and after code changes, hostile `BASH_ENV`, environment scrubbing, script shims, empty or erroneous library listings, missing tools, unsafe lock parents, lock contention, shared leftover backups, failed backup moves, failed shutdown and failed recovery health checks. `test/version-commit.test.mjs` and `test/claim-branch.test.mjs` cover the commit at `/api/version` and the remote chosen by Host.

The per-user domain shutdown and recovery changes have been tested with stand-ins, not on the Studio.

`test/git-command.test.mjs` checks daemon Git selection and executes hook wrappers with no Node on PATH. The setup tests run the real trust checks against developer-owned temporary parents and script shims, check cleanup installation before lock acquisition, and simulate first production failures. Installer integration tests still substitute service operations as a non-root user; they now run tool validation and Mach-O Node validation. These tests establish local behavior, not a privileged Studio deployment. Socket-dependent HTTP, hook, registry and backup tests require the orchestrator’s unrestricted run.
