# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Pasletik/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Pasletik/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies the edits AI models write — unified
diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and
JSON text-editor tool calls — to a tree of text files, to one written
specification (SPEC.md, version 1). It finds the lines an edit names even when
the model drifted their whitespace or indentation, and it changes every file
or none.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file (standard input when absent or `-`). `--format`
takes `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default,
detected from the patch). `--check` reports without writing; `--strict`
matches lines exactly. Exit 0 writes the tree and lists what changed; exit 1
lists every failed edit and writes nothing; exit 2 is a usage, missing-patch,
format or parse error.

## Usage

A unified diff, applied to `greet.txt` (the `@@` line numbers are a hint, not
a requirement — the hunk is found by its lines):

    $ cat fix.patch
    --- a/greet.txt
    +++ b/greet.txt
    @@ -1,3 +1,3 @@
     hello
    -world
    +there
     !
    $ node main.ts fix.patch
    M greet.txt
    ok: 1 file

A SEARCH/REPLACE block, with the target path on the line before it:

    $ cat edit.txt
    app.py
    <<<<<<< SEARCH
    name = "old"
    =======
    name = "new"
    >>>>>>> REPLACE
    $ node main.ts edit.txt
    M app.py
    ok: 1 file

When an edit does not match, nothing is written and the exit code is 1:

    $ node main.ts bad.patch
    error: no-match app.py
    failed: 1 of 1 edits
    $ echo $?
    1

Exit codes: 0 — every edit applied and written; 1 — at least one edit failed
(each failure is listed, the tree is untouched); 2 — the command line, the
patch file, or the patch itself could not be read.

Node 22 and its standard library alone; nothing is installed before it runs.
Deterministic: the same check gives the same exit code, stdout and files every
run.

Entered for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
