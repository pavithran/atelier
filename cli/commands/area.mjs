import { OWNER, P, args, call, die, project } from "../atelier.mjs";
import { COMMAND_USAGE } from "../help.mjs";

export default async function areaCommand() {
  const [, sub, idOrName, name] = args._;
  if (!["create", "rename"].includes(sub) && args.purpose !== undefined) die(`area ${sub} does not take --purpose`);
  const path = `${P(project())}/areas`;
  if (sub === "list" && args._.length === 2) {
    const areas = await call("GET", path);
    console.log(areas.map(a => `${a.id}  ${a.name}  ${a.purpose}`).join("\n") || "No areas. Tasks appear under Unsorted.");
  } else if (sub === "create" && idOrName && args._.length === 3 && typeof args.purpose === "string") {
    const area = await call("POST", path, { name: idOrName, purpose: args.purpose }, OWNER);
    console.log(`${area.id}  ${area.name}  ${area.purpose}`);
  } else if (sub === "rename" && idOrName && name && args._.length === 4) {
    const old = (await call("GET", path)).find(a => a.id === idOrName);
    if (!old) die(`unknown area ID: ${idOrName}`);
    const area = await call("POST", `${path}/${encodeURIComponent(idOrName)}`, { name, purpose: args.purpose ?? old.purpose }, OWNER);
    console.log(`${area.id}  ${area.name}  ${area.purpose}`);
  } else if (sub === "remove" && idOrName && args._.length === 3) {
    await call("DELETE", `${path}/${encodeURIComponent(idOrName)}`, {}, OWNER);
    console.log(`${idOrName} removed. Its tasks are now Unsorted.`);
  } else die(COMMAND_USAGE.area);
}

