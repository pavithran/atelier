import type { CommandSpec } from "../command.ts";
const spec: CommandSpec = {
  name: "index",
  forms: [
    { group: "Developer", line: 8, slot: 60, form: "index export --file F", about: "Exports the server model pool, notes, cards, role assignments and run reports with counts and the source commit. Creates a private file (0600), never overwrites one, and redacts credentials. On 1.0, reads only existing routes and reports the history those routes cannot expose. Stop writers before exporting." },
    { group: "Developer", line: 8, slot: 70, form: "index import --file F", about: "Imports the server index after the project ledgers into 2.0, preserving carried ids and records. Requires the developer token. Repeating the import changes nothing; conflicting ids refuse every row in one transaction. Historical references to models outside the pool are kept." },
  ],
  flags: { file: "--file needs a path: --file index.json" },
  subcommands: { export: { takes: ["file"] }, import: { takes: ["file"], capabilities: ["index.transfer.v1"] } },
  help: { flags: { "--file F": "the index JSON file to create or import" }, example: "atelier index export --file index.json" },
};
export default spec;
