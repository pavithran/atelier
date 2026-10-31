import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { serverFetch } from "../cli/server-fetch.mjs";

test("move-host bypasses fetch's five-minute transport with Node HTTP for headers and body", async (t) => {
  const nativeFetch = globalThis.fetch;
  const requests = [];
  let hang = false;
  t.mock.method(http, "request", (url, options, respond) => {
    const req = new EventEmitter();
    req.chunks = [];
    req.write = (chunk) => { req.chunks.push(chunk); return true; };
    req.setTimeout = (ms) => { req.timeout = ms; return req; };
    req.destroy = (error) => { req.emit("error", error); };
    req.end = () => {
      if (hang) return;
      const res = new EventEmitter();
      res.statusCode = 200; res.rawHeaders = []; res.rawTrailers = [];
      res.resume = res.pause = () => {};
      respond(res);
      res.emit("data", Buffer.from("done"));
      res.emit("end");
    };
    requests.push({ url, options, req });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let init;
  t.mock.method(globalThis, "fetch", async (url, options) => { init = options; return {}; });
  const url = "https://studio.test/api/projects/p/move-host";
  for (const [input, method] of [[url, "GET"], [url + "/other", "POST"], [url.replace("move-host", "items"), "POST"]]) {
    await serverFetch(input, { method });
    assert.equal(init.dispatcher, undefined);
  }
  await serverFetch(url, { method: "POST" });
  assert.equal(typeof init.dispatcher?.dispatch, "function");
  let abort;
  const data = [];
  await new Promise((resolve, reject) => {
    init.dispatcher.dispatch({ origin: "http://studio.test", path: "/api/projects/p/move-host", method: "POST", headers: ["authorization", "Bearer dummy"] }, {
      onConnect: (cancel) => { abort = cancel; },
      onHeaders: () => true,
      onData: (chunk) => { data.push(chunk.toString()); return true; },
      onComplete: resolve, onError: reject,
    });
  });
  assert.equal(requests[0].req.timeout, 3_600_000, "the actual transport waits an hour for headers and body");
  assert.equal(requests[0].options.agent, false, "the long request has its own connection");
  assert.deepEqual(data, ["done"]);
  assert.equal(typeof abort, "function");
  const response = await nativeFetch("http://studio.test/api/projects/p/move-host", {
    method: "POST", body: '{"remote":"local"}', dispatcher: init.dispatcher,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "done");
  assert.equal(Buffer.concat(requests[1].req.chunks).toString(), '{"remote":"local"}');
  hang = true;
  const cancelled = new AbortController();
  const waiting = nativeFetch("http://studio.test/api/projects/p/move-host", {
    method: "POST", dispatcher: init.dispatcher, signal: cancelled.signal,
  });
  cancelled.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(waiting, { name: "TimeoutError" });
});
