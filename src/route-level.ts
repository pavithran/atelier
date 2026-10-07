// The server's route level, one integer the server and the CLI share by
// importing this module. GET /api/version reports it beside the deployed
// commit, and atelier land and the home runner refuse when the server's
// level is lower than this one, since the CLI may be calling a route the
// server does not have, or one whose meaning the server has changed. Raise
// it by one, and only then, when a change makes the CLI start calling a
// route the server did not have, or changes the meaning of an existing route
// the CLI relies on; a merge that changes neither changes nothing here,
// whatever commit it moves to.
export const ROUTE_LEVEL = 6;
