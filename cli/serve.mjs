#!/usr/bin/env node
// atelier serve: the Atelier server on this machine (Atelier 2.0; design
// section 4.2). One process per environment:
//   node cli/serve.mjs --env production|staging --data DIR [--port N]
//     [--host ADDR] [--secrets DIR]
// --data holds the environment's Ledgers (created mode 700, every file
// mode 600). --secrets is a directory of one file per setting (ATELIER_TOKEN,
// OVERRIDE_SECRET, ...); the same names are read from the environment too.
// Ends cleanly on SIGTERM and SIGINT: calls in flight finish, then each
// database closes.
import { parseArgs } from "node:util";
import { startServer } from "../src/runtime/server.mjs";

const PORTS = { production: 4100, staging: 4101 };

const { values } = parseArgs({
  options: {
    env: { type: "string" }, data: { type: "string" }, port: { type: "string" },
    host: { type: "string", default: "0.0.0.0" }, secrets: { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
const usage = "usage: node cli/serve.mjs --env production|staging --data DIR [--port N] [--host ADDR] [--secrets DIR]";
if (values.help) { console.log(usage); process.exit(0); }
if (!values.env || !(values.env in PORTS) || !values.data) { console.error(usage); process.exit(2); }
const port = values.port === undefined ? PORTS[values.env] : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error(`--port is a port number, not ${values.port}`); process.exit(2); }

const server = await startServer({ env: values.env, dataDir: values.data, port, host: values.host, secretsDir: values.secrets });
console.log(`atelier ${values.env} listening on ${values.host}:${server.port}, data in ${values.data}`);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    console.log(`atelier ${values.env}: ${signal}, stopping`);
    await server.close();
    process.exit(0);
  });
}
