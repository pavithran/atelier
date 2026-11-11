# t707: claude plugin test and validate as required checks

Command: `node --test test/checks.test.ts`, run through the host test slot.
"Main" here is src/checks.ts as it was before the fix (`git show HEAD~1:src/checks.ts`, the parent of 4b1f04f4), with the new tests in place.
Each accepted form is its own test, so each fails on its own.

## On main's src/checks.ts

```
✖ a required check may run claude plugin test
✖ a required check may run claude plugin test with arguments
✖ a required check may run claude plugin validate
✖ a required check may run claude plugin validate with arguments
✔ claude is still refused as running a paid model
✔ claude -p x is still refused as running a paid model
✔ claude plugin install x is still refused as running a paid model
✔ claude plugin is still refused as running a paid model
✔ claude test plugin is still refused as running a paid model
ℹ tests 16  ℹ pass 12  ℹ fail 4
```

The five refusal tests pass on main because they pin behaviour that must not change.

## At the head

```
✔ a required check may run claude plugin test
✔ a required check may run claude plugin test with arguments
✔ a required check may run claude plugin validate
✔ a required check may run claude plugin validate with arguments
✔ claude is still refused as running a paid model
✔ claude -p x is still refused as running a paid model
✔ claude plugin install x is still refused as running a paid model
✔ claude plugin is still refused as running a paid model
✔ claude test plugin is still refused as running a paid model
ℹ tests 16  ℹ pass 16  ℹ fail 0
```
