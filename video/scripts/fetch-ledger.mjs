// Fetches every task of the atelier project, read-only, into .cache/items/.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { get } from "./atelier-api.mjs";
const dir = new URL("../.cache/items/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : JSON.parse(readFileSync(new URL("../.cache/ls.json", import.meta.url), "utf8")).map((x) => x.id);
let n = 0;
for (let i = 0; i < ids.length; i += 8) {
  await Promise.all(ids.slice(i, i + 8).map(async (id) => {
    const d = await get(`/projects/atelier/items/${id}`);
    for (const e of d.evidence ?? []) delete e.outputTail;
    delete d.policy; delete d.acceptancePolicy;
    writeFileSync(dir + id + ".json", JSON.stringify(d));
    n++;
  }));
}
writeFileSync(new URL("../.cache/plan-t197.json", import.meta.url), JSON.stringify(await get("/projects/atelier/items/t197/plan")));
writeFileSync(new URL("../.cache/models.json", import.meta.url), JSON.stringify(await get("/models")));
console.log(`fetched ${n} items`);
