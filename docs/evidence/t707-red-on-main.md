# t707: claude plugin test and validate as required checks

Command: `node test/checks.test.ts` via `node --test test/checks.test.ts`, in the host test slot.

## On main's src/checks.ts (the new tests, fix removed)

```
✖ a required check may run claude plugin test and claude plugin validate
  AssertionError: claude plugin test
  + actual: 'runs a paid model (claude plugin test)'
  - expected: null
✔ every other claude form is still refused as running a paid model
ℹ tests 9  ℹ pass 8  ℹ fail 1
```

The refusal test passes on main because it pins behaviour that must not change.

## At the head

```
✔ a required check may run claude plugin test and claude plugin validate
✔ every other claude form is still refused as running a paid model
ℹ tests 9  ℹ pass 9  ℹ fail 0
```

`npm run typecheck` (`tsc -p . && tsc -p test`) passes.
