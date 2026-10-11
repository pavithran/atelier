import { startVitest } from "vitest/node";
await startVitest("test", [], {
  watch: false,
  include: ["test/fixtures/design/capture.ts"]
});
