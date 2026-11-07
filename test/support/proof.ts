// Fixtures that record an approval straight on the Ledger (addReview, no route)
// are setting a scene, not testing the proof an approval carries (t523). Their
// approvals get one passing test result at the head, as a reviewer's would.
// Only a call that names no route (`via`) and gives no `tests` key at all is
// filled: an approval through the review route, the CLI or the runner is judged
// as it comes, and a fixture that means to leave the proof out says
// `tests: undefined`.
import { Ledger } from "../../src/ledger.ts";

const original = Ledger.prototype.addReview;
let installed = false;

export function installDefaultProof(): void {
  if (installed) return;
  installed = true;
  Ledger.prototype.addReview = function (this: Ledger, r, origin, proved, via, offers) {
    if (via === undefined && r.approve && !("tests" in r)) r = { ...r, tests: [{ test: "npm test", head: r.head, result: "passed" }] };
    return original.call(this, r, origin, proved, via, offers);
  };
}
