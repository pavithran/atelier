import { createServer } from "node:http";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../../src/route-level.ts";

// One fake server for every runner route. RUNNER_ROUTES lists the routes
// src/tokens.ts runnerRoute accepts; the server answers each of them (throwing for
// anything else) and test/runner-server-routes.test.mjs fails when the two disagree,
// so a route added to runnerRoute breaks that one test, not every runner test.
// Paths below are relative to /api; ":project" and ":id" are single segments,
// "*" is any one trailing segment.
const ITEM = "projects/:project/items/:id";
export const RUNNER_ROUTES = [
  ["GET", "config"], ["POST", "queue"], ["POST", "runs"],
  ["GET", "projects/:project"],
  ["GET", "projects/:project/decisions"], ["GET", "projects/:project/baseline-head"], ["POST", "projects/:project/baseline-token"],
  ["GET", ITEM],
  ...["brief", "job-brief", "diff"].map((verb) => ["GET", `${ITEM}/${verb}`]),
  ...["sandbox", "logs", "diffs"].map((verb) => ["GET", `${ITEM}/${verb}/*`]),
  ...["claim", "read-token", "base-token", "push", "evidence", "sandbox", "submit", "plan", "release", "review-skip", "run-skip"].map((verb) => ["POST", `${ITEM}/${verb}`]),
  // A review runner's lease calls (cli/runner.mjs review jobs): agent routes, served the same way.
  ...["review-claim", "review-renew", "review-release", "review-unparsable"].map((verb) => ["POST", `${ITEM}/${verb}`]),
];

const SEGMENT = /^:|^\*$/;
function matches(template, parts) {
  const want = template.split("/");
  return want.length === parts.length && want.every((w, i) => SEGMENT.test(w) || w === parts[i]);
}
export function routeKey(method, parts) {
  const route = RUNNER_ROUTES.find(([m, template]) => m === method && matches(template, parts));
  if (!route) throw new Error(`Unexpected runner request: ${method} ${parts.join("/")}`);
  return `${route[0]} ${route[1]}`;
}

// What a route answers when the test says nothing: success with an empty-ish body.
const DEFAULTS = {
  "GET config": () => ({ ownerActor: "owner", ownerName: "Owner", runner: "home:studio", tokenId: "runner-token-id" }),
  "POST queue": () => ({ queue: [] }),
  "GET projects/:project": ({ project }) => ({ project: { name: project, policy: {} } }),
};

// answers: { "POST claim": (ctx) => [status, json] | json | value, ... }, keyed
// by the verb of an item route ("POST claim", "GET item") or by a full route
// template from RUNNER_ROUTES. A function receives { method, parts, body,
// project, id, verb }; a non-function is the 200 body. `requests` holds the
// item routes called, as "METHOD verb" ("GET item" for the bare item), in order.
export function serveRunner({ project = "demo", id = "t1", answers = {} } = {}) {
  const requests = [], all = [], log = [], errors = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      try {
        const path = new URL(req.url, "http://localhost").pathname;
        if (!path.startsWith("/api/")) throw new Error(`Unexpected runner request: ${req.method} ${path}`);
        const parts = path.slice(5).split("/");
        const body = text ? JSON.parse(text) : {};
        let status, json;
        if (req.method === "GET" && parts.join("/") === "version") [status, json] = [200, { commit: "0".repeat(40), routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }];
        else {
          const key = routeKey(req.method, parts);
          const isItem = key.includes(ITEM) && parts[1] === project && parts[3] === id;
          const verb = isItem ? parts[4] ?? "item" : undefined;
          all.push(`${req.method} ${parts.join("/")}`);
          log.push({ method: req.method, path: req.url, body: text });
          if (isItem) requests.push(`${req.method} ${verb}`);
          const answer = (isItem ? answers[`${req.method} ${verb}`] : undefined) ?? answers[key] ?? DEFAULTS[key];
          const value = typeof answer === "function" ? answer({ method: req.method, parts, body, project: parts[1] ?? project, id, verb }) : answer ?? {};
          [status, json] = Array.isArray(value) && typeof value[0] === "number" ? value : [200, value];
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      } catch (error) {
        errors.push(error);
        res.destroy(error);
      }
    });
  });
  return new Promise((ready) => server.listen(0, "127.0.0.1", () => ready({
    url: `http://127.0.0.1:${server.address().port}`, requests, all, log,
    close: () => new Promise((done, fail) => server.close(() => errors.length ? fail(new AggregateError(errors, errors.map((error) => error.message).join("; "))) : done())),
  })));
}

// The calls a test cares about happened in this order, other calls anywhere
// between or around them allowed.
export function subsequence(actual, expected) {
  let at = 0;
  for (const call of actual) if (call === expected[at]) at++;
  return at === expected.length;
}
