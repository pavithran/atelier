// A file whose tests pass and which leaves a timer running: the guard must
// still kill it once its grace after the tests has passed.
import { test } from "node:test";

test("passes and leaves a handle", () => {
  setInterval(() => {}, 1000);
});
