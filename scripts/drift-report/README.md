# Drift report

The step a drift watcher ends with, as one action: `actions/drift-report`, backed by `report.mjs`
here. The watcher decides what drifted and says so through three inputs, `issue`, `pr` and `close`;
the action does the reporting those ask for and nothing else.

| what | input | mechanics |
|---|---|---|
| an issue, once | `issue: true` | one open issue per label (or per exact title under the label with `issue-match: title`), found by reading every open issue under the label, every page; a second run comments the new body on it instead of opening another, or leaves it alone with `issue-refresh: none`, for a watcher that runs often |
| a pull request carrying files | `pr: true` | the files as the watcher left them, bytes and mode, are committed to `bot/<name>-<utc stamp>` and opened as one PR with the diff in its body (a diff that does not fit GitHub's 65,536-character body is cut, with a note; the Files changed tab has the whole of it); while that PR is open, a run with the same blobs and modes does nothing and a run with new ones pushes a commit to it and says so; every open PR is read, every page, and a fork's branch under the prefix is never ours |
| the all-clear | `close: true` | every open issue under the label (or title) is closed with a comment naming the run |

`issue` and `close` on one run is an error: a watcher cannot report drift under a label and clear
that label in the same breath. When a PR is opened, each open issue under the label gets one
comment with the PR's link (`issue-pointer`), so the issue says where its fix is.

"One open" holds only while runs of the same watcher do not overlap: two runs that both read an
empty list before either creates would each create, and nothing inside one run can see the other.
The caller serialises its runs with a `concurrency` group of its own and `cancel-in-progress:
false` (a cancelled run can leave a pushed branch without its PR); the example below has it, and
every dario watcher already carries one.

## Tokens

- `token` pushes the branch and opens the PR. It should be a fine-grained PAT with Contents and
  Pull requests on the repository (dario keeps one as `DARIO_DRIFT_BOT_PAT`): a PR opened, or a
  branch pushed, with the job's `GITHUB_TOKEN` starts no `pull_request` workflow, so CI and the
  review would never run on it. The push carries the token through `GIT_CONFIG_*` environment
  entries, never argv, and clears the checkout's persisted header first, so a checkout that kept the
  job token still pushes as the PAT.
- `issue-token` lists, comments on and closes issues. The default, the job token, is right: a PAT
  without Issues rights cannot comment, and the job token can whenever the job has `issues: write`.

Nothing here reads a secret from a file; both tokens arrive as inputs.

## The commit

The caller's checkout is left as the watcher had it: `pr-files` are staged in its index (that gives
the diff for the PR body and each file's blob and mode), nothing else is touched, no branch is
checked out and HEAD does not move. The commit is built in a temporary index that starts as the
parent (HEAD for a new PR, the open PR's tip for a refresh) and takes `pr-files` alone, each as the
blob and mode the caller's index recorded for it, then `commit-tree`, and is pushed by its sha. A
file the watcher left staged never reaches the branch, an unrelated change in the checkout, staged
or not, survives, a file an ignore rule matches is carried like any other, and a filesystem
without an executable bit cannot lose a mode (`git commit -- <paths>` reads modes back off the
filesystem; a second `git add` against an older branch refuses an ignored file it did not track).
`pr-files` are names, not patterns: git runs with literal pathspecs, so `data[1].json` means that
file and never `data1.json`. A depth-1 checkout is enough.

## A caller

```yaml
permissions:
  contents: write        # the bot branch
  issues: write          # the issue, the pointer comment, the close
  pull-requests: write   # the PR

# Runs of this watcher never overlap: that is what keeps the issue and the PR to one each.
concurrency:
  group: codex-drift-watch
  cancel-in-progress: false

steps:
  - uses: askalf/checkout-with-retry@<sha>
  - uses: actions/setup-node@<sha>
    with: { node-version: 22 }
  - id: check
    run: |
      # ... the watcher's own probe; it writes its verdict as outputs and leaves the
      # changed files in the checkout, here test/fixtures/codex-models.snapshot.json
  - uses: askalf/ci/actions/drift-report@<full sha of main>
    with:
      label: codex-drift
      issue: ${{ steps.check.outputs.issue == '1' }}
      issue-title: Codex drift detected
      issue-body-file: issue-body.md
      pr: ${{ steps.check.outputs.snapshot_drift == '1' }}
      pr-branch-prefix: bot/codex-models-
      pr-files: test/fixtures/codex-models.snapshot.json
      pr-title: "test(codex): model snapshot follows the account's list"
      pr-body-file: pr-body.md
      close: ${{ steps.check.outputs.exit_code == '0' }}
      token: ${{ secrets.DARIO_DRIFT_BOT_PAT || github.token }}
```

The job needs node 22 on PATH and, for `pr`, a checkout (HEAD is the base; depth 1 is enough).
Outputs: `issue-action` (created, refreshed, unchanged, none),
`issue-number`, `issue-url`, `pr-action` (created, refreshed, unchanged, none), `pr-number`,
`pr-url`, `pr-branch`, `closed`.

## The pin

A caller names one full commit sha of this repository's main, the same way `redline.yml` does, and a
change here reaches a repository only through a reviewed bump of that line. `pin.mjs --action <sha>
[note]` rewrites every `uses: askalf/ci/actions/drift-report@…` line in a workflow read on stdin.
The pin bump reads each caller's `.github/workflows` directory and moves every file that carries
such a pin, one commit per file, in the same `bot/redline-pin` pull request as the Redline pins.

## Tests

`report.test.mjs` drives `report()` with a fake `run` that answers as `gh` and `git` and records
every call: no network, no repository. It covers the input rules, each of the three shapes, the
one-open-PR rule (same content, new content, a fork's branch, a file absent on the branch), the
token on every call, that no token is ever an argument, the outputs file and the action pin. A
second section runs real `git` against a bare origin in a temp dir, with `gh` still faked: with a
staged change, an unstaged change and a staged new file left beside `pr-files`, a new PR and a
refresh each carry `pr-files` alone and leave all three in the checkout, on its own branch; a bot
branch older than the file's directory is refreshed, the same content again pushes nothing, an
executable the old branch never had arrives as 100755, and a mode-only change is carried.
