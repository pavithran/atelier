import { createServer } from "node:http";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../../src/route-level.ts";
import { RUNNER_ROUTES } from "../../src/tokens.ts";

const ITEM = "projects/:project/items/:id";
// Public version negotiation and agent-token review leases are also used by
// runners, but must not widen the runner-token authorization table.
export const AUXILIARY_ROUTES = [
  { method: "GET", pattern: "version" },
  ...["review-claim", "review-renew", "review-release", "review-unparsable"]
    .map(verb => ({ method: "POST", pattern: `${ITEM}/${verb}` })),
];
const SERVER_ROUTES = [...RUNNER_ROUTES, ...AUXILIARY_ROUTES];
const empty = () => ({});
// Explicit answers, deliberately independent of the authorization inventory:
// a new table entry must receive a handler here before the coverage guard passes.
const HANDLERS = {
  "GET version": () => ({ commit: "0".repeat(40), routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }),
  "GET config": () => ({ ownerActor: "owner", ownerName: "Owner", runner: "home:studio", tokenId: "runner-token-id" }),
  "GET runners/me": () => ({ runner: "home:studio", projects: ["demo"], expiresAt: null }),
  "POST queue": () => ({ queue: [] }),
  "POST runs": empty,
  "GET projects/:project": ({ project }) => ({ project: { name: project, policy: {} } }),
  "GET projects/:project/decisions": empty,
  "GET projects/:project/baseline-head": empty,
  "POST projects/:project/baseline-token": empty,
  [`GET ${ITEM}`]: empty,
  ...Object.fromEntries(["brief", "job-brief", "diff"].map(verb => [`GET ${ITEM}/${verb}`, empty])),
  ...Object.fromEntries(["logs", "diffs"].map(verb => [`GET ${ITEM}/${verb}/*`, empty])),
  ...Object.fromEntries(["claim", "read-token", "base-token", "push", "evidence", "submit", "plan", "release", "review-skip", "run-skip", "fast-take", "fast-ready",
    "review-claim", "review-renew", "review-release", "review-unparsable"].map(verb => [`POST ${ITEM}/${verb}`, empty])),
};

export function assertRunnerHandlers(routes = RUNNER_ROUTES) {
  for (const { method, pattern } of routes) {
    if (!Object.hasOwn(HANDLERS, `${method} ${pattern}`)) throw new Error(`Missing runner handler: ${method} ${pattern}`);
  }
}

export function routeKey(method, parts) {
  const route = SERVER_ROUTES.find(route => {
    const pattern = route.pattern.split("/");
    return route.method === method && pattern.length === parts.length && pattern.every((part, i) =>
      part === ":project" ? !!parts[i] : part === ":id" ? /^t[0-9]+$/.test(parts[i]) : part === "*" || part === parts[i]);
  });
  if (!route) throw new Error(`Unexpected runner request: ${method} ${parts.join("/")}`);
  return `${route.method} ${route.pattern}`;
}

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
        const key = routeKey(req.method, parts);
        const isItem = key.includes(ITEM) && parts[1] === project && parts[3] === id;
        const verb = isItem ? parts[4] ?? "item" : undefined;
        all.push(`${req.method} ${parts.join("/")}`);
        log.push({ method: req.method, path: req.url, body: text });
        if (isItem) requests.push(`${req.method} ${verb}`);
        const answer = (isItem ? answers[`${req.method} ${verb}`] : undefined) ?? answers[key] ?? HANDLERS[key];
        if (answer === undefined) throw new Error(`Missing runner handler: ${key}`);
        const value = typeof answer === "function" ? answer({ method: req.method, parts, body, project: parts[1] ?? project, id, verb }) : answer;
        const [status, json] = Array.isArray(value) && typeof value[0] === "number" ? value : [200, value];
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
