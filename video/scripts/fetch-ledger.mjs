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
// The Models page's figures: speed, stalls and judged findings, and the AI
// Gateway view (whether its figures could be read).
writeFileSync(new URL("../.cache/api-reliability.json", import.meta.url), JSON.stringify(await get("/reliability")));
writeFileSync(new URL("../.cache/api-usage.json", import.meta.url), JSON.stringify({ ...(await get("/usage")), readAt: new Date().toISOString() }));
writeFileSync(new URL("../.cache/api-runs.json", import.meta.url), JSON.stringify(await get("/runs")));
// A story told after the cut-off (t324, 8 October 18:00 UTC), kept apart so
// that the film's counts stay as of the cut-off.
writeFileSync(new URL("../.cache/late-t324.json", import.meta.url), JSON.stringify(await get("/projects/atelier/items/t324")));
console.log(`fetched ${n} items`);
