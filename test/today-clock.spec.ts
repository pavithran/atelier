import "./today-clock.ts";
import { server } from "./support/workers.ts";
import { afterAll, beforeAll, expect, it, vi } from "./support/vitest.ts";

// The Today specs fake Date and the server's close must see the real one
// (t595). The probe replaces server.close, which workers.ts's after hook calls
// by property, to note whether Date was still faked, then closes as before.
const FAKE = Date.parse("2020-01-01T00:00:00Z");
let seenAtClose: number | null = null;
const close = server.close.bind(server);
server.close = async () => { seenAtClose = Date.now(); await close(); };

beforeAll(() => { vi.setSystemTime(new Date(FAKE)); });
it("fakes Date for the file's tests", () => { expect(Date.now()).toBeLessThan(FAKE + 60_000); });
afterAll(() => { vi.useRealTimers(); });
// Registered last, so it runs after the server closed.
afterAll(() => { expect(seenAtClose).not.toBeNull(); expect(seenAtClose!).toBeGreaterThan(FAKE + 86_400_000); });
