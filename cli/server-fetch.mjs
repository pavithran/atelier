// fetch, after the event loop has caught up (t568). The CLI runs git and
// checks with spawnSync, which blocks the event loop; a request made in the
// same turn as the blocking call returns went out on a pooled keep-alive
// connection before Node had run either thing that retires it: fetch's own
// idle-expiry timer (which honours the server's Keep-Alive: timeout) and the
// FIN of a server that closed the connection meanwhile. The request then
// met a closed socket and failed with "fetch failed" (read ECONNRESET), exit
// 4. A Node server closes an idle connection 6 s after its last response, so
// a claim whose clone, config and ls-remote took longer, as under a
// landing's full test run, failed this way (test/git-credentials.test.mjs).
//
// One timer turn runs the overdue expiry timers; the immediate after it
// follows a poll of the sockets, which reads any FIN. Each costs about a
// millisecond, against a network round trip.
export async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}

// globalThis.fetch is read at the call, so a test that stubs it still sees
// every request.
export async function serverFetch(input, init) {
  await settle();
  return globalThis.fetch(input, init);
}
