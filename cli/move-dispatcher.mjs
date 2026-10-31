// Fetch accepts the undici Dispatcher contract without an undici import.
// Use Node's HTTP clients for the long, silent move: their socket timeout is
// explicitly one hour, independent of fetch's default five-minute limits.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const MOVE_TIMEOUT_MS = 60 * 60_000;
export const moveDispatcher = {
  dispatch(options, handler) {
    const url = new URL(options.path, options.origin);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let finished = false, response;
    // Node 24 uses the legacy handler; newer bundled undici uses a
    // controller. Both drive the same HTTP request and response stream.
    const modern = typeof handler.onRequestStart === "function";
    const controller = {
      aborted: false, paused: false, reason: undefined,
      abort(reason) { this.aborted = true; this.reason = reason; req.destroy(reason); },
      pause() { this.paused = true; response?.pause(); },
      resume() { this.paused = false; response?.resume(); },
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      if (modern) handler.onResponseError(controller, error);
      else handler.onError(error);
    };
    const req = request(url, { method: options.method, headers: options.headers, agent: false }, (res) => {
      response = res;
      res.on("error", fail);
      controller.rawHeaders = res.rawHeaders;
      if (modern) handler.onResponseStart(controller, res.statusCode, res.headers, res.statusMessage);
      else if (handler.onHeaders(res.statusCode, res.rawHeaders, () => res.resume(), res.statusMessage) === false) res.pause();
      res.on("data", (chunk) => {
        if (modern) handler.onResponseData(controller, chunk);
        else if (handler.onData(chunk) === false) res.pause();
      });
      res.on("end", () => {
        if (finished) return;
        finished = true;
        controller.rawTrailers = res.rawTrailers;
        if (modern) handler.onResponseEnd(controller, res.trailers);
        else handler.onComplete(res.rawTrailers);
      });
    });
    req.on("error", fail);
    req.setTimeout(MOVE_TIMEOUT_MS, () => req.destroy(new DOMException("Move transport timed out", "TimeoutError")));
    if (modern) handler.onRequestStart(controller, null);
    else handler.onConnect((error) => controller.abort(error));
    // Fetch supplies its encoded body as an async iterable. Respect socket
    // backpressure while sending it, and let abort destroy that same request.
    (async () => {
      try {
        if (options.body) {
          for await (const chunk of options.body) {
            if (!req.write(chunk)) await new Promise((resolve, reject) => {
              const cleanup = () => { req.off("drain", drained); req.off("error", failed); };
              const drained = () => { cleanup(); resolve(); };
              const failed = (error) => { cleanup(); reject(error); };
              req.once("drain", drained).once("error", failed);
            });
          }
        }
        req.end();
      } catch (error) { req.destroy(error); }
    })();
    return true;
  },
};
