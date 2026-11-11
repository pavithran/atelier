# t705: page-count tests, red on main and green at the head

Command (both runs): run through the host slot wrapper as
`node load.mjs -- node --test cli/events.test.mjs`.

## On main (new tests, unchanged cli/commands/events.mjs)

```
✖ events --from reads one page when the time is inside page 1   (10 !== 1)
✖ events --from reads three pages when the time is inside page 3
✖ events --from equal to a page's oldest event reads the next page and keeps events at that time
ℹ pass 7
ℹ fail 3
```

The tests for "older than every event", "no --from" and "empty record" read every page
on main too, so they pass there; they guard against stopping too early.

## At the head

```
ℹ pass 10
ℹ fail 0
```

`npm run typecheck` passes. `test/escapes.test.mjs` passes unchanged; flow and escapes call
`collectEvents` without `from`, so they still read every page.
