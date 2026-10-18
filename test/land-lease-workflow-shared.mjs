// What the parts of land-lease-workflow.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.

export const cancelHeld = (f) => f.box.holding === "/api/projects/proj/landing-lease" && f.posts("/landing-lease").some((x) => x.body.cancel === true);
export const stillRunning = async (landing, ms = 500) => {
  let ended = false; landing.done.then(() => { ended = true; });
  await new Promise((ok) => setTimeout(ok, ms));
  return !ended;
};
