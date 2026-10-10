import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "login",
  forms: [
    {
      group: "Setup", line: 1, slot: 10,
      form: "login --server URL",
      about: "Stores this server's address and the owner's token, asking for the token when none is stored for it. A token the server refuses is not stored.",
    },
    {
      group: "Setup", line: 1, slot: 20,
      form: "login --store",
      about: "Names the token store in use and whether it holds a token. It never prints the token.",
    },
  ],
  flags: { server: false, store: true },
  help: {
    flags: {
      "--server URL": "the server, as https://HOST; plain http only for a server on this machine",
      "--store": "names the token store in use and whether it holds a token",
    },
    example: "atelier login --server https://atelier.zone",
  },
};

export default spec;
