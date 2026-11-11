# t697: the 8-character --head test, red on main and green at the head

Command (inside the host slot wrapper):

    node /Users/atelier-build/ai-projects/atelier-runner/cli/load.mjs -- node --test --test-name-pattern="short head that show prints" test/agent-commands.test.mjs

The stub server accepts only the task's full current head on POST /accept and
refuses any other with 409 stale_head, as the server does.

## On main (cli/commands/accept.mjs as of a5955d83, new test)

    ✖ 7 characters
    ✖ 8 characters (235.865ms)
    ✖ 39 characters
    AssertionError: atelier: stale_head: {"error":"stale_head"}
    1 !== 0
    ℹ pass 0, fail 4

main sends the 8 characters unchanged, so the stub refuses them.

## At the head

    ✔ 7 characters
    ✔ 8 characters (217.0415ms)
    ✔ 39 characters
    ℹ pass 4, fail 0
