// atelier open. Its forms, flags and help are declared in src/usage/commands/open.ts.
import { spawnSync } from "node:child_process";
import { server } from "../atelier.mjs";

export default async function openCommand() {
  spawnSync("open", [`${server()}/home`]);
}
