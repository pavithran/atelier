// The server's route level, one integer the server and the CLI share by
// importing this module. GET /api/version reports it beside the deployed
// commit, and atelier land refuses when the server's level is lower than
// this one, since the CLI may be calling a route the server does not have.
// Raise it by one, and only then, when a change makes the CLI start calling
// a route the server did not have; a merge that adds no route changes
// nothing here, whatever commit it moves to.
export const ROUTE_LEVEL = 2;
