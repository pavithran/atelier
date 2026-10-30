// atelier index: transfer the server-wide index through developer routes.
import { readFileSync, writeFileSync } from "node:fs";
import { args, call, die, OWNER, apiToken } from "../atelier.mjs";
import { MODEL_PROFILES } from "../../src/models/registry.ts";
import { validateIndex } from "../../src/index-transfer.ts";
import { collectIndex, safeIndex } from "../index-transfer.mjs";

export default async function indexCommand() {
  const sub = args._[1];
  if (!["export", "import"].includes(sub) || args._.length !== 2 || typeof args.file !== "string" || !args.file) die("atelier index export|import --file F");
  if (sub === "export") {
    const dump = safeIndex(await collectIndex((path) => call("GET", path, undefined, OWNER), MODEL_PROFILES.map((m) => m.id)), [apiToken()]);
    validateIndex(dump);
    try { writeFileSync(args.file, JSON.stringify(dump, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { die(`${args.file}: ${error.message}`); }
    console.log(`Index exported to ${args.file}: ${Object.entries(dump.counts).map(([t, n]) => `${n} ${t}`).join(", ")}.`);
    for (const gap of dump.limitations) console.log(`Not carried: ${gap}`);
    return;
  }
  let dump;
  try { dump = validateIndex(JSON.parse(readFileSync(args.file, "utf8"))); }
  catch (error) { die(`${args.file}: ${error.message}`); }
  const result = await call("POST", "/index/import", { dump }, OWNER);
  console.log(result.added ? `Index imported: ${result.added} rows added, ${result.held} already present.` : `Index unchanged: ${result.held} rows already present; nothing imported.`);
  if (result.unreached?.length) console.log(`Could not update project pool or assignments: ${result.unreached.join(", ")}; retry the import.`);
  for (const gap of dump.limitations) console.log(`Not carried: ${gap}`);
}
