// Puts the real clock back before the file's server closes. The three Today
// specs fake Date in beforeAll; test/support/workers.ts registers
// after(server.close) when it is imported, which is before a spec's own
// afterAll, so without this the server closes (waits on calls in flight and
// re-arms alarms) with Date still faked. Import this before workers.ts: node
// runs after hooks in the order they were registered.
import { after } from "node:test";
import { vi } from "./support/vitest.ts";

after(() => { vi.useRealTimers(); });
