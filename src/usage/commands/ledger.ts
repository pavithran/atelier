import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "ledger",
  // The Ledger's way back from a switch of the server (t342).
  capabilities: ["projects.ledger-backup.v1"],
  forms: [
    {
      group: "Developer", line: 8, slot: 10,
      form: "ledger bookmark [--project P]",
      about: "Records a point-in-time bookmark of the project's Ledger and of the index (which holds every project's registration, the tokens and the pool) and prints them with the id that restores them. Record one before a switch of the server.",
    },
    {
      group: "Developer", line: 8, slot: 20,
      form: "ledger restore --bookmark ID [--project P]",
      about: "Restores the project's Ledger and the index to a bookmark `atelier ledger bookmark` recorded, when each next starts; each is asked to restart at once. The index is every project's, so every project returns to that time for what the index holds. Records a bookmark that undoes the restore. A bookmark it did not record is refused.",
    },
    {
      group: "Developer", line: 8, slot: 30,
      form: "ledger dump [--file F] [--project P]",
      about: "Writes every table of the project's Ledger, not only its events, to a JSON file with the Ledger's schema version and the code that wrote it; `ledger-PROJECT-DATE.json` here unless `--file` names one, never over an existing file. Tokens appear only as their hashes, and a token pasted into text is replaced.",
    },
    {
      group: "Developer", line: 8, slot: 40,
      form: "ledger import --file F [--resume ID] [--project P]",
      about: "Loads a dump into the project's Ledger on this server, to rehearse a switch on production's rows or to move a project. A dump written by older code (1.0) is migrated to this server's schema as a start of this code would migrate it; a dump from newer code is refused, as are a Ledger that holds anything and a dump of another project. The rows stored are checked against each table's count and checksum in the dump before the import finishes. Registers the project when this server does not list it yet. An import that stops partway stays on the server: `--resume ID` sends the rest.",
    },
    {
      group: "Developer", line: 8, slot: 50,
      form: "ledger import --abort ID [--project P]",
      about: "Takes back an import that stopped partway: everything it loaded is deleted and every table it made or remade is as it was, so the Ledger is empty again and a new import may begin.",
    },
  ],
  flags: {
    bookmark: "--bookmark needs the id atelier ledger bookmark printed: --bookmark b1",
    file: "--file needs a path: --file ledger.json",
    resume: "--resume needs the id of the import that stopped: --resume 6f1c…",
    abort: "--abort needs the id of the import that stopped: --abort 6f1c…",
  },
  subcommands: {
    bookmark: { takes: [] },
    restore: { takes: ["bookmark"] },
    dump: { takes: ["file"] },
    import: { takes: ["file", "resume", "abort"] },
  },
  help: {
    flags: {
      "--bookmark ID": "with restore, the bookmark to restore, as atelier ledger bookmark printed it",
      "--file F": "with dump, the file to write; with import, the dump to load",
      "--resume ID": "with import, goes on with the import that stopped, sending only the rows it lacks",
      "--abort ID": "with import, takes back the import that stopped",
      "--project NAME": "the project; this checkout's or workspace's project unless given",
    },
    example: "atelier ledger bookmark --project demo",
  },
};

export default spec;
