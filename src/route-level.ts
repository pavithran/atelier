// The server's route level, one integer the server and the CLI share by
// importing this module. GET /api/version reports it beside the deployed
// commit, and atelier land and the home runner refuse when the server's
// level is lower than this one, since the CLI may be calling a route the
// server does not have, or one whose meaning the server has changed. Raise
// it by one, and only then, when a change makes the CLI start calling a
// route the server did not have, or changes the meaning of an existing route
// the CLI relies on; a merge that changes neither changes nothing here,
// whatever commit it moves to. Two tasks that each raise it from one base
// merge cleanly to the number they share; atelier land, wherever the
// workspace's HEAD holds main — its own merge or a rerun of one resolved
// by hand — compares this file at the task's fork point, its head and
// main's head, and raises the merged level to main's plus the task's own
// raise, so each number keeps meaning one set of routes. 14: the
// landing-workflow routes, behind atelier land --workflow (t280). 15: items
// take a brief and acceptance criteria apart from the short title, and edit
// takes a title (t315). 16: a review names the binding of the acceptance
// criteria it judged and may name the request it claimed, the review claim
// gives both, and edit says what a change of criteria withdrew (t326).
// 17: the review-unparsable route, which the runner's review job calls to
// keep a reply no verdict could be read from on the task (t407).
// 18: the owner keeps dated notes under a pool model, atelier models note
// (t406).
// 19: a project that requires criteria refuses a task filed or cleared
// without them, and init takes --require-criteria (t397).
// Runner-scoped API credentials and revocable Git gateway (t444).
// 21: a runner reports a review it will not serve to review-skip, the
// queue's review tasks and the review request's answer name the request's
// number, and the landing counts skips by it (t353). 22: a runner token
// posts review-skip for a review job it was offered, under the job's actor,
// as the runner has done since runner tokens (t444); a server at 21 refused
// it, so a runner's skip never reached the landing (t353).
// 23: function areas, task assignments and the shared board snapshot (t456).
// 24: a project's policy carries its commit identity, which every claim,
// runner and landing reads, and init takes commitName, commitEmail,
// agentEmails, privateEmails and publicMirrors (t451).
// 25: the owner admits, withdraws and lists outside reviewers (PUT, DELETE
// and GET /projects/:p/reviewers), which an older server answers 404 (t492).

// 26: review-renew and five-minute leases; release and verdicts name the
// exact request generation, and expired requests are reoffered (t351).
export const ROUTE_LEVEL = 26;
